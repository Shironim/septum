import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeptumDatabase } from '../../src/core/database/client.ts';
import { SeptumRepository } from '../../src/core/database/repository.ts';
import { ConfigLoader } from '../../src/core/config/loader.ts';
import { IngestionPipeline } from '../../src/core/ingestion/pipeline.ts';
import { BoundaryEvaluator } from '../../src/core/boundary/evaluator.ts';
import { ModuleResolver } from '../../src/core/resolver/module-resolver.ts';
import { handleCheckBoundary } from '../../src/mcp/tools/check-boundary.ts';

describe('bounded ingestion and incomplete index safety', () => {
 let root:string, db:SeptumDatabase, repo:SeptumRepository, pipeline:IngestionPipeline;
 beforeEach(() => { root=mkdtempSync(join(tmpdir(),'septum-memory-test-')); mkdirSync(join(root,'src')); db=new SeptumDatabase(':memory:'); repo=new SeptumRepository(db.raw); pipeline=new IngestionPipeline(repo,root); });
 afterEach(() => { db.close(); rmSync(root,{recursive:true,force:true}); });
 function config() { const c=ConfigLoader.getDefaultConfig(); c.domains={src:{root:'src',allowed_dependencies:[],forbidden_dependencies:[],archetypes:{}}};return c; }
 it('removes stale oversized symbols and recovers after shrinking',async()=>{
  const file=join(root,'src/a.ts'); writeFileSync(file,'export function oldName() {}'); await pipeline.run(config());
  writeFileSync(file,'/*'+'x'.repeat(2*1024*1024)+'*/\nexport function tooBig() {}'); await pipeline.run(config());
  expect(repo.getFileByPath('src/a.ts')).toBeNull();
  const skipped=JSON.parse(repo.getMeta('skipped_files')||'[]'); expect(skipped).toEqual([{path:'src/a.ts',reason:'file_too_large'}]);
  const evaluator=new BoundaryEvaluator(repo,new ModuleResolver(root,repo));
  const result=await handleCheckBoundary(evaluator,config(),{file_path:'src/a.ts'},repo,root); expect(JSON.parse(result.content[0].text).status).toBe('unknown');
  writeFileSync(file,'export function recovered() {}'); await pipeline.ingestFile(file,config());
  expect(repo.getFileByPath('src/a.ts')).not.toBeNull(); expect(JSON.parse(repo.getMeta('skipped_files')||'[]')).toEqual([]);
 });
 it('does not approve an index whose sync failed',async()=>{
  repo.setMeta('sync_state','error');
  const result=await handleCheckBoundary(new BoundaryEvaluator(repo,new ModuleResolver(root,repo)),config(),{scope:'all'},repo,root);
  expect(JSON.parse(result.content[0].text).status).toBe('unknown');
 });
 it('rejects recovered syntax trees and restores a reliable index after repair',async()=>{
  const file=join(root,'src/a.ts');
  writeFileSync(file,'export function valid() {}');
  await pipeline.run(config());
  writeFileSync(file,'export function valid() {}\nfunction broken( {');
  await expect(pipeline.run(config(),{verifyContent:true})).rejects.toThrow('parser is degraded');
  expect(repo.getMeta('sync_state')).toBe('error');
  const evaluator=new BoundaryEvaluator(repo,new ModuleResolver(root,repo));
  const result=await handleCheckBoundary(evaluator,config(),{scope:'all'},repo,root);
  expect(JSON.parse(result.content[0].text).status).toBe('unknown');
  writeFileSync(file,'export function repaired() {}');
  await pipeline.run(config(),{verifyContent:true});
  expect(repo.getMeta('sync_state')).toBe('complete');
  expect(repo.getAllSymbolsWithFiles().some(s=>s.name==='repaired')).toBe(true);
 });
 it('reparses unchanged source when the parser revision changes',async()=>{
  const file=join(root,'src/a.rs');
  writeFileSync(file,'mod billing { pub struct Invoice; }');
  await pipeline.run(config());
  const indexed=repo.getFileByPath('src/a.rs')!;
  repo.replaceFileSymbols(indexed.id,[]);
  repo.setMeta('parser_revision','3');
  const result=await pipeline.run(config());
  expect(result.files_updated).toBe(1);
  expect(repo.getSymbolsByFileId(indexed.id).some(s=>s.name==='billing::Invoice')).toBe(true);
  expect(repo.getMeta('parser_revision')).toBe('4');
 });
 it('marks completion and does not replace slices on unchanged sync',async()=>{
  writeFileSync(join(root,'src/a.ts'),'export function example() {}'); await pipeline.run(config());
  repo.setMeta('slices_dirty',''); const before=repo.getMeta('semantic_revision');
  let calls=0; const original=repo.clearVerticalSlices.bind(repo); repo.clearVerticalSlices=()=>{calls++;original();};
  await pipeline.run(config(),{verifyContent:true});
  expect(calls).toBe(0); expect(repo.getMeta('sync_state')).toBe('complete'); expect(repo.getMeta('semantic_revision')).toBe(before);
 });
 it('commits bounded batches and records failure without approving partial state',async()=>{
  for(let i=0;i<121;i++) writeFileSync(join(root,`src/f${i.toString().padStart(3,'0')}.ts`),`export function f${i}() {}`);
  let current=0,max=0; const tx=repo.runInTransaction.bind(repo),upsert=repo.upsertFile.bind(repo);
  repo.runInTransaction=(fn:any)=>tx(()=>{current=0;const value=fn();max=Math.max(max,current);return value;});
  repo.upsertFile=((...args:any[])=>{current++;return (upsert as any)(...args);}) as any;
  await pipeline.run(config()); expect(max).toBeLessThanOrEqual(50); expect(repo.getAllFiles().length).toBe(121);
 });
});

describe('source read admission',()=>{
 it('does not read oversized semantic files outside indexed domains',async()=>{
  const root=mkdtempSync(join(tmpdir(),'septum-semantic-limit-'));mkdirSync(join(root,'src/mcp/tools'),{recursive:true});mkdirSync(join(root,'other'));
  const db=new SeptumDatabase(':memory:'),repo=new SeptumRepository(db.raw);
  try{writeFileSync(join(root,'package.json'),'{"name":"semantic-limit","dependencies":{"@modelcontextprotocol/sdk":"1"}}');writeFileSync(join(root,'src/mcp/tools/big.ts'),'/*'+'x'.repeat(2*1024*1024)+'*/\nexport function handler() {}');const c=ConfigLoader.getDefaultConfig();c.domains={other:{root:'other',allowed_dependencies:[],forbidden_dependencies:[],archetypes:{}}};const pipeline=new IngestionPipeline(repo,root);await expect(pipeline.run(c)).rejects.toThrow("Semantic extraction incomplete");expect(JSON.parse(repo.getMeta('skipped_files')||'[]').some((file:any)=>file.path==='src/mcp/tools/big.ts')).toBe(true);await expect(pipeline.run(c)).rejects.toThrow("Semantic extraction incomplete");expect(JSON.parse(repo.getMeta('skipped_files')||'[]').some((file:any)=>file.path==='src/mcp/tools/big.ts')).toBe(true);}finally{db.close();rmSync(root,{recursive:true,force:true});}
 });
 it('records an error when a later parse fails after committing the first batch',async()=>{
  const root=mkdtempSync(join(tmpdir(),'septum-batch-error-'));mkdirSync(join(root,'src'));const db=new SeptumDatabase(':memory:'),repo=new SeptumRepository(db.raw);
  try{for(let i=0;i<70;i++)writeFileSync(join(root,`src/${String(i).padStart(2,'0')}.ts`),'export function okay() {}');const c=ConfigLoader.getDefaultConfig();c.domains={src:{root:'src',allowed_dependencies:[],forbidden_dependencies:[],archetypes:{}}};const pipeline=new IngestionPipeline(repo,root);let count=0;const engine=(pipeline as any).parserEngine,parse=engine.parseFile.bind(engine);engine.parseFile=(...args:any[])=>{if(++count===60)throw new Error('parse failure');return parse(...args);};await expect(pipeline.run(c)).rejects.toThrow('parse failure');expect(repo.getMeta('sync_state')).toBe('error');expect(repo.getAllFiles().length).toBe(50);}finally{db.close();rmSync(root,{recursive:true,force:true});}
 });
});

describe('semantic cache invalidation after partial sync',()=>{
 it('discovers new semantic source files outside indexed domains',async()=>{
  const root=mkdtempSync(join(tmpdir(),'septum-new-semantic-'));mkdirSync(join(root,'src/mcp/tools'),{recursive:true});mkdirSync(join(root,'other'));writeFileSync(join(root,'package.json'),'{"name":"mcp-fixture"}');const db=new SeptumDatabase(':memory:'),repo=new SeptumRepository(db.raw);try{const c=ConfigLoader.getDefaultConfig();c.domains={other:{root:'other',allowed_dependencies:[],forbidden_dependencies:[],archetypes:{}}};writeFileSync(join(root,'src/mcp/server.ts'),'export const TOOL_SCHEMAS = { mcp_fixture_a: {}, mcp_fixture_b: {} };');writeFileSync(join(root,'src/mcp/tools/a.ts'),'export function first() {}');const pipeline=new IngestionPipeline(repo,root);await pipeline.run(c);const before=repo.getAllVerticalSlices().length;writeFileSync(join(root,'src/mcp/tools/b.ts'),'export function second() {}');await pipeline.run(c,{verifyContent:true});expect(repo.getAllVerticalSlices().length).toBeGreaterThan(before);}finally{db.close();rmSync(root,{recursive:true,force:true});}
 });
 it('persists dirty slices when a committed batch is followed by cancellation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'septum-dirty-batch-'));mkdirSync(join(root,'src'));const db=new SeptumDatabase(':memory:'),repo=new SeptumRepository(db.raw);try{const c=ConfigLoader.getDefaultConfig();c.domains={src:{root:'src',allowed_dependencies:[],forbidden_dependencies:[],archetypes:{}}};for(let i=0;i<51;i++)writeFileSync(join(root,`src/${String(i).padStart(2,'0')}Controller.ts`),`export function old${i}() {}`);const pipeline=new IngestionPipeline(repo,root);await pipeline.run(c);for(let i=0;i<50;i++)writeFileSync(join(root,`src/${String(i).padStart(2,'0')}Controller.ts`),`export function new${i}() {}`);const abort=new AbortController();const upsert=repo.upsertFile.bind(repo);let count=0;repo.upsertFile=((...args:any[])=>{const result=(upsert as any)(...args);if(++count===50)abort.abort();return result;}) as any;await expect(pipeline.run(c,{signal:abort.signal})).rejects.toThrow();expect(repo.getMeta('slices_dirty')).toBe('1');await pipeline.run(c,{verifyContent:true});expect(repo.getAllVerticalSlices().some(slice=>slice.action_name==='new0')).toBe(true);expect(repo.getMeta('sync_state')).toBe('complete');}finally{db.close();rmSync(root,{recursive:true,force:true});}
 });
});
