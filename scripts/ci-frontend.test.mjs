import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runFrontendLanes, selectedFrontend } from "./ci-frontend.mjs";

const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const recipe=(name,source)=>({name,run:quote(process.execPath)+" --input-type=module -e "+quote(source)});
const imports='import {writeFile,readFile,appendFile} from "node:fs/promises";import path from "node:path";';
const all={web:true,storybook:true,e2e:true,extension:true,docs:true,demo:true};
async function owned(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),"jobctrl-ci-lanes-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,directory:root,logDirectory:path.join(root,"logs"),environment:{...process.env,TASK_TEST_ROOT:root,RUNNER_TEMP:root}};
}

test("frontend selection defaults to coverage and refuses malformed exclusions",()=>{
  assert.deepEqual(selectedFrontend({}),all);
  assert.equal(selectedFrontend({CI_WEB:"false"}).web,false);
  for(const value of ["0","FALSE","","false\n"]) assert.throws(()=>selectedFrontend({CI_WEB:value}));
});

test("three independent lanes overlap without waiting for peer completion",async t=>{
  const fixture=await owned(t);
  const barrier=lane=>recipe(lane,imports+`
    const root=process.env.TASK_TEST_ROOT;
    await writeFile(path.join(root,${JSON.stringify(lane)}),"ready");
    const end=Date.now()+4000;
    for(;;) {
      const ready=await Promise.all(["browser","core","support"].map(name=>readFile(path.join(root,name)).then(()=>true,()=>false)));
      if(ready.every(Boolean)) break;
      if(Date.now()>end) throw Error("peer lanes did not overlap");
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    console.log("barrier passed");`);
  assert.equal(await runFrontendLanes({...fixture,selected:all,recipes:{e2e:[barrier("browser")],web:[barrier("core")],storybook:[barrier("support")]}}),true);
  const outcomes=JSON.parse(await readFile(path.join(fixture.logDirectory,"outcomes.json"),"utf8"));
  assert.equal(outcomes.results.length,3);
  assert.ok(outcomes.results.every(result=>result.passed));
});

test("a failed suite cannot hide its failure or suppress independent boundary and peer diagnostics",async t=>{
  const fixture=await owned(t);
  const append=name=>recipe(name,imports+`await appendFile(path.join(process.env.TASK_TEST_ROOT,"ran"),${JSON.stringify(name+"\n")});`);
  const result=await runFrontendLanes({...fixture,selected:all,recipes:{
    web:[recipe("web-fails","process.exit(23)"),append("dependent-web-skipped")],
    boundary:[append("boundary")],e2e:[append("e2e")],
    storybook:[recipe("storybook-fails","process.exit(24)")],extension:[append("extension")],docs:[append("docs")],demo:[append("demo")],
  }});
  assert.equal(result,false);
  assert.deepEqual((await readFile(path.join(fixture.root,"ran"),"utf8")).trim().split("\n").sort(),["boundary","demo","docs","e2e","extension"]);
  const outcomes=JSON.parse(await readFile(path.join(fixture.logDirectory,"outcomes.json"),"utf8"));
  assert.deepEqual(outcomes.results.filter(result=>!result.passed).map(result=>result.code).sort(),[23,24]);
});

test("an unfinished production build serializes diagnostics and keeps the result failed",async t=>{
  const fixture=await owned(t);
  fixture.environment.CI_ROUTES_READY="false";
  const log=name=>recipe(name,imports+`await appendFile(path.join(process.env.TASK_TEST_ROOT,"order"),${JSON.stringify(name+"\n")});`);
  assert.equal(await runFrontendLanes({...fixture,selected:all,recipes:{e2e:[log("browser")],web:[log("core")],boundary:[log("boundary")],storybook:[log("support")]}}),false);
  assert.equal(await readFile(path.join(fixture.root,"order"),"utf8"),"browser\ncore\nboundary\nsupport\n");
});

test("spawn errors fail closed while peer diagnostics finish; existing evidence is preserved",async t=>{
  const fixture=await owned(t);
  const invalid={...recipe("missing-working-directory","process.exit(0)"),"working-directory":"missing"};
  assert.equal(await runFrontendLanes({...fixture,selected:all,recipes:{web:[invalid],boundary:[],e2e:[recipe("peer","process.exit(0)")]}}),false);
  const previous=await readFile(path.join(fixture.logDirectory,"outcomes.json"),"utf8");
  assert.equal(JSON.parse(previous).errors.length,1);
  await assert.rejects(runFrontendLanes({...fixture,selected:all,recipes:{}}),{code:"EEXIST"});
  assert.equal(await readFile(path.join(fixture.logDirectory,"outcomes.json"),"utf8"),previous);
});

test("browser entry refuses an ordinary developer environment before creating any output",()=>{
  const script=fileURLToPath(new URL("./ci-frontend.mjs",import.meta.url));
  const result=spawnSync(process.execPath,[script],{env:{...process.env,CI:"false",RUNNER_ENVIRONMENT:""},encoding:"utf8"});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/isolated GitHub-hosted Linux runner/);
});
