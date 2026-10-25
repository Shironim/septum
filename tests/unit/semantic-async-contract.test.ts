import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { SemanticSliceExtractorRegistry as Registry } from "../../src/core/parser/extractors/registry.ts";
import { FastApiSemanticExtractor } from "../../src/core/parser/extractors/fastapi-semantic.ts";
const candidate={domain_id:null,feature_key:null,http_method:"GET",route_uri:"/async",route_name:null,controller_class:"Fixture",action_name:"run",controller_file:null,controller_line:1,architecture_style:"fixture",entry_kind:"http_route",execution_chain_json:"[]"};
describe("async semantic lifecycle",()=>{
 let root:string,db:SeptumDatabase,repo:SeptumRepository;let cleanup:(()=>void)|undefined;
 beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"septum-async-"));db=new SeptumDatabase(":memory:");repo=new SeptumRepository(db.raw);});
 afterEach(()=>{cleanup?.();cleanup=undefined;db.close();rmSync(root,{recursive:true,force:true});});
 it("awaits async adapters on a cold catalog and reuses persisted slices",async()=>{
  let calls=0;cleanup=Registry.register({id:"fixture",name:"fixture",canHandle:r=>r===root,extractSlices:async()=>{calls++;await Promise.resolve();return[candidate];}});
  const tracer=new VerticalSliceTracer(repo,root);expect((await tracer.traceAsync("GET /async")).found).toBe(true);expect(repo.getAllVerticalSlices()).toHaveLength(1);
  expect((await tracer.traceAsync("GET /async")).found).toBe(true);expect(calls).toBe(1);
 });
 it("does not persist a partial adapter result when another adapter rejects",async()=>{
  const undo=Registry.register({id:"good",name:"good",canHandle:r=>r===root,extractSlices:()=>[candidate]});
  cleanup=Registry.register({id:"bad",name:"bad",canHandle:r=>r===root,extractSlices:async()=>{throw new Error("fixture rejection");}});
  try{const result=await new VerticalSliceTracer(repo,root).traceAsync("GET /async");expect(result.found).toBe(false);expect(result.diagnostics?.join(" ")).toContain("fixture rejection");expect(repo.getAllVerticalSlices()).toHaveLength(0);}finally{undo();}
 });
 it("checks cancellation after awaiting an adapter and before writes",async()=>{
  const controller=new AbortController();cleanup=Registry.register({id:"cancel",name:"cancel",canHandle:r=>r===root,extractSlices:async()=>{controller.abort();return[candidate];}});
  await expect(new VerticalSliceTracer(repo,root).traceAsync("GET /async",5,controller.signal)).rejects.toThrow();expect(repo.getAllVerticalSlices()).toHaveLength(0);
 });
 it("does not publish semantic success or erase configuration when ingestion rejects",async()=>{
  writeFileSync(join(root,"main.ts"),"export function run() {}");
  repo.setMeta("features_json",'{"keep":{"domain":"main"}}');
  cleanup=Registry.register({id:"failed-ingestion",name:"failed-ingestion",canHandle:r=>r===root,extractSlices:async()=>{throw new Error("ingestion adapter failure");}});
  const config=ConfigLoader.getDefaultConfig();config.domains={main:{root:".",archetypes:{},allowed_dependencies:[],forbidden_dependencies:[]}};
  await expect(new IngestionPipeline(repo,root).run(config)).rejects.toThrow("ingestion adapter failure");
  expect(repo.getAllVerticalSlices()).toHaveLength(0);expect(repo.getMeta("sync_state")).toBe("error");expect(repo.getMeta("features_json")).toContain("keep");
 });
 it("refreshes a persisted AST slice when a recorded source fingerprint changes",async()=>{
  writeFileSync(join(root,"requirements.txt"),"fastapi==0.115.0");
  const file=join(root,"api.py"), source=(route:string)=>`from fastapi import FastAPI\napp=FastAPI()\n@app.get("/${route}")\ndef handler():\n    return 1\n`;
  writeFileSync(file,source("old"));const tracer=new VerticalSliceTracer(repo,root);expect((await tracer.traceAsync("GET /old")).found).toBe(true);
  writeFileSync(file,source("new"));expect((await tracer.traceAsync("GET /new")).found).toBe(true);expect((await tracer.traceAsync("GET /old")).found).toBe(false);
 });
 it("uses AST routes and per-file router scope, ignoring decorator text in strings",async()=>{
  writeFileSync(join(root,"one.py"),'from fastapi import APIRouter\nrouter = APIRouter(prefix="/one")\n@router.get("/items")\ndef one():\n    return 1\n');
  writeFileSync(join(root,"two.py"),'from fastapi import APIRouter\nrouter = APIRouter(prefix="/two")\n@router.get("/items")\ndef two():\n    return 2\nfake = """@router.post(\"/fake\")\ndef fake(): pass"""\n');
  const slices=await new FastApiSemanticExtractor().extractSlices(root);expect(slices.map(s=>s.route_uri).sort()).toEqual(["/one/items","/two/items"]);
  expect(JSON.parse(slices[0]!.execution_chain_json)[0].relationship.kind).toBe("route_binding");
 });
});
