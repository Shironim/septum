import {strict as assert} from 'node:assert';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SeptumDatabase} from '../../src/core/database/client.ts';
import {SeptumRepository} from '../../src/core/database/repository.ts';
import {ConfigLoader} from '../../src/core/config/loader.ts';
import {SessionManager} from '../../src/core/session/session-manager.ts';
import {handleRegisterFeature} from '../../src/mcp/tools/register-feature.ts';
const [mode,fixture,owner]=process.argv.slice(2);
const root=fixture||mkdtempSync('/tmp/septum-review-race-');
const db=new SeptumDatabase(join(root,'.septum/septum.db')); const repo=new SeptumRepository(db.raw);
try {
 if(mode==='contend'){
   process.env.SEPTUM_SESSION_ID=owner;
   writeFileSync(join(root,`.ready-${owner}`),'ready');
   const deadline=Date.now()+3000;
   while(!existsSync(join(root,'.start'))){
     assert.ok(Date.now()<deadline,'start barrier timed out');
     await Bun.sleep(10);
   }
   try {
     await handleRegisterFeature(repo,ConfigLoader.loadFromRepository(repo),{feature_key:owner,domain:'orders',allowed_touchpoints:[]},root);
     console.log(JSON.stringify({owner,accepted:true}));
   } catch(error) {
     assert.match(String(error),/owned by/);
     console.log(JSON.stringify({owner,accepted:false}));
   }
 } else if(mode==='child'){
   process.env.SEPTUM_SESSION_ID='owner-a';
   await handleRegisterFeature(repo,ConfigLoader.loadFromRepository(repo),{feature_key:'f2',domain:'orders',allowed_touchpoints:['src/orders/new.ts']},root);
   console.log('SECOND_PROCESS_LOCK_SUCCESS');
 } else {
   repo.upsertDomain('orders',{root:'src/orders'});process.env.SEPTUM_SESSION_ID='owner-a';
   await handleRegisterFeature(repo,ConfigLoader.loadFromRepository(repo),{feature_key:'f1',domain:'orders',allowed_touchpoints:['src/orders/a.ts']},root);
   const orig=SessionManager.saveActiveSession;
   SessionManager.saveActiveSession=(...args:Parameters<typeof orig>)=>{
     const child=Bun.spawnSync(['bun',import.meta.path,'child',root]);
     console.log('CHILD',child.exitCode,child.stdout.toString(),child.stderr.toString());
     return orig(...args);
   };
   process.env.SEPTUM_SESSION_ID='owner-b';
   try {await handleRegisterFeature(repo,ConfigLoader.loadFromRepository(repo),{feature_key:'rejected-b',domain:'orders',allowed_touchpoints:['src/orders/b.ts']},root);}catch(e){console.log('REJECTED_B',String(e));}
   SessionManager.saveActiveSession=orig;
   const session=SessionManager.getActiveSession(root)!;
   const features=JSON.parse(repo.getMeta('features_json')!);
   assert.equal(session.feature_key,'f2');
   assert.ok(features.f2,'successful owner update was lost');
   assert.equal(features['rejected-b'],undefined);
   console.log('PASS: successful owner update survives rejected contender');
 }
}finally{db.close();if(!fixture)rmSync(root,{recursive:true,force:true});}
