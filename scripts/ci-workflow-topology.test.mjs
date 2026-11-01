import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SURFACES, SUITE_CONTEXTS, selectSurfaces } from "./pr-ci-routing.mjs";
import { frontendRecipes } from "./ci-frontend-recipes.mjs";
import { frontendLanes } from "./ci-frontend.mjs";

const yamlReader = "require 'yaml'; require 'json'; puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases:true))";
const load = name => JSON.parse(execFileSync("ruby", ["-e", yamlReader, fileURLToPath(new URL("../.github/workflows/" + name + ".yml", import.meta.url))], { encoding: "utf8" }));
const pr = load("ci");
const admission = load("ci-admission").jobs.preflight;
const backend = load("ci-backend").jobs.checks;
const frontend = load("ci-frontend").jobs.checks;
const actionPath = fileURLToPath(new URL("../.github/actions/worker-checks/action.yml", import.meta.url));
const worker = JSON.parse(execFileSync("ruby", ["-e", yamlReader, actionPath], { encoding: "utf8" })).runs;

const events = workflow => workflow.on ?? workflow.true;
const expression = value => "$" + "{{ " + value + " }}";
const command = (job, text) => job.steps.find(step => step.run === text);
test("one shared entry budgets affected runners and preserves literal skipped native contexts", () => {
  assert.deepEqual(events(pr), { pull_request:{ types:["opened","synchronize","reopened","edited"] }, push:{ branches:["main"] } });
  assert.deepEqual(Object.keys(pr.jobs).sort(), ["admission","backend","frontend","support","browser","native","credentials","gmail","preview"].sort());
  assert.deepEqual(pr.permissions, { contents:"read" });
  assert.equal(pr.concurrency["cancel-in-progress"], expression("github.event_name == 'pull_request'"));
  const expanded=[];
  for (const id of ["admission","backend","frontend","support","browser","native","credentials","gmail"]) {
    const call=pr.jobs[id];
    assert.equal(call.if, undefined, "skipped child contexts must remain materialized");
    assert.equal(call["runs-on"], undefined);
    assert.equal(call.steps, undefined);
    assert.equal(call.secrets, undefined);
    assert.equal(call.environment, undefined);
    if(id!=="admission") assert.equal(call.needs,"admission");
    const child=load(call.uses.split("/").at(-1).replace(".yml",""));
    assert.deepEqual(child.permissions,{contents:"read"});
    for(const job of Object.values(child.jobs)) {
      expanded.push(call.name+" / "+job.name);
      assert.equal(job.strategy,undefined,"skipping a matrix cannot emit every required child context");
      assert.equal(job["continue-on-error"] ?? false,false);
      for(const step of job.steps) assert.equal(step["continue-on-error"] ?? false,false,step.name);
      if(["native","credentials","gmail"].includes(id)) assert.equal(job.if,expression("github.event_name == 'workflow_dispatch' || inputs.enabled"));
    }
    for(const [flag,value] of Object.entries(call.with ?? {})) {
      if(typeof value==="boolean") { assert.equal(value,false); continue; }
      const output=flag==="enabled"?({native:"launcher",credentials:"credentials",gmail:"gmail"}[id]):flag;
      assert.equal(value,expression("needs.admission.outputs."+output+" != 'false'"));
    }
  }
  assert.equal(expanded.length,11,"five core and six platform-specific allocations at full scope");
  assert.equal(new Set(expanded).size,expanded.length);
  assert.deepEqual(expanded.sort(), [...new Set(["Admission / Release check","Backend / Core checks",...Object.values(SUITE_CONTEXTS).flat()])].sort());
  const owners={api:["backend","api"],python:["backend","python"],distribution:["backend","distribution"],edge:["backend","edge"],
    web:["frontend","web"],storybook:["support","storybook"],extension:["support","extension"],docs:["support","docs"],demo:["support","demo"],
    e2e:["browser","e2e"],launcher:["native","enabled"],credentials:["credentials","enabled"],gmail:["gmail","enabled"]};
  assert.deepEqual(Object.keys(owners).sort(),[...SURFACES].sort());
  for(const [surface,[owner,input]] of Object.entries(owners))
    assert.equal(pr.jobs[owner].with[input],expression("needs.admission.outputs."+surface+" != 'false'"),surface+" must retain a fail-closed owner");
  assert.equal(pr.jobs.frontend.with.e2e,false,"E2E has an isolated VM");
  assert.equal(pr.jobs.browser.with.web,false);
  assert.equal(pr.jobs.browser.with.storybook,false);
  assert.equal(admission.if,undefined);
  assert.equal(backend.if,undefined,"repository contracts run for every verified change");
  assert.equal(frontend.if,expression("inputs.web || inputs.storybook || inputs.e2e || inputs.extension || inputs.docs || inputs.demo"));
  assert.deepEqual(Object.keys(admission.outputs).sort(),[...SURFACES,"head_privacy","preview"].sort());
});

test("privacy and scope are base-only; bootstrap has no exclusion authority", () => {
  const job=admission;
  assert.equal(job["timeout-minutes"], 5);
  const checkout=job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, expression("github.sha"));
  assert.equal(checkout.with["fetch-depth"], 2);
  assert.equal(checkout.with["persist-credentials"], false);
  const resolve=job.steps.find(step => step.id==="policy");
  assert.match(resolve.run, /git fetch --no-tags --depth=2 origin/);
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
  assert.deepEqual(bootstrapNames.sort(), [...new Set(["Admission / Release check","Backend / Core checks",...Object.values(SUITE_CONTEXTS).flat()])].sort());
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
  const run=admission.steps.find(step=>step.id==="scope").run;
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

test("pristine candidate privacy precedes installation; independent diagnostics survive peer failure", () => {
  const scan=command(backend,"python -I scripts/release_check.py --strict-prompt");
  const setup=backend.steps.find(step=>step.uses?.startsWith("pnpm/action-setup@"));
  const install=command(backend,"corepack pnpm install --frozen-lockfile");
  const scripts=command(backend,"corepack pnpm scripts:test");
  assert.equal(scan.if,expression("inputs.head_privacy"));
  assert.ok(backend.steps.indexOf(scan)<backend.steps.indexOf(setup));
  assert.ok(backend.steps.indexOf(setup)<backend.steps.indexOf(install));
  assert.ok(backend.steps.indexOf(install)<backend.steps.indexOf(scripts));
  assert.equal(scripts.if,undefined);
  assert.equal(scripts["timeout-minutes"],10);
  assert.equal(frontendRecipes.web[0].run,"corepack pnpm web:lint");
  assert.equal(frontendRecipes.boundary[0].run,"corepack pnpm web:lint:test");
  assert.deepEqual(frontendLanes.core,["web"]);
  assert.deepEqual(frontendLanes.browsers,["e2e"]);
  assert.deepEqual(frontendLanes.support,["boundary","storybook","extension","docs","demo"]);
  const profile=command(frontend,"node scripts/ci-frontend.mjs");
  assert.equal(profile.if,expression("!cancelled() && steps.dependencies.outcome == 'success'"));
  assert.equal(command(frontend,"corepack pnpm web:build"),undefined,"the web build belongs to its original ordered recipe");
  assert.equal(frontendRecipes.web.at(-1).run,"corepack pnpm web:build");
  for(const id of ["frontend","support","browser"]) {
    const flags=pr.jobs[id].with;
    const profiles=[flags.web!==false,flags.e2e!==false,["storybook","extension","docs","demo"].some(key=>flags[key]!==false)];
    assert.equal(profiles.filter(Boolean).length,1,id+" must select only its own resource profile");
  }
  const laneArtifact=frontend.steps.find(step=>step.name==="Retain frontend profile logs and outcomes");
  assert.equal(laneArtifact.with.name,"frontend-lanes-${{ inputs.e2e && 'browser' || inputs.web && 'web' || 'support' }}-${{ github.run_attempt }}");
  assert.equal(frontend.steps.filter(step=>step.run?.includes("pnpm install")).length,1);
  const chromium=frontend.steps.find(step=>step.run?.includes("playwright install --with-deps chromium"));
  assert.equal(chromium.if,expression("inputs.storybook || inputs.e2e || inputs.extension || inputs.docs"),"web-only verification must not install browser dependencies");
});

test("backend and manual Python share the complete primary locked recipe", () => {
  const job=load("python").jobs.python;
  assert.deepEqual(events(load("python")),{workflow_dispatch:null});
  assert.equal(job.env.PYTHON_VERSION,"3.12");
  assert.equal(job.env.UV_PYTHON,"3.12");
  assert.equal(job.env.PYTHONFAULTHANDLER,"1");
  assert.deepEqual(backend.env,job.env);
  const shared=backend.steps.find(step=>step.uses==="./.github/actions/worker-checks");
  assert.equal(shared.if,expression("inputs.python"));
  assert.ok(job.steps.some(step=>step.uses==="./.github/actions/worker-checks"));
  assert.ok(command(backend,"uv --project workers/automation sync --locked --all-extras"));
  assert.equal(worker.using,"composite");
  assert.ok(command(worker,"uv --project workers/automation run --locked --all-extras ruff check workers/automation/src workers/automation/tests"));
  assert.ok(command(worker,"uv --project workers/automation run --locked --all-extras python scripts/generate-semantic-result-schemas.py --check"));
  assert.ok(command(worker,'uv --project workers/automation run --locked --all-extras pytest workers/automation/tests -q -n 2 --dist=loadfile --max-worker-restart=0 --durations=25 --junitxml="$RUNNER_TEMP/python-$PYTHON_VERSION.xml"'));
  assert.ok(command(worker,"uv --project workers/automation run --locked --all-extras python -m build --no-isolation workers/automation"));
  assert.equal(command(worker,"bash scripts/install-temporal-test-server.sh").name,"Install verified Temporal time-skipping test server");
  assert.equal(worker.steps.find(step=>step.name==="Upload synthetic Python JUnit report").if,"always()");
  const network=command(worker,"bash scripts/ci-apt-timeouts.sh");
  const chromium=worker.steps.find(step=>step.name==="Install Chromium for guarded availability regression");
  assert.ok(network && worker.steps.indexOf(network)<worker.steps.indexOf(chromium));
  assert.match(chromium.run,/^timeout --signal=TERM --kill-after=15s 8m uv .*playwright install --with-deps chromium$/);
  const frontendNetwork=command(frontend,"bash scripts/ci-apt-timeouts.sh");
  for(const step of frontend.steps.filter(step=>step.run?.includes("playwright install"))) {
    assert.ok(frontend.steps.indexOf(frontendNetwork)<frontend.steps.indexOf(step));
    assert.equal(step["timeout-minutes"],8);
  }

  for(const step of worker.steps) {
    if(step.run) assert.equal(step.shell,"bash");
    assert.equal(step["continue-on-error"] ?? false,false,step.name);
  }
});

test("main has one core owner and retains separately gated site publications and manual diagnostics", () => {
  for(const name of ["typescript","python","repo-scripts","release-check","launcher","native-credentials","gmail-token-windows","distribution","demo-edge"]){
    const on=events(load(name));
    assert.equal(on.pull_request,undefined,name);
    assert.equal(on.push,undefined,name+" must not duplicate core main checks");
    assert.ok(Object.hasOwn(on,"workflow_dispatch"),name);
  }
  for(const name of ["docs-site","demo-site"]){
    const on=events(load(name));
    assert.equal(on.pull_request,undefined,name);
    assert.deepEqual(on.push.branches,["main"]);
  }
  assert.deepEqual(pr.jobs.preview.needs,["admission","frontend","support"]);
  assert.match(pr.jobs.preview.if,/needs\.admission\.outputs\.preview == 'true'/);
  assert.match(pr.jobs.preview.if,/head\.repo\.full_name == github\.repository/);
  assert.match(pr.jobs.preview.if,/vars\.DEMO_PREVIEW_DEPLOY_ENABLED == 'true'/);
  assert.match(load("docs-site").jobs.deploy.if,/github\.ref == 'refs\/heads\/main'/);
  assert.equal(load("demo-site").jobs.production.environment,"demo-production");
  assert.equal(load("typescript").jobs.api.uses,"./.github/workflows/ci-backend.yml");
  assert.equal(load("typescript").jobs.frontend.uses,"./.github/workflows/ci-frontend.yml");
});

test("manual TypeScript diagnostics cannot duplicate automatic required check names", () => {
  const contexts = workflow => Object.values(workflow.jobs).flatMap(call => {
    if (!call.uses) return [];
    const child = load(call.uses.split("/").at(-1).replace(".yml", ""));
    return Object.values(child.jobs).map(job => call.name + " / " + job.name);
  });
  const automatic = new Set(contexts(pr));
  const manual = contexts(load("typescript"));
  assert.equal(manual.length, 4, "all four manual profiles remain available");
  assert.equal(new Set(manual).size, manual.length);
  for (const name of manual) assert.equal(automatic.has(name), false, name);
});

test("both E2E modes publish distinct JUnit evidence and retain first-open screenshots", () => {
  const job=frontend;
  const isolated=frontendRecipes.e2e.find(step=>step.name==="Test web end-to-end");
  const rpc=frontendRecipes.e2e.find(step=>step.name==="Test real API and worker RPC boundaries");
  assert.equal(isolated.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE,expression("runner.temp")+"/e2e-isolated.xml");
  assert.equal(rpc.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE,expression("runner.temp")+"/e2e-real-rpc.xml");
  assert.match(rpc.run,/accepted-material-exports\.spec\.ts/);
  assert.match(rpc.run,/offer-outcomes\.spec\.ts/);
  const screenshots=job.steps.find(step=>step.name==="Upload synthetic first-connection screenshots");
  assert.match(screenshots.with.path,/e2e-isolated\.xml\.artifacts\/\*\*\/first-open-/);
  assert.match(screenshots.with.path,/e2e-real-rpc\.xml\.artifacts\/\*\*\/first-open-/);
  assert.match(screenshots.if,/always\(\).*inputs.e2e/);
  assert.match(job.steps.find(step=>step.name==="Upload synthetic E2E JUnit reports").if,/always\(\).*inputs.e2e/);
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
  const run=admission.steps.find(step=>step.name==="Scan the whole candidate with the accepted privacy policy").run;
  const result=spawnSync("bash",["-c",run],{cwd:candidate,encoding:"utf8",env:{...process.env,POLICY_DIRECTORY:policy,GITHUB_WORKSPACE:candidate}});
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stdout,/resume\.pdf: private\/runtime file should not be committed/);
  assert.throws(()=>readFileSync(marker),{code:"ENOENT"});
});

test("full scope and stale-base web changes cannot authorize static preview", context=>{
  const temporary=mkdtempSync(path.join(os.tmpdir(),"jobctrl-preview-scope-"));
  context.after(()=>rmSync(temporary,{recursive:true,force:true}));
  const repository=path.join(temporary,"repo");mkdirSync(repository);
  const gitEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_")));
  const developerHome=path.join(temporary,"developer-home");mkdirSync(developerHome);
  writeFileSync(path.join(developerHome,".gitconfig"),"[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n");
  Object.assign(gitEnv,{HOME:developerHome,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"});
  const git=(...args)=>execFileSync("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgsign=false","-C",repository,...args],{env:gitEnv,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git("init","-q");git("config","user.name","Synthetic CI");git("config","user.email","ci@example.invalid");
  const web="apps/web/src/preview.ts",worker="workers/automation/src/jobctrl/native_credentials.py";
  for(const file of [web,worker]){mkdirSync(path.dirname(path.join(repository,file)),{recursive:true});writeFileSync(path.join(repository,file),"base");}
  git("add",".");git("commit","-qm","synthetic base");const original=git("rev-parse","HEAD");
  git("checkout","-qb","worker-change");writeFileSync(path.join(repository,worker),"worker change");git("commit","-qam","synthetic worker");
  git("checkout","-qb","updated-base",original);writeFileSync(path.join(repository,web),"accepted base web change");git("commit","-qam","synthetic updated base");const base=git("rev-parse","HEAD");
  git("merge","--no-ff","-qm","synthetic merge","worker-change");
  const step=admission.steps.find(step=>step.id==="preview"),run=step.run;
  assert.equal(step.env.ADMITTED_AFFECTED,expression("steps.scope.outputs.head_privacy == 'false'"));
  const check=(merge,affected="true")=>{
    const output=path.join(temporary,"output");writeFileSync(output,"");
    const result=spawnSync("bash",["-c",run],{cwd:repository,encoding:"utf8",env:{...gitEnv,PR_BASE_SHA:base,GITHUB_SHA:merge,GITHUB_OUTPUT:output,ADMITTED_AFFECTED:affected}});
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
