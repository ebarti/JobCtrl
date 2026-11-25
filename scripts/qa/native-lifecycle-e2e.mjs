#!/usr/bin/env node
// Real compiled installer/selector + Python HTTP/worker + PostgreSQL/DBOS, with private
// synthetic state. The private interpreter adds one synthetic orphan at its
// executable boundary; no application action/repository is mocked.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {chmod, cp, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, stat, symlink, writeFile} from 'node:fs/promises';
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
assert(['all','lifecycle','custody','reduced','credentials'].includes(suite),'--suite must be all, lifecycle, custody, reduced or credentials');
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
const postgresBin=path.resolve(args.get('postgres-bin') ?? process.env.JOBCTRL_POSTGRES_BIN_DIR ?? path.join(repo,'.dev/postgres-runtime/bin'));
const apiPort=Number(args.get('api-port') ?? '8766');
assert(Number.isInteger(apiPort) && apiPort>1023 && apiPort<=65535);
const launcher=path.resolve(args.get('launcher') ?? path.join(root,'bin/jobctrl'));
const installer=path.resolve(args.get('installer') ?? path.join(root,'bin/jobctrl-installer'));
const env={HOME:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:path.join(root,'tmp'),
  JOBCTRL_RUNTIME_HOME:runtime,JOBCTRL_DIR:workspace,
  JOBCTRL_EXECUTION_QA_SANDBOX:'loopback-only-v1',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'};
if(suite==='reduced')env.JOBCTRL_FEATURES='jobs,contacts,companies';
const selector=path.join(runtime,'bin/jobctrl'), cases=[];
function passed(name){cases.push(name);console.log(JSON.stringify({suite,case:name,status:'passed'}));}
let pythonInfo;
const digest=data=>createHash('sha256').update(data).digest('hex');
const scriptSha256=digest(await readFile(fileURLToPath(import.meta.url)));
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function put(file,data,mode=0o644){await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,data,{mode});await chmod(file,mode);}
async function run(command,argv,{commandEnv=env,cwd=repo,acceptFailure=false,timeout=300000}={}){
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
 const result=await fetch(`http://127.0.0.1:${apiPort}`+route,{method,headers:{origin:`http://127.0.0.1:${apiPort}`,'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value),signal:AbortSignal.timeout(5000)});
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
 const manifestPath=path.join(payload,'launcher','runtime-manifest.json');
 const runtimeManifest=await json(manifestPath);runtimeManifest.ports.api=apiPort;
 await put(manifestPath,JSON.stringify(runtimeManifest));
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
 await cp(path.dirname(postgresBin),path.join(payload,'postgres'),{recursive:true,verbatimSymlinks:true});
 await put(path.join(payload,'node/bin/node'),`#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`,0o755);
 await put(path.join(payload,'web/index.html'),'<!doctype html><title>Owned native lifecycle E2E</title>');
 const files=await buildFileInventory(payload), components=[];
 for(const [id,owned] of [['jobctrl-launcher','launcher'],['jobctrl-web','web'],['jobctrl-worker','worker'],['node-runtime','node'],['postgres-runtime','postgres'],['python-runtime','python']]){
  const summary=summarizeComponentFiles(owned,files);
  components.push({id,classification:'core-runtime',version:'2.0.0',owner:'JobCtrl native E2E',source:'https://example.invalid/owned-native-e2e',license:'AGPL-3.0-only',redistribution:'bundle',path:owned,sha256:summary.sha256,sizeBytes:summary.sizeBytes,required:true});
 }
 const buildId=`local-native-e2e-${String(sequence).padStart(4,'0')}`;
 const manifest={schemaVersion:1,appVersion:'2.0.0',buildId,releaseChannel:'local',sourceDateEpoch:0,platform:{id:'darwin-arm64',os:'darwin',arch:'arm64',minimumOsVersion:'15.0'},launcherCompatibility:{minimum:2,maximum:2},components,capabilities:[{id:'core-browser',defaultEnabled:true,componentIds:['jobctrl-web']}],files,signing:{manifestAlgorithm:'ed25519',manifestKeyId:'local-development',codeSigning:'unsigned-local',notarized:false}};
 const manifestRaw=JSON.stringify(manifest)+'\n';
 await put(path.join(payload,'manifest.json'),manifestRaw);
 await put(path.join(payload,'manifest.sig'),JSON.stringify({schemaVersion:1,status:'unsigned-local',manifestAlgorithm:'ed25519',manifestKeyId:'local-development',signature:null,promotable:false})+'\n');
 const archive=path.join(out,'payload.zip');
 await run('/usr/bin/zip',['-q','-X','-y','-r',archive,'.'],{cwd:payload});
 const archiveBytes=await readFile(archive);
 const descriptor={schemaVersion:1,channel:'local',sequence,minimumSafeSequence:1,revokedBuildIds:[],buildId,appVersion:'2.0.0',platform:{id:'darwin-arm64',os:'darwin',arch:'arm64'},artifact:{url:pathToFileURL(archive).href,sha256:digest(archiveBytes),sizeBytes:archiveBytes.length,archiveType:'zip',manifestSha256:digest(manifestRaw)}};
 await put(path.join(out,'descriptor.json'),JSON.stringify(descriptor)+'\n');
 await put(path.join(out,'descriptor.sig'),JSON.stringify({schemaVersion:1,status:'unsigned-local',algorithm:'ed25519',keyId:'local-development',signature:null})+'\n');
 return {buildId,out,payload};
}
async function install(release,{stage=false,commandEnv=env}={}){return run(installer,['--allow-unsigned-local','--home',runtime,'--descriptor-file',path.join(release.out,'descriptor.json'),'--signature-file',path.join(release.out,'descriptor.sig'),'--archive-file',path.join(release.out,'payload.zip'),'--json',...(stage?['--stage-only']:[])],{commandEnv});}
async function verifyCurlReinstall(candidate) {
  const directory = path.join(root, 'curl-reinstall');
  const user = path.join(directory, 'user');
  const store = path.join(directory, 'runtime');
  const bin = path.join(user, '.local/bin');
  const profile = path.join(user, '.zprofile');
  const command = path.join(bin, 'jobctrl');
  const contract = path.join(directory, 'local-fixture.contract');
  const acquisition = path.join(store, 'acquisition.json');
  const commandEnv = { ...env, HOME: user, SHELL: '/bin/zsh', JOBCTRL_RUNTIME_HOME: store, JOBCTRL_DIR: path.join(directory, 'workspace') };
  await put(profile, '# User profile\n');
  await put(contract, [
    'MODE=local-fixture', 'PLATFORM=darwin-arm64', 'INSTALLER_VERSION=2.0.0',
    'INSTALLER_URL=' + pathToFileURL(installer).href, 'INSTALLER_SHA256=' + digest(await readFile(installer)),
    'DESCRIPTOR_FILE=' + path.join(candidate.out, 'descriptor.json'), 'SIGNATURE_FILE=' + path.join(candidate.out, 'descriptor.sig'),
    'ARCHIVE_FILE=' + path.join(candidate.out, 'payload.zip'), '',
  ].join('\n'));
  const get = path.join(repo, 'scripts/get');
  const args = ['--local-fixture-contract', contract];
  await run(get, args, { commandEnv });
  const before = await readFile(acquisition);
  const initialProfile = await readFile(profile);
  const target = await readlink(command);
  assert.equal(JSON.parse(before).profile, profile);
  await run('/bin/zsh', ['-c', 'source "$1"; shift; exec "$@"', 'test', profile, get, ...args], { commandEnv });
  assert.deepEqual(await readFile(acquisition), before);
  assert.deepEqual(await readFile(profile), initialProfile);
  const refused = await run(get, [...args, '--bin-dir', path.join(directory, 'other')], { commandEnv, acceptFailure: true });
  assert.notEqual(refused.code, 0);
  assert.deepEqual(await readFile(acquisition), before);
  assert.equal(await readlink(command), target);
  await run(command, ['uninstall'], { commandEnv });
  await assert.rejects(readlink(command), { code: 'ENOENT' });
  assert.equal((await readFile(profile, 'utf8')).trim(), '# User profile');
  passed('fresh-shell-reinstall-preserves-owned-exposure-until-uninstall');
}
async function stop(){const result=await run(selector,['stop'],{acceptFailure:true});assert.equal(result.code,0,result.stderr);for(const pid of await childPids())await dead(pid);}

async function liveAuthority(){
 const files=['postgres/active.json','.jobctrl-postgres-identity'].map(name=>path.join(workspace,name)).concat([path.join(runtime,'active.json'),path.join(runtime,'transition.json'),selector]);
 return Object.fromEntries(await Promise.all(files.map(async name=>[name,digest(await readFile(name))])));
}
async function refuseRollback(target,label,reason){
 const before=await liveAuthority();
 const result=await run(selector,['rollback','--to',target.buildId],{acceptFailure:true});
 assert.notEqual(result.code,0,label);if(reason)assert.match(result.stderr,reason);assert.deepEqual(await liveAuthority(),before,label);
 assert(await alive(control.pid),'Refusal affected unrelated process control');
}

function workspaceSql(sql) {
 const socket=path.join('/private/tmp',`jobctrl-pg-${process.getuid()}-${digest(workspace).slice(0,24)}`);
 return run(path.join(postgresBin,'psql'),['-v','ON_ERROR_STOP=1','-XAtw','-h',socket,'-p','5432','-U','jobctrl','-d','jobctrl','-c',sql]);
}

async function acceptedArtifactFixture() {
 const socket=path.join('/private/tmp',`jobctrl-pg-${process.getuid()}-${digest(workspace).slice(0,24)}`);
 const result=await run(python,['-I','-B','-c',`from pathlib import Path
import hashlib,json,sys,uuid,psycopg
root=Path(sys.argv[1])/'resumes-artifacts'; aid=str(uuid.uuid4()); file=root/(aid+'.pdf')
body=b'%PDF-1.4\\n% native cold restore ownership proof\\n%%EOF\\n';file.write_bytes(body); file.chmod(0o600)
def identity(path):
    info=path.stat();return {'device':info.st_dev,'inode':info.st_ino}
artifact={'artifact_id':aid,'filename':file.name,'path':str(file),'size_bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'file_identity':identity(file),'root_identity':identity(root),'resume_id':'qa-resume','revision_id':'qa-revision'}
state={'acceptances':[{'pdf':artifact}],'revisions':[{'renders':[artifact]}],'locales':[]}
with psycopg.connect(host=sys.argv[2],port=5432,user='jobctrl',dbname='jobctrl') as c:
    c.execute("INSERT INTO resumes_documents(resume_id,job_id,version,state_json,updated_at) VALUES('qa-resume','qa-job',1,%s,'2026-11-25T00:00:00Z')",(json.dumps(state),))
    c.execute("INSERT INTO resumes_artifact_retirements(artifact_id,job_id,artifact_json,status,reason,created_at,updated_at) VALUES(%s,'qa-job',%s,'registered','registered_render','2026-11-25T00:00:00Z','2026-11-25T00:00:00Z')",(aid,json.dumps(artifact)))
print(file)`,workspace,socket]);
 return result.stdout.trim();
}

async function raceRollbackWithSettledCall(first){
 await put(path.join(root,'.jobctrl-release-qa'),'jobctrl-release-qa-v1\n',0o600);
 const before=await liveAuthority();
 const oldWorker=(await api('/v1/health')).worker.pid;
 const pause='rollback_prechecked';
 const child=spawn(selector,['rollback','--to',first.buildId],{
  env:{...env,TMPDIR:path.dirname(taskParent),JOBCTRL_RELEASE_QA_ROOT:root,JOBCTRL_RELEASE_QA_PAUSE:pause},
  stdio:['ignore','ignore','pipe'],
 });
 let diagnostics='';
 const ready=new Promise((resolve,reject)=>{
  child.stderr.on('data',bytes=>{diagnostics+=bytes;if(diagnostics.includes('jobctrl-release-qa-checkpoint:'+pause))resolve();});
  child.once('exit',()=>reject(Error('Missing guarded checkpoint: '+diagnostics)));child.once('error',reject);
 });
 const ended=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
 const timeout=setTimeout(()=>{child.kill('SIGCONT');child.kill('SIGTERM');},300000);
 try{
  await ready;
  await workspaceSql("INSERT INTO app_model_calls(receipt_id,operation,provider,model,lane,prompt_version,input_fingerprint,created_at,status,owner_pid,provider_started,input_tokens,output_tokens,cost_usd,cost_source) VALUES('qa-late','native.qa','synthetic','synthetic','interactive','1','hash','2026-11-25T00:00:00Z','completed',0,1,10,10,0.2,'usage')");
  child.kill('SIGCONT');
  assert.notEqual(await ended,0);assert.match(diagnostics,/revert approvals, submission or provider receipts/);
  assert.deepEqual(await liveAuthority(),before);
  const restored=await api('/v1/health');assert.equal(restored.worker.status,'healthy');assert.notEqual(restored.worker.pid,oldWorker);
  const kept=await workspaceSql("SELECT count(*) FROM app_model_calls WHERE receipt_id='qa-late'");assert.equal(kept.stdout.trim(),'1');
  await workspaceSql("DELETE FROM app_model_calls WHERE receipt_id='qa-late'");
 }finally{clearTimeout(timeout);if(child.exitCode===null && child.signalCode===null){child.kill('SIGCONT');child.kill('SIGTERM');await ended;}}
 passed('settlement-between-precheck-and-drain-restarts-previous-release-and-preserves-receipt');
}

async function lifecycle(first,second){
 const artifact=await acceptedArtifactFixture();
 await run(selector,['backup']);
 const backups=(await readdir(path.join(workspace,'backups'))).filter(name=>name.startsWith('pair-'));
 assert.equal(backups.length,1);
 const backup=await json(path.join(workspace,'backups',backups[0],'pair.json'));
 assert.equal(backup.schemaVersion,2);assert.deepEqual(backup.files.map(f=>f.name).sort(),['.jobctrl-postgres-identity','postgres.tar']);
 for(const file of backup.files)assert.equal(digest(await readFile(path.join(workspace,'backups',backup.id,file.name))),file.sha256);
 assert.equal((await api('/v1/settings')).targetCriteria,'native-original');
 passed('coherent-paired-backup-readback-and-restart');
 await install(second,{stage:true});
 const stateBefore=await liveAuthority();
 const workerBefore=(await api('/v1/health')).worker.pid;
 await workspaceSql("INSERT INTO app_action_runs(run_id,action,request_id,input_hash,payload_json,status,workflow_id,created_at,updated_at) VALUES('qa-incompatible','removed.synthetic-action','qa-request','hash','{}','pending','qa-workflow','2026-11-25T00:00:00Z','2026-11-25T00:00:00Z')");
 try{
  const refusal=await run(selector,['update','--to',second.buildId],{acceptFailure:true});
  assert.notEqual(refusal.code,0);assert.match(refusal.stderr,/cannot resume all pending workflows/);
  assert.deepEqual(await liveAuthority(),stateBefore);
  assert.equal((await api('/v1/health')).worker.pid,workerBefore);
 }finally{await workspaceSql("DELETE FROM app_action_runs WHERE run_id='qa-incompatible'");}
 passed('incompatible-durable-command-refuses-update-while-predecessor-serves');
 await run(selector,['update','--to',second.buildId]);
 assert.equal((await json(path.join(runtime,'active.json'))).receipt.buildId,second.buildId);
 assert.equal((await api('/v1/settings')).targetCriteria,'native-original');
 const settings=await api('/v1/settings');await api('/v1/settings','PATCH',{expectedRevision:settings.revision,targetCriteria:'native-after-update'});
 passed('target-update-preserves-accepted-application-state');
 await workspaceSql("INSERT INTO app_model_calls(receipt_id,operation,provider,model,lane,prompt_version,input_fingerprint,created_at,status,owner_pid,provider_started,input_tokens,output_tokens,cost_usd,cost_source) VALUES('qa-settled','native.qa','synthetic','synthetic','interactive','1','hash','2026-11-25T00:00:00Z','completed',0,1,10,10,0.1,'usage')");
 const runningWorker=(await api('/v1/health')).worker.pid;
 try{
  await refuseRollback(first,'settled charged call after retained backup',/revert approvals, submission or provider receipts/);
  assert.equal((await api('/v1/health')).worker.pid,runningWorker);
 }finally{await workspaceSql("DELETE FROM app_model_calls WHERE receipt_id='qa-settled'");}
 passed('settled-charge-since-backup-refuses-rollback-while-current-release-serves');
 await raceRollbackWithSettledCall(first);
 await stop();
 const completed=await json(path.join(runtime,'transition.json'));
 const pairPath=path.join(workspace,'backups',completed.backupId,'pair.json');
 const originalRaw=await readFile(pairPath),original=JSON.parse(originalRaw);
 const appBackup=path.join(workspace,'backups',original.id,'postgres.tar'),savedBackup=await readFile(appBackup);
 await writeFile(appBackup,Buffer.concat([savedBackup,Buffer.from('owned changed backup')]));
 try{await refuseRollback(first,'changed paired backup');}finally{await writeFile(appBackup,savedBackup);}
 for(const change of [pair=>{pair.workspaceId='0'.repeat(64);},pair=>{pair.id='../unowned';},pair=>{pair.files[1]={...pair.files[0]};}]){
  const changed=JSON.parse(originalRaw);change(changed);await writeFile(pairPath,JSON.stringify(changed));
  try{await refuseRollback(first,'invalid pair authority');}finally{await writeFile(pairPath,originalRaw);}
 }
 passed('changed-legacy-duplicate-unsafe-pairs-refuse-before-live-or-journal-mutation');
 const retained=artifact+'.qa-preserved';
 await rename(artifact,retained);
 try{
  await refuseRollback(first,'retired accepted PDF',/missing, changed or unverified resume artifacts/);
  await cp(retained,artifact);
  await refuseRollback(first,'replaced PDF inode with identical bytes',/missing, changed or unverified resume artifacts/);
 }finally{
  await rm(artifact,{force:true});
  await rename(retained,artifact);
 }
 passed('rollback-rejects-missing-and-replaced-accepted-pdf-before-selection');
 const prior=await json(path.join(workspace,'postgres/active.json'));
 await run(selector,['rollback','--to',first.buildId]);
 const restored=await json(path.join(workspace,'postgres/active.json'));
 assert.notEqual(restored.generation,prior.generation);
 assert.equal(await readFile(path.join(workspace,'postgres',prior.generation,'PG_VERSION'),'utf8'),'17\n');
 assert.equal((await api('/v1/settings')).targetCriteria,'native-original');
 assert.equal((await api('/v1/health')).dbos.available,true);
 passed('explicit-rollback-restores-postgres-and-dbos-with-previous-generation-preserved');
 await stop();
}

async function reducedLifecycle(first,second) {
 const absent=await workspaceSql("SELECT count(*) FROM app_feature_schemas WHERE name IN ('applications','outreach','resumes')");
 assert.equal(absent.stdout.trim(),'0');
 await run(selector,['backup']);
 await install(second,{stage:true});
 await run(selector,['update','--to',second.buildId]);
 const settings=await api('/v1/settings');
 await api('/v1/settings','PATCH',{expectedRevision:settings.revision,targetCriteria:'after-reduced-update'});
 const worker=(await api('/v1/health')).worker.pid;
 for(const [seed,cleanup] of [
  ["INSERT INTO app_feature_schemas VALUES ('applications','invalid')","DELETE FROM app_feature_schemas WHERE name='applications'"],
  ["CREATE TABLE resumes_documents (id INTEGER)","DROP TABLE resumes_documents"],
 ]){
  await workspaceSql(seed);
  try{
   await refuseRollback(first,'incomplete optional feature owner',/unverifiable PostgreSQL accounting/);
   assert.equal((await api('/v1/health')).worker.pid,worker);
  }finally{await workspaceSql(cleanup);}
 }
 passed('reduced-feature-rollback-refuses-incomplete-and-unregistered-owners');
 await run(selector,['rollback','--to',first.buildId]);
 assert.equal((await api('/v1/settings')).targetCriteria,'native-original');
 assert.equal((await api('/v1/health')).dbos.available,true);
 passed('reduced-feature-backup-and-rollback-restores-postgres-and-dbos');
}

async function stoppedCredentialMigration(){
 const token=digest(root+' credential helper'),secret=digest(root+' synthetic value');
 const file=path.join(workspace,'migration-input.env'),marker=path.join(workspace,'.native-credentials-migrated.json');
 const store=path.join(workspace,'synthetic-key-store.json'),helper=path.join(workspace,'credential-helper.py');
 const stable='QA_NON_SECRET=preserved\n';
 await put(path.join(workspace,'.jobctrl-e2e-owned.json'),JSON.stringify({version:1,workspace,token}),0o600);
 await put(file,stable+'ANTHROPIC_API_KEY='+secret+'\n',0o600);
 await put(helper,`import json,os,pathlib,sys
path=pathlib.Path(__file__).with_name('synthetic-key-store.json')
op,key=sys.argv[1:]
entries=json.loads(path.read_text()) if path.exists() else {}
if op in ('inspect','read'):
    if key not in entries: raise SystemExit(44)
    if op=='read': sys.stdout.write(entries[key])
    raise SystemExit(0)
if op=='set': entries[key]=sys.stdin.read()
elif op=='delete': entries.pop(key,None)
else: raise SystemExit(72)
with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as writer: json.dump(entries,writer)
`,0o700);
 const commandEnv={...env,JOBCTRL_SYNTHETIC_BOUNDARIES:'1',JOBCTRL_E2E_TOKEN:token,JOBCTRL_E2E_CREDENTIAL_HELPER:helper};
 const args=['credentials','migrate','--env-file',file,'--marker',marker];
 const before=await api('/v1/settings');
 const refusal=await run(selector,args,{commandEnv,acceptFailure:true});
 assert.notEqual(refusal.code,0);assert.match(refusal.stderr,/stop the JobCtrl workspace/);
 await assert.rejects(stat(marker),{code:'ENOENT'}); await assert.rejects(stat(store),{code:'ENOENT'});
 await stop();
 const selection=await json(path.join(workspace,'postgres/active.json'));
 const socket=path.join('/private/tmp',`jobctrl-pg-${process.getuid()}-${digest(workspace).slice(0,24)}`);
 async function stopped(){
  assert.equal(JSON.parse((await run(selector,['status','--json'])).stdout).status,'stopped');
  await assert.rejects(stat(path.join(workspace,'postgres',selection.generation,'postmaster.pid')),{code:'ENOENT'});
  await assert.rejects(stat(path.join(socket,'.s.PGSQL.5432')),{code:'ENOENT'});
  await freePort(apiPort);
 }
 await put(marker,'malformed synthetic marker\n',0o600);
 const invalid=await run(selector,args,{commandEnv,acceptFailure:true});
 assert.notEqual(invalid.code,0);await stopped();
 assert.equal(await readFile(marker,'utf8'),'malformed synthetic marker\n');
 await assert.rejects(stat(store),{code:'ENOENT'});await rm(marker);
 await run(selector,args,{commandEnv});
 await stopped();assert.equal(await readFile(file,'utf8'),stable);
 assert.equal((await json(store)).ANTHROPIC_API_KEY,secret);assert(!(await readFile(marker,'utf8')).includes(secret));
 const snapshot=async()=>Promise.all([file,marker,store].map(async f=>[digest(await readFile(f)),(await stat(f)).mtimeMs]));
 const first=await snapshot();
 const second=await run(selector,args,{commandEnv});
 assert.match(second.stdout,/already completed/i);assert.deepEqual(await snapshot(),first);
 await stopped();
 await run(selector,['start','--no-open']);
 assert.equal((await api('/v1/settings')).revision,before.revision+1);
 assert.equal((await workspaceSql("SELECT count(*) FROM app_events WHERE event_type='CredentialsUpdated'")).stdout.trim(),'1');
 await stop();
 passed('stopped-credential-migration-records-one-revision-and-event-and-retries-with-all-services-stopped');
}

async function legacyAdmission(first,candidate){
 const legacy=path.join(root,'legacy');await mkdir(legacy,{mode:0o700});
 await run(python,['-I','-B','-c',`import pathlib,sqlite3,sys
p=pathlib.Path(sys.argv[1]);c=sqlite3.connect(p/'jobctrl.db');c.execute('CREATE TABLE legacy_profile(value TEXT)');c.execute("INSERT INTO legacy_profile VALUES ('owned source')");c.execute('PRAGMA user_version=15');c.commit();c.close();(p/'jobctrl.db').chmod(0o644)
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
 assert.notEqual(admission.code,0,'Installer selected legacy data');
 assert.match(admission.stderr,/requires explicit Profile-only transfer/);
 assert.deepEqual(await tree(legacy),before);
 assert.equal((await stat(path.join(legacy,'jobctrl.db'))).mode & 0o777,0o644);
 for(const selected of ['active.json','transition.json','bin/jobctrl'])await assert.rejects(stat(path.join(refusedHome,selected)),{code:'ENOENT'});
 passed('installer-first-selection-refuses-legacy-before-selector-or-journal-publication');
 await run(selector,['stop'],{commandEnv:legacyEnv});assert.deepEqual(await tree(legacy),before);
 passed('legacy-start-backup-update-rollback-refuse-with-exact-source-preservation');

 const current = path.join(workspace,'postgres','active.json');
 const currentMode = (await stat(current)).mode & 0o777;
 await chmod(current,0o644);
 try {
  const result = await run(selector,['start','--no-open'],{acceptFailure:true});
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/private owned regular path/);
 } finally {
  await chmod(current,currentMode);
 }
 passed('nonprivate-python-database-cannot-start');
}

async function upgradeCurrentWorkspace(){
 const predecessor=path.join(root,'sqlite-predecessor');
 const sourceWorkspace=path.join(root,'current-python-workspace');
 const archive=path.join(root,'sqlite-predecessor.tar');
 await mkdir(predecessor,{mode:0o700});
 await run('/usr/bin/git',['archive','--format=tar','--output',archive,'f8e329d2dda0ac44599c9a4f281cff459d0b7868','workers/automation/src/jobctrl']);
 await run('/usr/bin/tar',['-xf',archive,'-C',predecessor]);
 await run(python,[path.join(repo,'workers/automation/scripts/qa_postgres_upgrade_source.py'),'--checkout',predecessor,'--workspace',sourceWorkspace]);
 const before=digest(await readFile(path.join(sourceWorkspace,'jobctrl.db')));
 const targetEnv={...env,JOBCTRL_DIR:sourceWorkspace};
 try{
  await run(selector,['start','--no-open'],{commandEnv:targetEnv});
  assert.equal((await api('/v1/settings')).revision,3);
  assert.equal((await api('/v1/health')).dbos.available,true);
  const socket=path.join('/private/tmp',`jobctrl-pg-${process.getuid()}-${digest(sourceWorkspace).slice(0,24)}`);
  const result=await run(path.join(postgresBin,'psql'),['-XAtw','-h',socket,'-p','5432','-U','jobctrl','-d','jobctrl','-c',"SELECT count(*) FROM app_events WHERE event_type='SyntheticUpgrade' AND event_id=1"]);
  assert.equal(result.stdout.trim(),'1');
 }finally{await run(selector,['stop'],{commandEnv:targetEnv});}
 assert.equal(digest(await readFile(path.join(sourceWorkspace,'jobctrl.db'))),before);
 assert.equal((await stat(path.join(sourceWorkspace,'jobctrl.db'))).mode & 0o777,0o400);
 passed('current-python-import-keeps-original-and-verifies-source-event-through-postgres');
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
 const failedJournal=await json(path.join(runtime,'transition.json'));assert.equal(failedJournal.preserveLiveOnFailure,true);assert.equal(failedJournal.sourceSchemaVersion,2);
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
 const socket=path.join('/private/tmp',`jobctrl-pg-${process.getuid()}-${digest(workspace).slice(0,24)}`);
 const psql=sql=>run(path.join(postgresBin,'psql'),['-XAtw','-h',socket,'-p','5432','-U','jobctrl','-d','jobctrl','-c',sql]);
 await psql("INSERT INTO app_model_calls(receipt_id,operation,provider,model,lane,prompt_version,input_fingerprint,created_at,status,owner_pid,provider_started) VALUES('native-owned-uncertain','native.qa','codex','synthetic','interactive','1',repeat('a',64),'2026-11-06T00:00:00Z','uncertain',0,1)");
 try{await refuseRollback(first,'unresolved provider accounting');}finally{
  await psql("DELETE FROM app_model_calls WHERE receipt_id='native-owned-uncertain'");
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
 for(const port of [apiPort])await freePort(port);
 assert(await alive(control.pid),'Native cleanup affected unrelated process control');
 const cleanup={status:'passed',suite,stoppedRegistries,executionRegistries,remainingExecutionReceipts:0,orphanPidsVerifiedAbsent:pids,ports:[apiPort]};
 await put(path.join(root,'cleanup-proof.json'),JSON.stringify(cleanup,null,2)+'\n',0o600);
 passed('selected-suite-cleanup-retired-owned-receipts-and-released-fixed-ports');
 return cleanup;
}

const started=Date.now();let installed=false,control;
try{
 for(const port of [apiPort])await freePort(port);
 if(!args.has('launcher')||!args.has('installer')){
  const compileEnv={...process.env,GOCACHE:path.join(root,'go-cache')};
  await run(args.get('go')??'go',['build','-buildvcs=false','-ldflags',`-X github.com/ebarti/jobctrl/launcher/internal/launcher.manifestAPIPort=${apiPort}`,'-o',path.join(root,'bin')+'/', './cmd/jobctrl','./cmd/jobctrl-installer'],{commandEnv:compileEnv,cwd:path.join(repo,'launcher'),timeout:60000});
 }
 pythonInfo=JSON.parse((await run(python,['-I','-B','-c','import json,sys,sysconfig,pathlib,jobctrl.app.server,jobctrl.app.worker; print(json.dumps({"executable":str(pathlib.Path(sys.executable).resolve()),"base_prefix":sys.base_prefix,"purelib":sysconfig.get_path("purelib"),"version":f"{sys.version_info.major}.{sys.version_info.minor}"}))'])).stdout);
 await cp(path.join(repo,'workers/automation/src/jobctrl'),path.join(root,'application-source'),{recursive:true,filter:source=>!source.split(path.sep).includes('__pycache__')&&!source.endsWith('.pyc')});
 if(custodySelected)await put(path.join(workspace,'.qa-custody'),'owned native process control\n',0o600);
 control=spawn('/bin/sleep',['3600'],{env:{},stdio:'ignore'});
 const first=await payload(1);
 if(lifecycleSelected)await verifyCurlReinstall(first);
 await install(first);installed=true;
 await run(selector,['start','--no-open']);
 const health=await api('/v1/health');assert.equal(health.application,'jobctrl-python');assert.equal(health.worker.status,'healthy');
 const actions=JSON.parse((await run(selector,['actions'])).stdout);assert(Array.isArray(actions.actions)&&actions.actions.length>0,'Installed CLI did not dispatch canonical application actions');
 const state=JSON.parse((await run(selector,['status','--json'])).stdout);await put(path.join(root,'initial-status.json'),JSON.stringify(state,null,2));assert.equal(state.status,'running');
 for(const component of ['postgres','worker','api'])assert.equal(state.components[component].state,'running');
 if(custodySelected){const initialOrphans=await childPids();assert(initialOrphans.length>0,'The owned orphan control never started');for(const pid of initialOrphans)assert(await alive(pid));}
 const settings=await api('/v1/settings');
 await api('/v1/settings','PATCH',{expectedRevision:settings.revision,targetCriteria:'native-original',aiExecutionPolicy:{enabled:false},applyAutomationEnabled:false,compensationAutomationEnabled:false});
 passed('compiled-installer-start-real-python-worker-postgres-dbos-and-canonical-cli');
 const second=lifecycleSelected?await payload(2):null;
 if(lifecycleSelected)await lifecycle(first,second);
 if(suite==='reduced')await reducedLifecycle(first,await payload(2));
 if(custodySelected)await custody(first,await payload(lifecycleSelected?3:2));
 if(suite==='credentials'||suite==='reduced'||suite==='all')await stoppedCredentialMigration();
 if(lifecycleSelected){
  // Deliberately refused legacy instances have no published runtime state.
  // Run this negative fixture after successful release-retention scenarios.
  await stop();
  await legacyAdmission(first,second);
  await upgradeCurrentWorkspace();
 }
 const cleanup=await verifyCleanup();
 const required=lifecycleSelected?['coherent-paired-backup-readback-and-restart','explicit-rollback-restores-postgres-and-dbos-with-previous-generation-preserved','legacy-start-backup-update-rollback-refuse-with-exact-source-preservation']:[];
 if(custodySelected)required.push('malformed-linked-wrong-boot-receipts-refuse-before-process-or-registry-mutation','owned-new-session-term-ignoring-children-cleaned-after-parents-exit-peer-preserved','failed-start-preserves-live-state-and-resumes-forward-with-correct-pair-receipts');
 for(const name of required)assert(cases.includes(name),`Selected ${suite} suite did not execute ${name}`);
 const report={status:'passed',suite,scriptSha256,root,cases,cleanup,nativeBinaries:{launcherSha256:digest(await readFile(launcher)),installerSha256:digest(await readFile(installer))},databaseIdentity:{engine:'postgresql',schemaVersion:2,workflow:'dbos'},orphanCount:cleanup.orphanPidsVerifiedAbsent.length,elapsedSeconds:(Date.now()-started)/1000,qualification:'local synthetic payload, real application/runtime; signed/notarized published predecessor remains a distinct release gate'};
 await put(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n',0o600);console.log(JSON.stringify(report,null,2));
}finally{
 if(installed)await run(selector,['stop'],{acceptFailure:true}).catch(()=>{});
 if(control&&control.exitCode===null&&control.signalCode===null){const exited=new Promise(resolve=>control.once('exit',resolve));control.kill('SIGTERM');await exited;}
}
