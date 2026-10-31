// Establish a source-ownership witness using the real source controller and
// an isolated, synthetic fleet. This never writes a witness itself.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function start(executable, args, env) {
  const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-65536); });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, finished, output: () => output };
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

const fixturePython = `import http.server,json,os,pathlib,socketserver,sqlite3,sys,time
root=pathlib.Path(os.environ['TEST_SOURCE_ROOT'])
state=pathlib.Path(os.environ['JOBCTRL_DIR'])
if sys.argv[1]=='worker':
 (root/'worker.pid').write_text(str(os.getpid()))
 while True: time.sleep(1)
elif sys.argv[1]=='history':
 c=sqlite3.connect(os.environ['TEST_HISTORY_PATH'])
 while True: time.sleep(1)
elif sys.argv[1]=='api':
 class Handler(http.server.BaseHTTPRequestHandler):
  def do_GET(self):
   try: pid=int((root/'worker.pid').read_text())
   except Exception: pid=0
   body=json.dumps({'ok':True,'appDir':str(state),'dbPath':str(state/'jobctrl.db'),'worker':{'status':'healthy','heartbeat':{'pid':pid}}}).encode()
   self.send_response(200); self.end_headers(); self.wfile.write(body)
  def log_message(self,*args): pass
 class Server(http.server.HTTPServer):
  def server_bind(self):
   socketserver.TCPServer.server_bind(self)
   self.server_name,self.server_port='127.0.0.1',self.server_address[1]
 Server(('127.0.0.1',int(os.environ['JOBCTRL_API_PORT'])),Handler).serve_forever()
`;

const fixtureDev = `#!/bin/bash
"$TEST_PYTHON" -B "$TEST_SOURCE_ROOT/fleet.py" worker & worker=$!
"$TEST_PYTHON" -B "$TEST_SOURCE_ROOT/fleet.py" api & api=$!
"$TEST_PYTHON" -B "$TEST_SOURCE_ROOT/fleet.py" history & temporal=$!
printf 'source-ready\\n' >&3
exec 3>&-
trap 'kill "$worker" "$api" "$temporal" 2>/dev/null || :; wait; exit 0' TERM INT
while :; do sleep 1; done
`;

export async function establishSourceOwnership({ sourceBinary, root, runtime, state, history, python, env }) {
  assert.equal(process.platform, "darwin", "source-ownership fixture requires macOS");
  assert.ok(sourceBinary && path.isAbsolute(sourceBinary), "a built source controller is required");
  const temp = await realpath(os.tmpdir());
  const fixture = await realpath(root);
  const runtimeReal = await realpath(runtime), stateReal = await realpath(state), historyReal = await realpath(history);
  assert.ok(inside(temp, fixture) && inside(fixture, runtimeReal) && inside(fixture, stateReal) && inside(stateReal, historyReal),
    "source-ownership fixture must use an isolated temporary workspace");
  assert.equal(await realpath(env.JOBCTRL_RUNTIME_HOME), runtimeReal);
  assert.equal(await realpath(env.JOBCTRL_DIR), stateReal);
  assert.ok(inside(runtimeReal, await realpath(python)), "fixture Python must belong to the released runtime");
  assert.equal(historyReal, await realpath(path.join(stateReal, "temporal", "temporal.db")), "fixture must use legacy source history");
  const sourceRoot = path.join(fixture, "synthetic-source");
  await mkdir(path.join(sourceRoot, "scripts"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(sourceRoot, "workers", "automation", ".venv", "bin"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(sourceRoot, "fleet.py"), fixturePython, { mode: 0o600 });
  await writeFile(path.join(sourceRoot, "scripts", "dev"), fixtureDev, { mode: 0o700 });
  await writeFile(path.join(sourceRoot, "workers", "automation", ".venv", "bin", "python"), '#!/bin/sh\nexec "$TEST_PYTHON" -B "$@"\n', { mode: 0o700 });
  const sourceEnv = { ...env, JOBCTRL_API_HOST: "127.0.0.1", JOBCTRL_API_PORT: String(await freePort()),
    TEST_SOURCE_ROOT: sourceRoot, TEST_PYTHON: python, TEST_HISTORY_PATH: historyReal };
  const id = createHash("sha256").update(stateReal).digest("hex");
  const markers = path.join(runtimeReal, "instances", id, "source-runs");
  const before = await readdir(markers).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  assert.equal(before.length, 0, "synthetic fixture must not start with source ownership");
  const source = start(sourceBinary, ["run", sourceRoot], sourceEnv);
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const entries = await readdir(markers).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
      if (entries.some((name) => name.endsWith(".json"))) break;
      if (source.child.exitCode !== null || source.child.signalCode !== null) throw new Error(`source fixture exited before ownership: ${source.output()}`);
      await delay(100);
    }
    const entries = await readdir(markers).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    assert.ok(entries.some((name) => name.endsWith(".json")), `source fixture did not establish ownership: ${source.output()}`);
    const stop = start(sourceBinary, ["stop", sourceRoot], sourceEnv);
    const stopped = await withTimeout(stop.finished, 45_000, "source fixture stop timed out");
    assert.equal(stopped.code, 0, `source fixture stop failed: ${stop.output()}`);
    await withTimeout(source.finished, 20_000, "source fixture did not exit after stop");
    assert.ok((await readFile(path.join(markers, entries.find((name) => name.endsWith(".json"))), "utf8")).includes(id));
  } finally {
    if (source.child.exitCode === null && source.child.signalCode === null) {
      const stop = start(sourceBinary, ["stop", sourceRoot], sourceEnv);
      await withTimeout(stop.finished, 45_000, "source fixture cleanup timed out").catch(() => stop.child.kill("SIGKILL"));
      if (source.child.exitCode === null && source.child.signalCode === null) source.child.kill("SIGTERM");
      await withTimeout(source.finished, 10_000, "source fixture cleanup did not exit").catch(() => source.child.kill("SIGKILL"));
    }
  }
}
