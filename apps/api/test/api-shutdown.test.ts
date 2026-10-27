import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { getDefaultJsonRpcDispatcher, resetDefaultJsonRpcDispatcher, SubprocessJsonRpcAdapter } from "../src/json-rpc-adapter.js";
import { shutdownApi } from "../src/shutdown.js";
import { initializeExactDatabase } from "./exact-schema.js";

it("drains an admitted RPC before exit and rejects later admission", async () => {
  const adapter = new SubprocessJsonRpcAdapter({
    pythonRuntime: { id: "owned-shutdown-rpc", resolve: () => ({
      executable: process.execPath, cwd: os.tmpdir(), env: process.env,
      argv: ["-e", `let request; process.stdin.setEncoding('utf8');
        process.stdin.on('data', data => { request=JSON.parse(data); });
        process.stdin.on('end', () => setTimeout(() => {
          console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{status:'succeeded',pdfPath:request.params.pdfPath}}));
        }, 50));`],
    }) },
  });
  try {
    const call = adapter.call("render_resume_pdf", { htmlPath: "/synthetic/in.html", pdfPath: "/synthetic/out.pdf" });
    const drain = adapter.drain();
    await expect(adapter.call("render_resume_pdf", { htmlPath: "/synthetic/in.html", pdfPath: "/synthetic/out.pdf" })).rejects.toThrow("closed");
    await expect(call).resolves.toMatchObject({ result: { pdfPath: "/synthetic/out.pdf" } });
    await expect(drain).resolves.toBeUndefined();
  } finally { await adapter.close(); }
});

it("reports an RPC drain timeout without declaring the child stopped", async () => {
  const adapter = new SubprocessJsonRpcAdapter({
    pythonRuntime: { id: "owned-shutdown-hang", resolve: () => ({
      executable: process.execPath, cwd: os.tmpdir(), env: process.env,
      argv: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
    }) },
  });
  const call = adapter.call("render_resume_pdf", { htmlPath: "/synthetic/in.html", pdfPath: "/synthetic/out.pdf" });
  const failedCall = expect(call).rejects.toThrow();
  try {
    await expect(adapter.drain(100)).rejects.toThrow("did not drain");
  } finally {
    await adapter.close();
    await failedCall;
  }
});

it("fences and drains RPC even when a close hook fails", async () => {
  const app = Fastify();
  app.addHook("onClose", async () => { throw new Error("synthetic close failure"); });
  const adapter = getDefaultJsonRpcDispatcher({
    pythonRuntime: { id: "owned-shutdown-failed-close", resolve: () => ({
      executable: process.execPath, cwd: os.tmpdir(), env: process.env,
      argv: ["-e", `const readline=require('node:readline');
        readline.createInterface({input:process.stdin}).on('line', line => {
          const request=JSON.parse(line);
          console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{status:'succeeded',pdfPath:request.params.pdfPath}}));
        });`],
    }) },
  });
  const input = { htmlPath: "/synthetic/in.html", pdfPath: "/synthetic/out.pdf" };
  try {
    await adapter.call("render_resume_pdf", input);
    await expect(shutdownApi(app)).rejects.toThrow("API shutdown did not complete cleanly");
    await expect(adapter.call("render_resume_pdf", input)).rejects.toThrow("closed");
    expect(() => getDefaultJsonRpcDispatcher()).toThrow("shutting down");
  } finally { resetDefaultJsonRpcDispatcher(); }
});

it("reports a held HTTP request as an incomplete shutdown and fences RPC", async () => {
  const app = Fastify();
  let release!: () => void;
  let markStarted!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  app.get("/synthetic-preview", async () => {
    markStarted();
    await held;
    return { ok: true };
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = fetch(`${address}/synthetic-preview`);
  try {
    await started;
    await expect(shutdownApi(app, 100)).rejects.toThrow("API shutdown did not complete cleanly");
    expect(() => getDefaultJsonRpcDispatcher()).toThrow("shutting down");
    release();
    await expect(request).resolves.toMatchObject({ ok: true });
  } finally {
    release();
    app.server.closeAllConnections();
    resetDefaultJsonRpcDispatcher();
  }
});

it("drains a live event stream on SIGTERM through the real API entry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-shutdown-"));
  initializeExactDatabase(path.join(directory, "jobctrl.db"));
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve("src/main.ts")], {
    cwd: path.resolve("."),
    env: { ...process.env, JOBCTRL_DIR: directory, JOBCTRL_API_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { log += chunk; });
  child.stderr.resume();
  try {
    const deadline = Date.now() + 10_000;
    while (!/Server listening at http:\/\/127\.0\.0\.1:(\d+)/.test(log) && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`API exited before listening: ${child.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const port = /Server listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(log)?.[1];
    if (!port) throw new Error("API did not listen on its owned ephemeral port");
    const response = await fetch(`http://127.0.0.1:${port}/v1/events/stream`);
    expect(response.ok).toBe(true);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const [code, signal] = await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("API shutdown timed out")), 5000))]);
    expect([code, signal]).toEqual([0, null]);
    expect((await reader.read()).done).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "close");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
