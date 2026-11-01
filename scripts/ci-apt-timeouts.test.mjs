import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const script=fileURLToPath(new URL("./ci-apt-timeouts.sh",import.meta.url));
test("APT transport guard refuses developer and non-Linux hosts before any sudo call",t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),"jobctrl-ci-apt-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bin=path.join(root,"bin");mkdirSync(bin);
  const sudo=path.join(bin,"sudo"),output=path.join(root,"configuration"),args=path.join(root,"arguments");
  writeFileSync(sudo,'#!/bin/sh\nprintf "%s\\n" "$*" > "$SUDO_ARGUMENTS"\ncat > "$APT_CAPTURE"\n');chmodSync(sudo,0o700);
  const environment={...process.env,PATH:bin+path.delimiter+process.env.PATH,CI:"true",RUNNER_OS:"Linux",RUNNER_ENVIRONMENT:"github-hosted",SUDO_ARGUMENTS:args,APT_CAPTURE:output};
  for(const overrides of [{CI:"false"},{RUNNER_OS:"macOS"},{RUNNER_OS:"Windows"},{RUNNER_ENVIRONMENT:"self-hosted"}]) {
    const result=spawnSync("bash",[script],{env:{...environment,...overrides},encoding:"utf8"});
    assert.notEqual(result.status,0);
    assert.equal(existsSync(args),false);
    assert.equal(existsSync(output),false);
  }
  const accepted=spawnSync("bash",[script],{env:environment,encoding:"utf8"});
  assert.equal(accepted.status,0,accepted.stderr);
  assert.equal(readFileSync(args,"utf8"),"tee /etc/apt/apt.conf.d/80jobctrl-ci-transport\n");
  const config=readFileSync(output,"utf8");
  assert.match(config,/Acquire::http::Timeout "30";/);
  assert.match(config,/Acquire::https::Timeout "30";/);
  assert.match(config,/Acquire::Retries "2";/);
  assert.doesNotMatch(config,/Verify-Peer|AllowInsecure|Unauthenticated|sources\.list|Trusted/i);
});
