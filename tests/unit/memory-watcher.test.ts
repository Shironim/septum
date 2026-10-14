import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchBudget, WorkspaceWatcher } from '../../src/mcp/workspace-watcher.ts';
import { SerialWorkQueue } from '../../src/core/resources/work-queue.ts';
import { ConfigLoader } from '../../src/core/config/loader.ts';
import { SeptumDatabase } from '../../src/core/database/client.ts';
import { SeptumRepository } from '../../src/core/database/repository.ts';
import { IngestionPipeline } from '../../src/core/ingestion/pipeline.ts';

describe('bounded workspace watchers',()=>{
 async function fixture(limit=2048) {
  const root=mkdtempSync(join(tmpdir(),'septum-watch-test-'));mkdirSync(join(root,'src'));writeFileSync(join(root,'package.json'),'{"name":"watch-fixture"}');
  const db=new SeptumDatabase(':memory:'),repo=new SeptumRepository(db.raw),pipeline=new IngestionPipeline(repo,root);
  const c=ConfigLoader.getDefaultConfig();c.domains={src:{root:'src',allowed_dependencies:[],forbidden_dependencies:[],archetypes:{}}};
  const budget=new WatchBudget(limit);const ready=pipeline.run(c).then(()=>{});const queue=new SerialWorkQueue();
  const watcher=new WorkspaceWatcher(root,repo,pipeline,ready,queue,budget,()=>c);
  return {root,repo,pipeline,budget,watcher,close:async()=>{await watcher.close();db.close();rmSync(root,{recursive:true,force:true});}};
 }
 it('never registers ignored directories or symlink loops',async()=>{
  const f=await fixture();try{mkdirSync(join(f.root,'node_modules'));for(let i=0;i<300;i++)mkdirSync(join(f.root,'node_modules',String(i)));symlinkSync(f.root,join(f.root,'src','loop'));await Bun.sleep(450);await f.watcher.flush();expect(f.budget.count).toBe(2);expect(f.watcher.mode).toBe('native');}finally{await f.close();}expect(f.budget.count).toBe(0);
 });
 it('closes partial registrations and uses polling on watch limit',async()=>{
  const f=await fixture(1);try{expect(f.watcher.mode).toBe('polling');expect(f.budget.count).toBe(0);writeFileSync(join(f.root,'src','a.ts'),'export function changed() {}');await f.watcher.flush(true);expect(f.repo.getFileByPath('src/a.ts')).not.toBeNull();}finally{await f.close();}
 });
 it('bounds pending paths and falls back to a single reconciliation',async()=>{
  const f=await fixture();try{for(let i=0;i<1200;i++)f.watcher.notify(`src/a${i}.ts`);expect(f.watcher.pendingCount).toBeLessThanOrEqual(1000);await f.watcher.flush();expect(f.watcher.pendingCount).toBe(0);}finally{await f.close();}
 });
 it('verifies same-size same-mtime edits in polling before tool results',async()=>{
  const f=await fixture(1);try{const file=join(f.root,'src','a.ts');writeFileSync(file,'export function before() {}');await f.watcher.flush(true);const fs=await import('node:fs');const stat=fs.statSync(file);writeFileSync(file,'export function after_() {}');fs.utimesSync(file,stat.atime,stat.mtime);await f.watcher.flush(true);expect(f.repo.getSymbolsByFileId(f.repo.getFileByPath('src/a.ts')!.id).some(s=>s.name==='after_')).toBe(true);}finally{await f.close();}
 });
});
