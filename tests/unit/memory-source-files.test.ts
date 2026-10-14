import {describe,it,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSourceFile,SourceFileLimitError} from '../../src/core/resources/source-files.ts';
import {RESOURCE_LIMITS} from '../../src/core/resources/limits.ts';
import {auditStagedFiles} from '../../src/core/boundary/staged-auditor.ts';
import {execFileSync} from 'node:child_process';
import {ConfigLoader} from '../../src/core/config/loader.ts';
import {SeptumDatabase} from '../../src/core/database/client.ts';
import {SeptumRepository} from '../../src/core/database/repository.ts';
import {BoundaryEvaluator} from '../../src/core/boundary/evaluator.ts';
import {ModuleResolver} from '../../src/core/resolver/module-resolver.ts';

describe('bounded source reads',()=>{
 it('preserves UTF-8, empty inputs, exact-size inputs and rejects oversized reads',()=>{
  const root=mkdtempSync(join(tmpdir(),'septum-read-'));try{const file=join(root,'a.ts');for(const content of ['', 'αβこんにちは', 'x'.repeat(RESOURCE_LIMITS.sourceBytes)]){writeFileSync(file,content);expect(readSourceFile(file)).toBe(content);}writeFileSync(file,'x'.repeat(RESOURCE_LIMITS.sourceBytes+1));expect(()=>readSourceFile(file)).toThrow(SourceFileLimitError);}finally{rmSync(root,{recursive:true,force:true});}
 });
 it('rejects oversized staged blobs before parsing or loading the blob',async()=>{
  const root=mkdtempSync(join(tmpdir(),'septum-staged-limit-'));const db=new SeptumDatabase(':memory:'),repo=new SeptumRepository(db.raw);try{execFileSync('git',['init','-q'],{cwd:root});writeFileSync(join(root,'big.ts'),'/*'+'x'.repeat(RESOURCE_LIMITS.sourceBytes)+'*/');execFileSync('git',['add','big.ts'],{cwd:root});const c=ConfigLoader.getDefaultConfig();c.domains={root:{root:'.',allowed_dependencies:[],forbidden_dependencies:[],archetypes:{}}};await expect(auditStagedFiles(new BoundaryEvaluator(repo,new ModuleResolver(root,repo)),c,root,undefined,repo)).rejects.toThrow('resource limit');}finally{db.close();rmSync(root,{recursive:true,force:true});}
 });
});
