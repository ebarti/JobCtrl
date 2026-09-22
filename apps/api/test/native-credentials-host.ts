/** Opt-in native-host bridge. Never uses the production credential namespace. */
import fs from "node:fs";
import { KeychainCredentialStore } from "../src/credentials.js";

const request = JSON.parse(fs.readFileSync(0, "utf8")) as {
  service: string;
  configPath: string;
  operation: "set" | "delete" | "list";
  value?: string;
};
if (!/^JobCtrl-QA-[0-9a-f-]{36}$/i.test(request.service)) {
  throw new Error("Native QA requires a unique synthetic namespace");
}
const env: NodeJS.ProcessEnv = {};
for (const key of ["SystemRoot", "WINDIR"]) {
  if (process.env[key]) env[key] = process.env[key];
}
const store = new KeychainCredentialStore({ service: request.service, configPath: request.configPath, env });
try {
  const result = request.operation === "set"
    ? await store.set("GEMINI_API_KEY", request.value ?? "")
    : request.operation === "delete"
      ? await store.delete("GEMINI_API_KEY")
      : await store.list();
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stderr.write("Native QA API adapter failed\n");
  process.exitCode = 1;
}
