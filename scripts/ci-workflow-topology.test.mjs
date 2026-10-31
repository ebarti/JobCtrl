import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SURFACES, SUITE_CONTEXTS, selectSurfaces } from "./pr-ci-routing.mjs";

const yamlReader = "require 'yaml'; require 'json'; puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases:true))";
const load = name => JSON.parse(execFileSync("ruby", ["-e", yamlReader, fileURLToPath(new URL("../.github/workflows/" + name + ".yml", import.meta.url))], { encoding: "utf8" }));
const pr = load("pr-ci");
const events = workflow => workflow.on ?? workflow.true;
const expression = value => "$" + "{{ " + value + " }}";
const command = (job, text) => job.steps.find(step => step.run === text);
const leaves = { api:"api", web:"web", storybook:"storybook", e2e:"e2e", extension:"extension", python311:"python", python312:"python", python313:"python", docs:"docs", launcher0:"launcher", launcher1:"launcher", "credentials-macos":"credentials", "credentials-windows":"credentials", "credentials-ubuntu":"credentials", gmail:"gmail", distribution:"distribution", demo:"demo", edge:"edge" };
const required = ["Release check","Script unit tests","Build (dead-link gate)","API checks and tests","Web unit, types, and build","Storybook build and browser tests","Web end-to-end","Browser extension","Python 3.11","Python 3.12","Python 3.13"];

test("native admission retains every required name without a planner or final-gate runner", () => {
  assert.deepEqual(events(pr), { pull_request:{ types:["opened","synchronize","reopened","edited"] } });
  assert.deepEqual(Object.keys(pr.jobs).sort(), ["preflight","scripts",...Object.keys(leaves),"preview"].sort());
  assert.deepEqual(pr.permissions, { contents:"read" });
  assert.equal(pr.concurrency["cancel-in-progress"], true);
  const names = Object.values(pr.jobs).map(job => job.name);
  for (const name of required) assert.equal(names.filter(item => item === name).length, 1, name);
  assert.equal(pr.jobs.preflight.if, undefined);
  assert.equal(pr.jobs.preflight.needs, undefined);
  assert.equal(pr.jobs.scripts.if, undefined);
  assert.equal(pr.jobs.scripts.needs, "preflight");
  for (const [id,suite] of Object.entries(leaves)) {
    const job=pr.jobs[id];
    assert.equal(job.needs, "preflight");
    assert.equal(job.if, expression("needs.preflight.result == 'success' && needs.preflight.outputs." + suite + " != 'false'"));
    assert.equal(job.permissions, undefined);
    assert.equal(job.environment, undefined);
    assert.equal(job["continue-on-error"] ?? false, false);
    for (const step of job.steps) assert.equal(step["continue-on-error"] ?? false, false, step.name);
  }
  assert.deepEqual(Object.keys(pr.jobs.preflight.outputs).sort(), [...SURFACES,"head_privacy","preview"].sort());
  const expanded = ["Release check","Script unit tests",...Object.values(SUITE_CONTEXTS).flat()].sort();
  assert.equal(new Set(expanded).size, expanded.length);
  assert.deepEqual(expanded, Object.entries(pr.jobs).filter(([id]) => id !== "preview").map(([,job]) => job.name).sort());
});

test("privacy and scope are base-only; bootstrap has no exclusion authority", () => {
  const job=pr.jobs.preflight;
  assert.equal(job["timeout-minutes"], 5);
  const checkout=job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, expression("github.sha"));
  assert.equal(checkout.with["fetch-depth"], 2);
  assert.equal(checkout.with["persist-credentials"], false);
  const resolve=job.steps.find(step => step.id==="policy");
  assert.match(resolve.run, /git fetch --no-tags --depth=1 origin/);
  assert.match(resolve.run, /git archive "\$policy_sha" scripts\/release_check\.py/);
  assert.match(resolve.run, /git show "\$policy_sha:scripts\/pr-ci-routing\.mjs"/);
  const scan=job.steps.find(step => step.name==="Scan the whole candidate with the accepted privacy policy");
  assert.match(scan.run, /python -I/);
  assert.match(scan.run, /Path\(os\.environ\["POLICY_DIRECTORY"\]\).*scripts\/release_check\.py/);
  assert.match(scan.run, /module\.ROOT = Path\(os\.environ\["GITHUB_WORKSPACE"\]\)/);
  assert.match(scan.run, /module\.main\(\["--strict-prompt"\]\)/);
  assert.equal(job.steps.find(step => step.name==="Sync only the accepted privacy test tools")["working-directory"],expression("steps.policy.outputs.directory"));
  assert.equal(job.steps.find(step => step.name==="Sync only the accepted privacy test tools").run, 'uv --project "$POLICY_DIRECTORY/workers/automation" sync --locked --only-group release-check');
  const selfTest=job.steps.find(step => step.name==="Test the accepted privacy policy in isolation");
  assert.equal(selfTest["working-directory"], expression("steps.policy.outputs.directory"));
  assert.match(selfTest.run, /--locked --only-group release-check pytest.*--noconftest/);
  assert.equal(selfTest.env.PYTEST_DISABLE_PLUGIN_AUTOLOAD, "1");
  const scope=job.steps.find(step => step.id==="scope");
  assert.ok(job.steps.indexOf(scope)>job.steps.indexOf(selfTest));
  assert.equal(scope.env.EMIT_SCOPE_NOTICE, expression("github.job == 'preflight'"));
  assert.match(scope.run, /node "\$POLICY_DIRECTORY\/scripts\/pr-ci-routing\.mjs"/);
  assert.match(scope.run, /mode: 'full', reason: 'bootstrap'/);
  assert.match(scope.run, /headPrivacy: true/);
  assert.match(scope.run, /JobCtrl CI scope v1/);
  const bootstrapNames=JSON.parse(scope.run.match(/const names = (\[[^\n]+\]);/)[1]);
  assert.deepEqual(bootstrapNames.sort(), ["Release check","Script unit tests",...Object.values(SUITE_CONTEXTS).flat()].sort());
  const bootstrapSuites=JSON.parse(scope.run.match(/const suites = (\[[^\n]+\]);/)[1]);
  assert.deepEqual(bootstrapSuites.sort(), [...SURFACES].sort());
  assert.doesNotMatch(JSON.stringify(job), /corepack|pnpm install|secrets\.|pull_request_target/);
});

test("bootstrap binds the actual merge parents while synchronize metadata can retain the preceding preview", context=>{
  const temporary=mkdtempSync(path.join(os.tmpdir(),"jobctrl-bootstrap-identity-"));
  context.after(()=>rmSync(temporary,{recursive:true,force:true}));
  const repository=path.join(temporary,"repo"),policy=path.join(temporary,"accepted-policy");
  mkdirSync(repository);mkdirSync(policy);
  const git=(...args)=>execFileSync("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgsign=false","-C",repository,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git("init","-q","-b","main");git("config","user.name","Synthetic CI");git("config","user.email","ci@example.invalid");
  writeFileSync(path.join(repository,"text"),"base");git("add",".");git("commit","-qm","synthetic base");const base=git("rev-parse","HEAD");
  git("checkout","-qb","candidate");writeFileSync(path.join(repository,"text"),"candidate");git("commit","-qam","synthetic candidate");const head=git("rev-parse","HEAD");
  git("checkout","-q","main");git("merge","--no-ff","-qm","synthetic tested merge","candidate");const merge=git("rev-parse","HEAD");
  const repo={id:42,full_name:"synthetic/JobCtrl",default_branch:"main"};
  const event={number:17,repository:repo,pull_request:{number:17,base:{ref:"main",sha:base,repo},head:{sha:head,repo},merge_commit_sha:base}};
  const eventPath=path.join(temporary,"event.json"),output=path.join(temporary,"output");
  const run=pr.jobs.preflight.steps.find(step=>step.id==="scope").run;
  const check=(overrides={})=>{
    writeFileSync(eventPath,JSON.stringify(event));writeFileSync(output,"");
    return spawnSync("bash",["-c",run],{cwd:repository,encoding:"utf8",env:{...process.env,
      GITHUB_EVENT_PATH:eventPath,GITHUB_EVENT_NAME:"pull_request",GITHUB_WORKSPACE:repository,
      GITHUB_REPOSITORY:repo.full_name,GITHUB_REPOSITORY_ID:String(repo.id),GITHUB_REF:"refs/pull/17/merge",
      GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",GITHUB_SHA:merge,GITHUB_OUTPUT:output,
      POLICY_DIRECTORY:policy,POLICY_COMMIT:base,EMIT_SCOPE_NOTICE:"true",...overrides}});
  };
  for(const metadata of [null,base]){
    event.pull_request.merge_commit_sha=metadata;
    const result=check();assert.equal(result.status,0,result.stderr);
    assert.deepEqual(readFileSync(output,"utf8").trim().split("\n").sort(),[...SURFACES,"head_privacy"].map(name=>name+"=true").sort());
    const notice=JSON.parse(result.stdout.split("::notice title=JobCtrl CI scope v1::")[1]);
    assert.equal(notice.mergeSha,merge);assert.deepEqual(notice.base,{ref:"main",sha:base});assert.equal(notice.head.sha,head);
  }
  assert.notEqual(check({GITHUB_SHA:head}).status,0);
  assert.equal(readFileSync(output,"utf8"),"");
  event.pull_request.head.sha=base;
  assert.notEqual(check().status,0);
  assert.equal(readFileSync(output,"utf8"),"");
});

test("pristine head privacy precedes tooling; boundary diagnostics remain independent of Storybook failures", () => {
  const job=pr.jobs.scripts;
  const scan=command(job,"python -I scripts/release_check.py --strict-prompt");
  const setup=job.steps.find(step=>step.uses?.startsWith("pnpm/action-setup@"));
  const install=command(job,"corepack pnpm install --frozen-lockfile");
  const scripts=command(job,"corepack pnpm scripts:test");
  assert.equal(scan.if,expression("needs.preflight.outputs.head_privacy != 'false'"));
  assert.ok(job.steps.indexOf(scan)<job.steps.indexOf(setup));
  assert.ok(job.steps.indexOf(setup)<job.steps.indexOf(install));
  assert.ok(job.steps.indexOf(install)<job.steps.indexOf(scripts));
  assert.equal(scripts.if,undefined);
  assert.equal(scripts["timeout-minutes"],10);
  assert.equal(command(job,"corepack pnpm web:lint:test"),undefined);
  assert.equal(command(pr.jobs.web,"corepack pnpm web:lint:test"),undefined);
  const boundary=command(pr.jobs.storybook,"corepack pnpm web:lint:test");
  assert.equal(boundary.if,expression("!cancelled() && steps.dependencies.outcome == 'success'"));
  assert.equal(command(pr.jobs.storybook,"corepack pnpm install --frozen-lockfile").id,"dependencies");
  assert.ok(pr.jobs.storybook.steps.indexOf(boundary)>pr.jobs.storybook.steps.findIndex(step=>step.name==="Test Storybook"));
  assert.equal(command(pr.jobs.web,"corepack pnpm web:lint").if,undefined);
  const legacy=load("typescript").jobs;
  assert.deepEqual(pr.jobs.web.steps,legacy.web.steps.filter(step=>step.name!=="Test frontend boundary regression controls"));
  const story=structuredClone(pr.jobs.storybook.steps.filter(step=>step.name!=="Test frontend boundary regression controls"));
  delete story.find(step=>step.name==="Install locked dependencies").id;
  assert.deepEqual(story,legacy.storybook.steps);
  assert.deepEqual(pr.jobs.e2e.steps,legacy.e2e.steps);

});

test("three literal Python results share the complete locked version-specific recipe", () => {
  const legacy=load("python").jobs.python;
  assert.deepEqual(legacy.strategy,{"fail-fast":false,matrix:{"python-version":["3.11","3.12","3.13"]}});
  for(const version of ["3.11","3.12","3.13"]){
    const job=pr.jobs["python"+version.replace(".","")];
    assert.equal(job.name,"Python "+version);
    assert.equal(job.env.PYTHON_VERSION,version);
    assert.equal(job.strategy,undefined);
    assert.deepEqual(job.steps,pr.jobs.python311.steps);
    const normalize=steps=>JSON.stringify(steps).replaceAll(expression("matrix.python-version"),version).replaceAll(expression("env.PYTHON_VERSION"),version).replaceAll("$PYTHON_VERSION",version);
    assert.equal(normalize(job.steps),normalize(legacy.steps));
    assert.match(job.steps.find(step=>step.name==="Test").run,/pytest workers\/automation\/tests -q -n 2 --dist=loadfile --max-worker-restart=0 --durations=25 --junitxml=/);
  }
});

test("main/manual bodies stay intact without duplicate PR execution or expanded deployment access", () => {
  for(const name of ["typescript","python","docs-site","repo-scripts","release-check","launcher","native-credentials","gmail-token-windows","distribution","demo-edge","demo-site"]){
    const on=events(load(name));
    assert.equal(on.pull_request,undefined,name);
    assert.ok(Object.hasOwn(on,"workflow_dispatch"),name);
    if(on.push) assert.deepEqual(on.push.branches,["main"]);
  }
  for(const [oldName,oldId,newId] of [["typescript","api","api"],["typescript","extension","extension"],["docs-site","build","docs"],["native-credentials","native","credentials-macos"],["gmail-token-windows","private-token","gmail"],["distribution","audit","distribution"],["demo-site","build","demo"],["demo-edge","edge","edge"]])
    assert.deepEqual(pr.jobs[newId].steps,load(oldName).jobs[oldId].steps,newId+" retains every product step");
  assert.deepEqual(pr.jobs.preview.needs,["preflight","demo"]);
  assert.match(pr.jobs.preview.if,/needs\.preflight\.outputs\.preview == 'true'/);
  assert.match(pr.jobs.preview.if,/head\.repo\.full_name == github\.repository/);
  assert.match(pr.jobs.preview.if,/vars\.DEMO_PREVIEW_DEPLOY_ENABLED == 'true'/);
  assert.match(load("docs-site").jobs.deploy.if,/github\.ref == 'refs\/heads\/main'/);
  assert.equal(load("demo-site").jobs.production.environment,"demo-production");
});

test("both E2E modes publish distinct JUnit evidence and retain first-open screenshots", () => {
  const job=pr.jobs.e2e;
  const isolated=job.steps.find(step=>step.name==="Test web end-to-end");
  const rpc=job.steps.find(step=>step.name==="Test real API and worker RPC boundaries");
  assert.equal(isolated.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE,expression("runner.temp")+"/e2e-isolated.xml");
  assert.equal(rpc.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE,expression("runner.temp")+"/e2e-real-rpc.xml");
  assert.match(rpc.run,/accepted-material-exports\.spec\.ts/);
  assert.match(rpc.run,/offer-outcomes\.spec\.ts/);
  const screenshots=job.steps.find(step=>step.name==="Upload synthetic first-connection screenshots");
  assert.match(screenshots.with.path,/e2e-isolated\.xml\.artifacts\/\*\*\/first-open-/);
  assert.match(screenshots.with.path,/e2e-real-rpc\.xml\.artifacts\/\*\*\/first-open-/);
  assert.equal(screenshots.if,"always()");
  assert.equal(job.steps.find(step=>step.name==="Upload synthetic E2E JUnit reports").if,"always()");
});

test("accepted scanner executes against candidate files without importing candidate policy", context=>{
  const temporary=mkdtempSync(path.join(os.tmpdir(),"jobctrl-pr-privacy-"));
  context.after(()=>rmSync(temporary,{recursive:true,force:true}));
  const policy=path.join(temporary,"policy"),candidate=path.join(temporary,"candidate");
  mkdirSync(path.join(policy,"scripts"),{recursive:true});
  mkdirSync(path.join(candidate,"scripts"),{recursive:true});
  copyFileSync(fileURLToPath(new URL("./release_check.py",import.meta.url)),path.join(policy,"scripts/release_check.py"));
  const marker=path.join(temporary,"candidate-executed");
  writeFileSync(path.join(candidate,"scripts/release_check.py"),"from pathlib import Path\\nPath("+JSON.stringify(marker)+").write_text('wrong authority')\\n");
  writeFileSync(path.join(candidate,"resume.pdf"),"synthetic forbidden artifact");
  execFileSync("git",["init","-q",candidate]);
  execFileSync("git",["-C",candidate,"add","."]);
  const run=pr.jobs.preflight.steps.find(step=>step.name==="Scan the whole candidate with the accepted privacy policy").run;
  const result=spawnSync("bash",["-c",run],{cwd:candidate,encoding:"utf8",env:{...process.env,POLICY_DIRECTORY:policy,GITHUB_WORKSPACE:candidate}});
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stdout,/resume\.pdf: private\/runtime file should not be committed/);
  assert.throws(()=>readFileSync(marker),{code:"ENOENT"});
});

test("full scope and stale-base web changes cannot authorize static preview", context=>{
  const temporary=mkdtempSync(path.join(os.tmpdir(),"jobctrl-preview-scope-"));
  context.after(()=>rmSync(temporary,{recursive:true,force:true}));
  const repository=path.join(temporary,"repo");mkdirSync(repository);
  const git=(...args)=>execFileSync("git",["-C",repository,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git("init","-q");git("config","user.name","Synthetic CI");git("config","user.email","ci@example.invalid");
  const web="apps/web/src/preview.ts",worker="workers/automation/src/jobctrl/native_credentials.py";
  for(const file of [web,worker]){mkdirSync(path.dirname(path.join(repository,file)),{recursive:true});writeFileSync(path.join(repository,file),"base");}
  git("add",".");git("commit","-qm","synthetic base");const original=git("rev-parse","HEAD");
  git("checkout","-qb","worker-change");writeFileSync(path.join(repository,worker),"worker change");git("commit","-qam","synthetic worker");
  git("checkout","-qb","updated-base",original);writeFileSync(path.join(repository,web),"accepted base web change");git("commit","-qam","synthetic updated base");const base=git("rev-parse","HEAD");
  git("merge","--no-ff","-qm","synthetic merge","worker-change");
  const step=pr.jobs.preflight.steps.find(step=>step.id==="preview"),run=step.run;
  assert.equal(step.env.ADMITTED_AFFECTED,expression("steps.scope.outputs.head_privacy == 'false'"));
  const check=(merge,affected="true")=>{
    const output=path.join(temporary,"output");writeFileSync(output,"");
    const result=spawnSync("bash",["-c",run],{cwd:repository,encoding:"utf8",env:{...process.env,PR_BASE_SHA:base,GITHUB_SHA:merge,GITHUB_OUTPUT:output,ADMITTED_AFFECTED:affected}});
    assert.equal(result.status,0,result.stderr);return readFileSync(output,"utf8");
  };
  assert.equal(selectSurfaces([{status:"M",path:worker},{status:"M",path:web}]).mode,"full");
  assert.equal(check(git("rev-parse","HEAD")),"preview_allowed=false\n");
  git("checkout","-qb","web-change",base);writeFileSync(path.join(repository,web),"PR web change");git("commit","-qam","synthetic web");
  git("checkout","--detach","-q",base);git("merge","--no-ff","-qm","synthetic web merge","web-change");
  assert.equal(check(git("rev-parse","HEAD")),"preview_allowed=true\n");
  assert.equal(check(git("rev-parse","HEAD"),"false"),"preview_allowed=false\n");
  assert.equal(check("0".repeat(40)),"preview_allowed=false\n");
});
