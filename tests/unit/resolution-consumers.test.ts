import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { CallGraphTracer } from "../../src/core/resolver/call-graph-tracer.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/check-boundary.ts";
import { handleGetSymbolImpact } from "../../src/mcp/tools/get-symbol-impact.ts";
import { handleGetSymbol } from "../../src/mcp/tools/get-symbol.ts";

describe("resolution evidence across consumers", () => {
 let root: string, db: SeptumDatabase, repo: SeptumRepository, pipeline: IngestionPipeline;
 const config=ConfigLoader.getDefaultConfig(); config.domains={app:{root:"app",allowed_dependencies:[],forbidden_dependencies:["shared"],archetypes:{}},shared:{root:"shared",allowed_dependencies:[],forbidden_dependencies:[],archetypes:{}}};
 beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"septum-consumers-"));db=new SeptumDatabase(":memory:");repo=new SeptumRepository(db.raw);pipeline=new IngestionPipeline(repo,root);});
 afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 function put(file:string,text:string){mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);}
 const boundary=async(file?:string)=>JSON.parse((await handleCheckBoundary(new BoundaryEvaluator(repo,new ModuleResolver(root,repo)),config,file?{file_path:file}:{scope:"all"},repo,root)).content[0].text);
 it("shares a Go package target across catalog, inspect, impact and boundary",async()=>{
  put("go.mod","module myapp\ngo 1.22\n"); put("app/main.go",'package app\nimport "myapp/shared"\nfunc Run() {}'); put("shared/a.go","package shared\nfunc A() {}");put("shared/b.go","package shared\nfunc B() {}");
  await pipeline.run(config);
  const edges=repo.getImportRelationships(root);expect(edges).toHaveLength(1);expect(edges[0]!.kind).toBe("imports");expect(edges[0]!.target_domains).toEqual(["shared"]);
  expect(repo.getFileConnections("app/main.go").imports_from).toEqual(["shared/a.go","shared/b.go"]);
  expect((await boundary()).status).toBe("rejected");
  const inspect=JSON.parse(handleGetSymbol(repo,config,{symbol:"Run",include_dependencies:true},root).content[0].text);expect(inspect.relationships[0].resolution.targets[0].files).toHaveLength(2);
  const impact=JSON.parse(handleGetSymbolImpact(repo,config,{symbol:"A"},root).content[0].text);expect(impact.import_dependents).toHaveLength(1);expect(impact.inbound_callers_complete).toBe(false);
  const tracer=new CallGraphTracer(repo,root);tracer.initMaps();expect(tracer.resolveImportToFile("app/main.go","myapp/shared")).toBeUndefined();expect(tracer.resolveImportTargets("app/main.go","myapp/shared")).toHaveLength(2);
 });
 it("recomputes manifest-only changes and file moves/deletes without a resolution cache",async()=>{
  put("app/main.ts",'import {Target} from "@pkg/target"; export function Run() {}');put("shared/target.ts","export class Target {}");put("app/target.ts","export class LocalTarget {}");
  put("tsconfig.json",JSON.stringify({compilerOptions:{paths:{"@pkg/*":["shared/*"]}}}));await pipeline.run(config);
  expect(repo.getFileConnections("app/main.ts").imports_from).toEqual(["shared/target.ts"]);
  put("tsconfig.json",JSON.stringify({compilerOptions:{paths:{"@pkg/*":["app/*"]}}}));
  expect(repo.getFileConnections("app/main.ts").imports_from).toEqual(["app/target.ts"]);
  renameSync(join(root,"app/target.ts"),join(root,"app/moved.ts"));expect(repo.getImportRelationships(root)[0]!.resolution.status).toBe("unresolved");expect((await boundary("app/main.ts")).status).toBe("unknown");
 });
 it("limits unknown results to the relevant scope and recognizes external packages",async()=>{
  put("package.json",'{"dependencies":{"zod":"^3"}}');put("app/main.ts",'import {z} from "zod"; export function Run() {}');put("shared/bad.ts",'import x from "unknown-package"; export function Bad() {}');await pipeline.run(config);
  expect((await boundary("app/main.ts")).status).toBe("approved");expect((await boundary("shared/bad.ts")).status).toBe("unknown");
 });
 it("bounds dependency traversal by hops and terminates cycles",async()=>{
  put("app/a.ts",'import {B} from "./b"; export class A {}');put("app/b.ts",'import {C} from "./c"; export class B {}');put("app/c.ts",'import {A} from "./a"; export class C {}');await pipeline.run(config);
  const tracer=new CallGraphTracer(repo,root);tracer.initMaps();const start=repo.getFileByPath("app/a.ts")!;
  const shallow:any[]=[];tracer.traverseOutboundDependencies(start,shallow,1);expect(shallow.map(node=>node.file)).toEqual(["app/b.ts"]);
  const deep:any[]=[];tracer.traverseOutboundDependencies(start,deep,8);expect(new Set(deep.map(node=>node.file))).toEqual(new Set(["app/b.ts","app/c.ts"]));expect(deep.every(node=>node.relationship.kind==="imports")).toBe(true);
  put("app/a.ts","export class A {}");expect((await boundary("app/a.ts")).status).toBe("unknown");
 });
 it("rebuilds cached import expansion at the requested depth",async()=>{
  put("app/a.ts",'import {B} from "./b"; export class A {}');put("app/b.ts",'import {C} from "./c"; export class B {}');put("app/c.ts","export class C {}");await pipeline.run(config);
  const dependency=(file:string)=>({stage:"service",symbol:file,file,relationship:{kind:"imports",derivation:"source",reason:"fixture"}});
  repo.upsertVerticalSlice({domain_id:null,feature_key:null,http_method:"GET",route_uri:"/cached",route_name:null,controller_class:"A",action_name:"run",controller_file:"app/a.ts",controller_line:1,architecture_style:"fixture",entry_kind:"http_route",execution_chain_json:JSON.stringify([{stage:"controller",symbol:"A",file:"app/a.ts"},dependency("app/b.ts"),dependency("app/c.ts")])});
  const tracer=new VerticalSliceTracer(repo,root);
  expect(tracer.trace("GET /cached",1).chain!.filter(node=>node.relationship?.kind==="imports").map(node=>node.file)).toEqual(["app/b.ts"]);
  expect(new Set(tracer.trace("GET /cached",5).chain!.filter(node=>node.relationship?.kind==="imports").map(node=>node.file))).toEqual(new Set(["app/b.ts","app/c.ts"]));
 });
 it("marks stale source and partial sync unknown, then recovers after reindex",async()=>{
  put("app/main.ts",'import {Target} from "./target"; export function Run() {}');put("app/target.ts","export class Target {}");await pipeline.run(config);
  put("app/main.ts","export function Changed() {}");expect(repo.getImportRelationships(root)[0]!.freshness).toBe("stale");expect((await boundary("app/main.ts")).status).toBe("unknown");
  await pipeline.run(config,{verifyContent:true});expect(repo.getImportRelationships(root)).toEqual([]);expect((await boundary("app/main.ts")).status).toBe("approved");
  put("app/main.ts",'import {Target} from "./target"; export function Changed() {}');
  expect((await boundary("app/main.ts")).status).toBe("unknown");
  repo.setMeta("sync_state","running");expect((await boundary("app/main.ts")).status).toBe("unknown");
 });
});
