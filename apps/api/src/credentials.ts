import { spawn } from "node:child_process";

import type { CredentialKey, CredentialsResponse } from "./contracts.js";
import { CredentialKeys } from "./contracts.js";

const KEYCHAIN_SERVICE = "JobCtl";

const LABELS: Record<CredentialKey, string> = {
  OPENAI_API_KEY: "OpenAI API key",
  GEMINI_API_KEY: "Gemini API key",
  LLM_URL: "LLM endpoint",
};

export interface CredentialStore {
  list(): Promise<CredentialsResponse>;
  set(key: CredentialKey, value: string): Promise<CredentialsResponse>;
  delete(key: CredentialKey): Promise<CredentialsResponse>;
}

export class KeychainCredentialStore implements CredentialStore {
  async list(): Promise<CredentialsResponse> {
    const credentials = await Promise.all(
      CredentialKeys.map(async (key) => ({
        key,
        label: LABELS[key],
        configured: await this.exists(key),
        storage: "keychain" as const,
      })),
    );
    return { ok: true, credentials };
  }

  async set(key: CredentialKey, value: string): Promise<CredentialsResponse> {
    await runSecurity(["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key, "-w", value, "-U"]);
    return this.list();
  }

  async delete(key: CredentialKey): Promise<CredentialsResponse> {
    const result = await runSecurity(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key], {
      allowFailure: true,
    });
    if (result.code !== 0 && !result.stderr.includes("could not be found")) {
      throw new Error(result.stderr || `security exited with ${result.code}`);
    }
    return this.list();
  }

  private async exists(key: CredentialKey): Promise<boolean> {
    const result = await runSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key], {
      allowFailure: true,
    });
    return result.code === 0;
  }
}

async function runSecurity(
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode === 0 || options.allowFailure) {
        resolve({ code: exitCode, stderr: stderr.trim(), stdout: stdout.trim() });
        return;
      }
      reject(new Error(stderr.trim() || `security exited with ${exitCode}`));
    });
  });
}
