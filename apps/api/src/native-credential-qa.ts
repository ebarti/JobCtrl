import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { NativeCredentialStore } from "./credentials.js";

const service = `JobCtrl-QA-${randomUUID()}`;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-native-credentials-"));
const configPath = path.join(directory, "config.json");
const key = "ANTHROPIC_API_KEY" as const;
const value = `  jobctrl-native-qa-${randomUUID()}-☃-"  `;
const syntheticEnv: NodeJS.ProcessEnv = {};
for (const name of ["SystemRoot", "WINDIR"] as const) {
  if (process.env[name]) syntheticEnv[name] = process.env[name];
}
const store = new NativeCredentialStore({
  configPath,
  env: syntheticEnv,
  service,
});

try {
  await store.set(key, value);
  const readBack = await store.readForInternalUse(key);
  if (readBack !== value) throw new Error("native credential readback mismatch");
  const response = await store.list();
  const entry = response.credentials.find((candidate) => candidate.key === key);
  if (!entry?.configured || entry.effectiveSource !== "native_store") {
    throw new Error("native credential presence contract failed");
  }
  if (JSON.stringify(response).includes(value)) {
    throw new Error("native credential response exposed a secret");
  }
  await store.delete(key);
  await store.delete(key);
  if (await store.readForInternalUse(key) !== null) {
    throw new Error("native credential delete verification failed");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    nativeStore: response.store.nativeStore,
    presenceOnly: true,
    writeReadDelete: true,
  })}\n`);
} finally {
  try {
    await store.delete(key);
  } catch {
    // The primary sanitized failure remains authoritative.
  }
  fs.rmSync(directory, { force: true, recursive: true });
}
