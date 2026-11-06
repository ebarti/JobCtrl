#!/usr/bin/env node
// Real compiled installer/selector + Python HTTP/worker + Temporal, with private
// synthetic state. The private interpreter adds one synthetic orphan at its
// executable boundary; no application action/repository is mocked.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {spawn} from 'node:child_process';
import {chmod, cp, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildFileInventory, summarizeComponentFiles} from '../distribution-manifest.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Map();
for(let i=2;i<process.argv.length;i+=2) {
  assert(process.argv[i]?.startsWith('--') && process.argv[i+1], 'Every option requires a value');
  args.set(process.argv[i].slice(2),process.argv[i+1]);
}
const suite=args.get('suite') ?? 'all';
assert(['all','lifecycle','custody'].includes(suite),'--suite must be all, lifecycle or custody');
const lifecycleSelected=suite==='all'||suite==='lifecycle';
const custodySelected=suite==='all'||suite==='custody';
assert.equal(process.platform,'darwin','Native lifecycle qualification requires Darwin launchd');
assert.equal(process.arch,'arm64','The native distribution currently supports arm64');
const taskParent=path.resolve(args.get('output-parent') ?? os.tmpdir());
await mkdir(taskParent,{recursive:true,mode:0o700});
const root=await mkdtemp(path.join(taskParent,'jobctrl-native-lifecycle-'));
const home=path.join(root,'home'), workspace=path.join(root,'workspace'), runtime=path.join(root,'runtime');
for(const dir of [home,workspace,path.join(root,'tmp'),path.join(root,'bin')]) await mkdir(dir,{recursive:true,mode:0o700});
const python=path.resolve(args.get('python') ?? path.join(repo,'workers/automation/.venv/bin/python'));
const temporal=path.resolve(args.get('temporal') ?? '/opt/homebrew/bin/temporal');
const launcher=path.resolve(args.get('launcher') ?? path.join(root,'bin/jobctrl'));
const installer=path.resolve(args.get('installer') ?? path.join(root,'bin/jobctrl-installer'));
const env={HOME:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:path.join(root,'tmp'),
  JOBCTRL_RUNTIME_HOME:runtime,JOBCTRL_DIR:workspace,
  JOBCTRL_EXECUTION_QA_SANDBOX:'loopback-only-v1',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'};
const selector=path.join(runtime,'bin/jobctrl'), cases=[];
function passed(name){cases.push(name);console.log(JSON.stringify({suite,case:name,status:'passed'}));}
let pythonInfo;
const digest=data=>createHash('sha256').update(data).digest('hex');
const scriptSha256=digest(await readFile(fileURLToPath(import.meta.url)));
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function put(file,data,mode=0o644){await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,data,{mode});await chmod(file,mode);}
async function run(command,argv,{commandEnv=env,cwd=repo,acceptFailure=false,timeout=110000}={}){
  const child=spawn(command,argv,{env:commandEnv,cwd,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',data=>{stdout+=data;if(stdout.length>2e6)child.kill('SIGTERM');});
  child.stderr.on('data',data=>{stderr+=data;if(stderr.length>2e6)child.kill('SIGTERM');});
  const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}).finally(()=>clearTimeout(timer));
  if(!acceptFailure)assert.equal(code,0,`${command} ${argv.join(' ')}: ${stderr.slice(-6000)} ${stdout.slice(-1000)}`);
  return {code,stdout,stderr};
}
async function api(route,method='GET',value){
 const result=await fetch('http://127.0.0.1:8766'+route,{method,headers:{origin:'http://127.0.0.1:8766','content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value),signal:AbortSignal.timeout(5000)});
 const body=await result.json();assert(result.ok,JSON.stringify(body));return body;
}
async function freePort(port){await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve));});}
async function tree(directory){const found={};async function walk(dir,prefix=''){for(const name of (await readdir(dir)).sort()){const f=path.join(dir,name),key=prefix+name,info=await stat(f);if(info.isDirectory())await walk(f,key+'/');else found[key]=digest(await readFile(f));}}await walk(directory);return found;}
async function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
async function dead(pid){const deadline=Date.now()+15000;while(await alive(pid)){assert(Date.now()<deadline,`Owned orphan ${pid} survived native stop`);await new Promise(r=>setTimeout(r,50));}}
async function childPids(){try{return (await readFile(path.join(workspace,'qa-orphan-pids'),'utf8')).trim().split('\n').filter(Boolean).map(Number);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
const observer=String.raw`import os,pathlib,signal,sys
args=sys.orig_argv
root=pathlib.Path(os.environ['JOBCTRL_DIR'])
if 'jobctrl.app.server' in args and (root/'.qa-block-api').exists():
    os._exit(73)
if 'jobctrl.app.worker' in args and (root/'.qa-custody').is_file():
    child=os.fork()
    if child==0:
        os.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN);os.environ.clear();os.execl('/bin/sleep','sleep','3600')
    with (root/'qa-orphan-pids').open('a') as stream: stream.write(str(child)+'\n')
`;

async function payload(sequence){
 const out=path.join(root,'release-'+sequence),payload=path.join(out,'payload');
 await mkdir(payload,{recursive:true});
 for(const name of ['jobctrl','jobctrl-installer']){const source=name==='jobctrl'?launcher:installer;await put(path.join(payload,'launcher',name),await readFile(source),0o755);}
 for(const name of ['runtime-manifest.json','application-schema.json','update-protocol.json'])await put(path.join(payload,'launcher',name),await readFile(path.join(repo,'launcher',name)));
 await put(path.join(payload,'launcher','restore-observer.py'),observer);
 await put(path.join(payload,'python/bin/python3'),await readFile(pythonInfo.executable),0o755);
 await put(path.join(payload,'python/lib',`libpython${pythonInfo.version}.dylib`),await readFile(path.join(pythonInfo.base_prefix,'lib',`libpython${pythonInfo.version}.dylib`)),0o755);
 await put(path.join(payload,'python/pyvenv.cfg'),`home = ${path.join(pythonInfo.base_prefix,'bin')}\ninclude-system-site-packages = false\nversion = ${pythonInfo.version}\n`);
 const site=path.join(payload,'python/lib',`python${pythonInfo.version}`,'site-packages');
 const installedPayload=path.join(runtime,'releases',`local-native-e2e-${String(sequence).padStart(4,'0')}`,'payload');
 // Only third-party dependencies are shared. Freeze actual application bytes
 // in the immutable release so shared-checkout edits cannot change its schema.
 await cp(path.join(root,'application-source'),path.join(payload,'worker/site-packages/jobctrl'),{recursive:true});
 await put(path.join(site,'native-e2e.pth'),`${pythonInfo.purelib}\nimport sys; sys.path.insert(0, ${JSON.stringify(path.join(installedPayload,'worker/site-packages'))})\nimport runpy; runpy.run_path(${JSON.stringify(path.join(runtime,'releases',`local-native-e2e-${String(sequence).padStart(4,'0')}`,'payload/launcher/restore-observer.py'))})\n`);
 await put(path.join(payload,'temporal/temporal'),await readFile(temporal),0o755);
 await put(path.join(payload,'node/bin/node'),`#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`,0o755);
 await put(path.join(payload,'web/index.html'),'<!doctype html><title>Owned native lifecycle E2E</title>');
 const files=await buildFileInventory(payload), components=[];
 for(const [id,owned] of [['jobctrl-launcher','launcher'],['jobctrl-web','web'],['jobctrl-worker','worker'],['node-runtime','node'],['python-runtime','python'],['temporal-runtime','temporal']]){
  const summary=summarizeComponentFiles(owned,files);
  components.push({id,classification:'core-runtime',version:'2.0.0',owner:'JobCtrl native E2E',source:'https://example.invalid/owned-native-e2e',license:'AGPL-3.0-only',redistribution:'bundle',path:owned,sha256:summary.sha256,sizeBytes:summary.sizeBytes,required:true});
 }
 const buildId=`local-native-e2e-${String(sequence).padStart(4,'0')}`;
 const manifest={schemaVersion:1,appVersion:'2.0.0',buildId,releaseChannel:'local',sourceDateEpoch:0,platform:{id:'darwin-arm64',os:'darwin',arch:'arm64',minimumOsVersion:'15.0'},launcherCompatibility:{minimum:2,maximum:2},components,capabilities:[{id:'core-browser',defaultEnabled:true,componentIds:['jobctrl-web']}],files,signing:{manifestAlgorithm:'ed25519',manifestKeyId:'local-development',codeSigning:'unsigned-local',notarized:false}};
 const manifestRaw=JSON.stringify(manifest)+'\n';
 await put(path.join(payload,'manifest.json'),manifestRaw);
 await put(path.join(payload,'manifest.sig'),JSON.stringify({schemaVersion:1,status:'unsigned-local',manifestAlgorithm:'ed25519',manifestKeyId:'local-development',signature:null,promotable:false})+'\n');
 const archive=path.join(out,'payload.zip');
 await run('/usr/bin/zip',['-q','-X','-r',archive,'.'],{cwd:payload});
 const archiveBytes=await readFile(archive);
 const descriptor={schemaVersion:1,channel:'local',sequence,minimumSafeSequence:1,revokedBuildIds:[],buildId,appVersion:'2.0.0',platform:{id:'darwin-arm64',os:'darwin',arch:'arm64'},artifact:{url:pathToFileURL(archive).href,sha256:digest(archiveBytes),sizeBytes:archiveBytes.length,archiveType:'zip',manifestSha256:digest(manifestRaw)}};
 await put(path.join(out,'descriptor.json'),JSON.stringify(descriptor)+'\n');
 await put(path.join(out,'descriptor.sig'),JSON.stringify({schemaVersion:1,status:'unsigned-local',algorithm:'ed25519',keyId:'local-development',signature:null})+'\n');
 return {buildId,out,payload};
}
async function install(release,{stage=false,commandEnv=env}={}){return run(installer,['--allow-unsigned-local','--home',runtime,'--descriptor-file',path.join(release.out,'descriptor.json'),'--signature-file',path.join(release.out,'descriptor.sig'),'--archive-file',path.join(release.out,'payload.zip'),'--json',...(stage?['--stage-only']:[])],{commandEnv});}
async function stop(){const result=await run(selector,['stop'],{acceptFailure:true});assert.equal(result.code,0,result.stderr);for(const pid of await childPids())await dead(pid);}

async function liveAuthority(){
 const files=['jobctrl.db','temporal.db'].map(name=>path.join(workspace,name)).concat([path.join(runtime,'active.json'),path.join(runtime,'transition.json'),selector]);
 return Object.fromEntries(await Promise.all(files.map(async name=>[name,digest(await readFile(name))])));
}
async function refuseRollback(target,label){
 const before=await liveAuthority();
 const result=await run(selector,['rollback','--to',target.buildId],{acceptFailure:true});
 assert.notEqual(result.code,0,label);assert.deepEqual(await liveAuthority(),before,label);
 assert(await alive(control.pid),'Refusal affected unrelated process control');
}

async function lifecycle(first,second){
 await run(selector,['backup']);
 const backups=(await readdir(path.join(workspace,'backups'))).filter(name=>name.startsWith('pair-'));
 assert.equal(backups.length,1);
 const backup=await json(path.join(workspace,'backups',backups[0],'pair.json'));
 const appFile=backup.files.find(file=>file.name==='jobctrl.db');assert.equal(appFile.sqliteApplicationId,1245926228);assert.equal(appFile.sqliteUserVersion,1);
 for(const file of backup.files)assert.equal(digest(await readFile(path.join(workspace,'backups',backup.id,file.name))),file.sha256);
 assert.equal((await api('/v1/settings')).targetCriteria,'native-original');
 passed('coherent-paired-backup-readback-and-restart');
 await install(second,{stage:true});
 await run(selector,['update','--to',second.buildId]);
 assert.equal((await json(path.join(runtime,'active.json'))).receipt.buildId,second.buildId);
 assert.equal((await api('/v1/settings')).targetCriteria,'native-original');
 const settings=await api('/v1/settings');await api('/v1/settings','PATCH',{expectedRevision:settings.revision,targetCriteria:'native-after-update'});
 passed('target-update-preserves-accepted-application-state');
 await stop();
 const completed=await json(path.join(runtime,'transition.json'));
 const pairPath=path.join(workspace,'backups',completed.backupId,'pair.json');
 const originalRaw=await readFile(pairPath),original=JSON.parse(originalRaw);
 const appBackup=path.join(workspace,'backups',original.id,'jobctrl.db'),savedBackup=await readFile(appBackup);
 await writeFile(appBackup,Buffer.concat([savedBackup,Buffer.from('owned changed backup')]));
 try{await refuseRollback(first,'changed paired backup');}finally{await writeFile(appBackup,savedBackup);}
 for(const change of [pair=>{pair.files.find(f=>f.name==='jobctrl.db').sqliteApplicationId=0;},pair=>{pair.id='../unowned';},pair=>{pair.files[1]={...pair.files[0]};}]){
  const changed=JSON.parse(originalRaw);change(changed);await writeFile(pairPath,JSON.stringify(changed));
  try{await refuseRollback(first,'invalid pair authority');}finally{await writeFile(pairPath,originalRaw);}
 }
 passed('changed-legacy-duplicate-unsafe-pairs-refuse-before-live-or-journal-mutation');
 // Observe actual public rollback replacement before newly started writers.
 let finishProof,proofSeen=false;
 const proof=new Promise(resolve=>{finishProof=resolve;});
 async function inspectRestoredPair(){try{const got=await Promise.all(original.files.map(async file=>[file.name,digest(await readFile(path.join(workspace,file.name)))]));if(got.every(([name,hash])=>original.files.find(file=>file.name===name).sha256===hash)){proofSeen=true;finishProof(Object.fromEntries(got));}}catch{}}
 const watcher=watch(workspace,()=>{void inspectRestoredPair();});
 try{
  await run(selector,['rollback','--to',first.buildId]);
  const bytes=await Promise.race([proof,new Promise((_,reject)=>setTimeout(()=>reject(Error('Did not observe exact paired restore before writers')),2000))]);
  await put(path.join(root,'restored-pair-proof.json'),JSON.stringify(bytes,null,2));assert(proofSeen);
 }finally{watcher.close();}
 assert.equal((await api('/v1/settings')).targetCriteria,'native-original');
 passed('explicit-rollback-restores-both-exact-files-before-writers');
 await stop();
 await legacyAdmission(first,second);
}

async function legacyAdmission(first,candidate){
 const legacy=path.join(root,'legacy');await mkdir(legacy,{mode:0o700});
 await run(python,['-I','-B','-c',`import pathlib,sqlite3,sys
p=pathlib.Path(sys.argv[1]);c=sqlite3.connect(p/'jobctrl.db');c.execute('CREATE TABLE legacy_profile(value TEXT)');c.execute("INSERT INTO legacy_profile VALUES ('owned source')");c.execute('PRAGMA user_version=15');c.commit();c.close();(p/'jobctrl.db').chmod(0o600)
c=sqlite3.connect(p/'temporal.db');c.execute('CREATE TABLE legacy_history(value TEXT)');c.commit();c.close();(p/'temporal.db').chmod(0o600)
(p/'jobctrl.db-wal').write_bytes(b'owned legacy companion');(p/'config.json').write_text('owned synthetic source')`,legacy]);
 const before=await tree(legacy),activeBefore=await readFile(path.join(runtime,'active.json')),selectorBefore=await readFile(selector),journalBefore=await readFile(path.join(runtime,'transition.json'));
 const legacyEnv={...env,JOBCTRL_DIR:legacy};
 for(const command of [['start','--no-open'],['backup'],['update'],['update','--to',candidate.buildId],['rollback','--to',first.buildId]]){
  const result=await run(selector,command,{commandEnv:legacyEnv,acceptFailure:true});assert.notEqual(result.code,0,`Legacy accepted ${command}`);assert.deepEqual(await tree(legacy),before);
 }
 assert.deepEqual(await readFile(path.join(runtime,'active.json')),activeBefore);assert.deepEqual(await readFile(selector),selectorBefore);assert.deepEqual(await readFile(path.join(runtime,'transition.json')),journalBefore);
 const refusedHome=path.join(root,'refused-legacy-install');
 const admission=await run(installer,['--allow-unsigned-local','--home',refusedHome,'--descriptor-file',path.join(first.out,'descriptor.json'),'--signature-file',path.join(first.out,'descriptor.sig'),'--archive-file',path.join(first.out,'payload.zip'),'--json'],{commandEnv:{...legacyEnv,JOBCTRL_RUNTIME_HOME:refusedHome},acceptFailure:true});
 assert.notEqual(admission.code,0,'Installer selected legacy data');assert.deepEqual(await tree(legacy),before);
 for(const selected of ['active.json','transition.json','bin/jobctrl'])await assert.rejects(stat(path.join(refusedHome,selected)),{code:'ENOENT'});
 passed('installer-first-selection-refuses-legacy-before-selector-or-journal-publication');
 await run(selector,['stop'],{commandEnv:legacyEnv});assert.deepEqual(await tree(legacy),before);
 passed('legacy-start-backup-update-rollback-refuse-with-exact-source-preservation');
}

async function receiptRefusals(){
 const status=JSON.parse((await run(selector,['status','--json'])).stdout);assert.equal(status.status,'running');
 const instanceDir=path.join(runtime,'instances',status.instanceId),statePath=path.join(instanceDir,'state.json');
 const stateRaw=await readFile(statePath),state=JSON.parse(stateRaw);
 assert(state.executionScopeId,'Real native supervisor has no execution receipt');
 const receiptPath=path.join(instanceDir,'executions',state.executionScopeId+'.json');
 const receiptRaw=await readFile(receiptPath),receipt=JSON.parse(receiptRaw);
 assert.equal(receipt.instanceId,state.instanceId);assert.equal(receipt.stateDir,workspace);
 const currentOrphans=[];for(const pid of await childPids())if(await alive(pid))currentOrphans.push(pid);
 const protectedPids=[state.supervisor.pid,...Object.values(state.components).map(item=>item.pid),...currentOrphans];
 const selection=await readFile(path.join(runtime,'active.json'));
 async function refuse(label){
  const result=await run(selector,['stop'],{acceptFailure:true});assert.notEqual(result.code,0,label);
  assert.deepEqual(await readFile(statePath),stateRaw,label);assert.deepEqual(await readFile(path.join(runtime,'active.json')),selection,label);
  for(const pid of protectedPids)assert(await alive(pid),`${label} signaled owned process ${pid} before authenticating its receipt`);
  assert(await alive(control.pid),`${label} affected unrelated control`);
 }
 const malformed=Buffer.from('{"schemaVersion":');
 await writeFile(receiptPath,malformed);
 try{await refuse('malformed receipt');assert.deepEqual(await readFile(receiptPath),malformed);}finally{await writeFile(receiptPath,receiptRaw);}
 const foreign=path.join(root,'unrelated-receipt-control.json');await put(foreign,receiptRaw,0o600);
 await rm(receiptPath);await symlink(foreign,receiptPath);
 try{await refuse('linked receipt');assert.equal(await readlink(receiptPath),foreign);assert.deepEqual(await readFile(foreign),receiptRaw);}finally{await rm(receiptPath);await put(receiptPath,receiptRaw,0o600);}
 const wrongBoot=Buffer.from(JSON.stringify({...receipt,bootSession:'00000000-0000-0000-0000-000000000000'})+'\n');
 await writeFile(receiptPath,wrongBoot);
 try{await refuse('wrong-boot receipt');assert.deepEqual(await readFile(receiptPath),wrongBoot);}finally{await writeFile(receiptPath,receiptRaw);}
 passed('malformed-linked-wrong-boot-receipts-refuse-before-process-or-registry-mutation');
 return state.executionScopeId;
}

async function custody(first,candidate){
 if(JSON.parse((await run(selector,['status','--json'])).stdout).status!=='running')await run(selector,['start','--no-open']);
 const previousScope=await receiptRefusals();
 const escaped=[];for(const pid of await childPids())if(await alive(pid))escaped.push(pid);assert(escaped.length>0,'No live escaped child reached the custody cleanup control');
 await stop();for(const pid of escaped)await dead(pid);assert(await alive(control.pid));
 const stopped=JSON.parse((await run(selector,['status','--json'])).stdout);assert.equal(stopped.status,'stopped');
 passed('owned-new-session-term-ignoring-children-cleaned-after-parents-exit-peer-preserved');
 await run(selector,['start','--no-open']);
 const running=JSON.parse((await run(selector,['status','--json'])).stdout);assert.equal(running.status,'running');
 const nextState=await json(path.join(runtime,'instances',running.instanceId,'state.json'));assert.notEqual(nextState.executionScopeId,previousScope);assert.equal((await api('/v1/health')).worker.status,'healthy');
 passed('ordinary-restart-retains-fresh-scope-and-real-worker-health');
 await install(candidate,{stage:true});
 await put(path.join(workspace,'.qa-block-api'),'owned startup failure',0o600);
 const failed=await run(selector,['update','--to',candidate.buildId],{acceptFailure:true});assert.notEqual(failed.code,0);
 const failedJournal=await json(path.join(runtime,'transition.json'));assert.equal(failedJournal.preserveLiveOnFailure,true);assert.equal(failedJournal.sourceSchemaVersion,1);
 // Finish owned cleanup before asserting stable exact database/journal bytes.
 await stop();await refuseRollback(first,'unfinished candidate preservation fence');
 await rm(path.join(workspace,'.qa-block-api'));
 await run(selector,['update']);
 assert.equal((await json(path.join(runtime,'active.json'))).receipt.buildId,candidate.buildId);
 const recovered=await json(path.join(runtime,'transition.json'));assert(recovered.recoveryBackupId);
 const originalPair=await json(path.join(workspace,'backups',recovered.backupId,'pair.json'));
 const recoveryPair=await json(path.join(workspace,'backups',recovered.recoveryBackupId,'pair.json'));
 assert.deepEqual(originalPair.releaseReceipt,recovered.old);assert.deepEqual(recoveryPair.releaseReceipt,recovered.candidate);
 await put(path.join(root,'recovery-pair-proof.json'),JSON.stringify({journalId:recovered.id,predecessor:originalPair.releaseReceipt.buildId,recovery:recoveryPair.releaseReceipt.buildId},null,2));
 assert.equal((await api('/v1/settings')).targetCriteria,'native-original');
 passed('failed-start-preserves-live-state-and-resumes-forward-with-correct-pair-receipts');
 await stop();
 await run(python,['-I','-B','-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute("INSERT INTO app_model_calls(receipt_id,operation,provider,model,lane,prompt_version,input_fingerprint,created_at,status,owner_pid,provider_started) VALUES('native-owned-uncertain','native.qa','codex','synthetic','interactive','1',?,'2026-11-06T00:00:00Z','uncertain',0,1)",('a'*64,));c.commit();c.close()`,path.join(workspace,'jobctrl.db')]);
 try{await refuseRollback(first,'unresolved provider accounting');}finally{
  await run(python,['-I','-B','-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute("DELETE FROM app_model_calls WHERE receipt_id='native-owned-uncertain'");c.commit();c.close()`,path.join(workspace,'jobctrl.db')]);
 }
 passed('unresolved-provider-receipts-block-rollback-with-exact-live-preservation');
}

async function verifyCleanup(){
 await stop();
 const status=JSON.parse((await run(selector,['status','--json'])).stdout);assert.equal(status.status,'stopped');
 const pids=await childPids();for(const pid of pids)await dead(pid);
 const instances=path.join(runtime,'instances');let executionRegistries=0,stoppedRegistries=0;
 for(const id of await readdir(instances)){
  const dir=path.join(instances,id);
  try{const state=await json(path.join(dir,'state.json'));assert(state.ownershipVerified&&state.stoppedAt);stoppedRegistries++;}catch(error){if(error.code!=='ENOENT')throw error;}
  try{assert.equal((await readdir(path.join(dir,'executions'))).length,0,`Execution receipts remain for ${id}`);executionRegistries++;}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 for(const port of [7233,8233,8766])await freePort(port);
 assert(await alive(control.pid),'Native cleanup affected unrelated process control');
 const cleanup={status:'passed',suite,stoppedRegistries,executionRegistries,remainingExecutionReceipts:0,orphanPidsVerifiedAbsent:pids,ports:[7233,8233,8766]};
 await put(path.join(root,'cleanup-proof.json'),JSON.stringify(cleanup,null,2)+'\n',0o600);
 passed('selected-suite-cleanup-retired-owned-receipts-and-released-fixed-ports');
 return cleanup;
}

const started=Date.now();let installed=false,control;
try{
 for(const port of [7233,8233,8766])await freePort(port);
 if(!args.has('launcher')||!args.has('installer')){
  const compileEnv={...process.env,GOCACHE:path.join(root,'go-cache')};
  await run(args.get('go')??'go',['build','-buildvcs=false','-o',path.join(root,'bin')+'/', './cmd/jobctrl','./cmd/jobctrl-installer'],{commandEnv:compileEnv,cwd:path.join(repo,'launcher'),timeout:60000});
 }
 pythonInfo=JSON.parse((await run(python,['-I','-B','-c','import json,sys,sysconfig,pathlib,jobctrl.app.server,jobctrl.app.worker; print(json.dumps({"executable":str(pathlib.Path(sys.executable).resolve()),"base_prefix":sys.base_prefix,"purelib":sysconfig.get_path("purelib"),"version":f"{sys.version_info.major}.{sys.version_info.minor}"}))'])).stdout);
 await cp(path.join(repo,'workers/automation/src/jobctrl'),path.join(root,'application-source'),{recursive:true,filter:source=>!source.split(path.sep).includes('__pycache__')&&!source.endsWith('.pyc')});
 if(custodySelected)await put(path.join(workspace,'.qa-custody'),'owned native process control\n',0o600);
 control=spawn('/bin/sleep',['3600'],{env:{},stdio:'ignore'});
 const first=await payload(1);
 await install(first);installed=true;
 await run(selector,['start','--no-open']);
 const health=await api('/v1/health');assert.equal(health.application,'jobctrl-python');assert.equal(health.worker.status,'healthy');
 const actions=JSON.parse((await run(selector,['actions'])).stdout);assert(Array.isArray(actions.actions)&&actions.actions.length>0,'Installed CLI did not dispatch canonical application actions');
 const state=JSON.parse((await run(selector,['status','--json'])).stdout);await put(path.join(root,'initial-status.json'),JSON.stringify(state,null,2));assert.equal(state.status,'running');
 for(const component of ['temporal','worker','api'])assert.equal(state.components[component].state,'running');
 if(custodySelected){const initialOrphans=await childPids();assert(initialOrphans.length>0,'The owned orphan control never started');for(const pid of initialOrphans)assert(await alive(pid));}
 const settings=await api('/v1/settings');
 await api('/v1/settings','PATCH',{expectedRevision:settings.revision,targetCriteria:'native-original',aiExecutionPolicy:{enabled:false},applyAutomationEnabled:false,compensationAutomationEnabled:false});
 passed('compiled-installer-start-real-python-worker-temporal-and-canonical-cli');
 if(lifecycleSelected)await lifecycle(first,await payload(2));
 if(custodySelected)await custody(first,await payload(lifecycleSelected?3:2));
 const cleanup=await verifyCleanup();
 const required=lifecycleSelected?['coherent-paired-backup-readback-and-restart','explicit-rollback-restores-both-exact-files-before-writers','legacy-start-backup-update-rollback-refuse-with-exact-source-preservation']:[];
 if(custodySelected)required.push('malformed-linked-wrong-boot-receipts-refuse-before-process-or-registry-mutation','owned-new-session-term-ignoring-children-cleaned-after-parents-exit-peer-preserved','failed-start-preserves-live-state-and-resumes-forward-with-correct-pair-receipts');
 for(const name of required)assert(cases.includes(name),`Selected ${suite} suite did not execute ${name}`);
 const report={status:'passed',suite,scriptSha256,root,cases,cleanup,nativeBinaries:{launcherSha256:digest(await readFile(launcher)),installerSha256:digest(await readFile(installer))},databaseIdentity:{applicationId:1245926228,userVersion:1},orphanCount:cleanup.orphanPidsVerifiedAbsent.length,elapsedSeconds:(Date.now()-started)/1000,qualification:'local synthetic payload, real application/runtime; signed/notarized published predecessor remains a distinct release gate'};
 await put(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n',0o600);console.log(JSON.stringify(report,null,2));
}finally{
 if(installed)await run(selector,['stop'],{acceptFailure:true}).catch(()=>{});
 if(control&&control.exitCode===null&&control.signalCode===null){const exited=new Promise(resolve=>control.once('exit',resolve));control.kill('SIGTERM');await exited;}
}
