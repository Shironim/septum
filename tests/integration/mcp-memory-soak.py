"""30-minute bounded-memory soak of source and compiled MCP servers on Linux.

Run: python3 tests/integration/mcp-memory-soak.py --duration 1800
No forced GC. A shorter --duration is a smoke probe, not release soak evidence.
"""
import argparse, json, os, pathlib, selectors, statistics, subprocess, tempfile, time
REPO=pathlib.Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--duration',type=int,default=1800);parser.add_argument('--output',default='/tmp/septum-memory-soak');args=parser.parse_args()
output=pathlib.Path(args.output);output.mkdir(parents=True,exist_ok=True)
def source(ext, revision=0):
 if ext=='py':return '\n'.join(f'def fn{i}(x):\n    if x > 0:\n        return x + {revision}\n    return 0\n' for i in range(15))
 if ext=='php':return '<?php\n'+'\n'.join(f'function fn{i}($x) {{ if ($x > 0) return $x + {revision}; return 0; }}' for i in range(15))
 if ext=='go':return 'package fixture\n'+'\n'.join(f'func Fn{i}(x int) int {{ if x > 0 {{ return x + {revision} }}; return 0 }}' for i in range(15))
 content='\n'.join(f'export function fn{i}(x:number) {{ if(x>0) return x+{revision}; return 0; }}' for i in range(15))
 return '<script lang="ts">\n'+content+'\n</script>' if ext=='vue' else content
class Server:
 def __init__(self, name, command, root):
  self.name=name;self.serial=0;self.samples=[];self.log=open(output/f'{name}.stderr.log','w');env=dict(os.environ,SEPTUM_MEMORY_DIAGNOSTICS='1');env.pop('SEPTUM_WORKSPACE_ROOT',None);env.pop('WORKSPACE_ROOT',None)
  self.p=subprocess.Popen(command,cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True,env=env);self.sel=selectors.DefaultSelector();self.sel.register(self.p.stdout,selectors.EVENT_READ)
  self.request('initialize',dict(protocolVersion='2024-11-05',capabilities={},clientInfo=dict(name='memory-soak',version='1')))
 def request(self,method,params):
  self.serial+=1;self.p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=self.serial,method=method,params=params))+'\n');self.p.stdin.flush()
  if not self.sel.select(30):raise AssertionError(f'{self.name} request timeout')
  result=json.loads(self.p.stdout.readline());assert 'error' not in result and not result.get('result',{}).get('isError'),result
  return result['result']
 def catalog(self,root):return self.request('tools/call',dict(name='septum_get_domain_catalog',arguments=dict(workspace_path=str(root))))
 def sample(self,elapsed):
  status=pathlib.Path(f'/proc/{self.p.pid}/status').read_text();rss=int(next(x.split()[1] for x in status.splitlines() if x.startswith('VmRSS:')))*1024
  fds=list(pathlib.Path(f'/proc/{self.p.pid}/fd').iterdir());watches=0
  for fd in pathlib.Path(f'/proc/{self.p.pid}/fdinfo').iterdir():
   try:watches+=sum(x.startswith('inotify wd:') for x in fd.read_text().splitlines())
   except FileNotFoundError:pass
  record=dict(seconds=round(elapsed,2),rss=rss,fds=len(fds),watches=watches);self.samples.append(record)
  with open(output/f'{self.name}.samples.jsonl','a') as data:data.write(json.dumps(record)+'\n')
  assert rss<512*1024*1024,record;assert watches<=2048,record;assert len(fds)<=50,record
 def close(self):
  try:
   if self.p.poll() is None:self.p.stdin.close();self.p.stdin=None;self.p.wait(timeout=6)
   assert self.p.returncode==0,(self.name,self.p.returncode)
  finally:
   if self.p.poll() is None:self.p.terminate();self.p.wait(timeout=6)
   self.sel.close();self.log.close()
 def report(self):
  early=[s['rss'] for s in self.samples if 300<=s['seconds']<=600];late=[s['rss'] for s in self.samples if 1500<=s['seconds']<=1800]
  report=dict(server=self.name,duration=args.duration,requests=self.serial,max_rss=max(s['rss'] for s in self.samples),max_fds=max(s['fds'] for s in self.samples),max_watches=max(s['watches'] for s in self.samples),full_soak=args.duration>=1800)
  if report['full_soak']:
   report['median_growth']=statistics.median(late)-statistics.median(early);assert report['median_growth']<=20*1024*1024,report
  (output/f'{self.name}.summary.json').write_text(json.dumps(report,indent=2));return report
with tempfile.TemporaryDirectory(prefix='septum-soak-fixture-') as temp:
 parent=pathlib.Path(temp);roots=[];exts=['ts','php','py','go','vue']
 for i in range(21):
  root=parent/str(i);(root/'src').mkdir(parents=True);(root/'package.json').write_text('{"name":"soak-fixture"}')
  for j in range(500 if i==0 else 5):(root/'src'/f'f{j}.{exts[j%5]}').write_text(source(exts[j%5]))
  roots.append(root)
 ignored=roots[0]/'node_modules';ignored.mkdir()
 for i in range(6000):(ignored/str(i)).mkdir()
 servers=[]
 try:
  for name,cmd in [('source',['bun','run',str(REPO/'bin/septum.ts'),'serve']),('compiled',[str(REPO/'dist/septum'),'serve'])]:
   server=Server(name,cmd,roots[0]);servers.append(server);server.catalog(roots[0]);server.sample(0)
  started=time.monotonic();next_sample=5;next_log=60;last_action=0;iteration=0
  while (elapsed:=time.monotonic()-started)<args.duration:
   phase=elapsed/args.duration
   if phase>=1/6 and elapsed-last_action>=2:
    target=roots[0] if phase<2/3 else roots[iteration%21]
    if 1/3<=phase<2/3:
     ext=exts[iteration%5];(roots[0]/'src'/f'f{iteration%5}.{ext}').write_text(source(ext,iteration%7))
    for server in servers:server.catalog(target)
    iteration+=1;last_action=elapsed
   if elapsed>=next_sample:
    for server in servers:server.sample(elapsed)
    next_sample=elapsed+5
   if elapsed>=next_log:
    print(json.dumps(dict(seconds=round(elapsed),servers={s.name:s.samples[-1] for s in servers})),flush=True);next_log=elapsed+60
   time.sleep(.1)
  for server in servers:server.sample(args.duration)
 finally:
  for server in servers:server.close()
 for server in servers:print(json.dumps(server.report()),flush=True)
