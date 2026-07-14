import fs from "node:fs";

import {
  ProviderConfigurationKeys,
  SecretCredentialKeys,
} from "@jobctrl/contracts";
import { describe, expect, it } from "vitest";

import {
  KEYCHAIN_ACCOUNT_MAPPING,
  KEYCHAIN_COMMAND_TIMEOUT_MS,
  KEYCHAIN_REQUIRES_WORKER_RESTART,
  KEYCHAIN_SECURITY_BINARY,
  KEYCHAIN_SERVICE,
} from "../src/credentials.js";

function pythonString(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name} = ["']([^"']+)["']$`, "m"));
  if (!match?.[1]) {
    throw new Error(`Missing Python string constant ${name}`);
  }
  return match[1];
}

function pythonBoolean(source: string, name: string): boolean {
  const match = source.match(new RegExp(`^${name} = (True|False)$`, "m"));
  if (!match?.[1]) {
    throw new Error(`Missing Python boolean constant ${name}`);
  }
  return match[1] === "True";
}

function pythonTuple(source: string, name: string): string[] {
  const match = source.match(new RegExp(`^${name} = \\(([\\s\\S]*?)^\\)`, "m"));
  if (!match?.[1]) {
    throw new Error(`Missing Python tuple ${name}`);
  }
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map(
    (item) => item[1] ?? "",
  );
}

function pythonNumber(source: string, name: string): number {
  const match = source.match(new RegExp(`^${name} = (\\d+(?:\\.\\d+)?)$`, "m"));
  if (!match?.[1]) {
    throw new Error(`Missing Python number constant ${name}`);
  }
  return Number(match[1]);
}

describe("TypeScript/Python Keychain contract parity", () => {
  it("keeps secret and non-secret provider key ownership aligned", () => {
    const pythonSource = fs.readFileSync(
      new URL(
        "../../../workers/automation/src/jobctrl/config.py",
        import.meta.url,
      ),
      "utf8",
    );

    expect(pythonString(pythonSource, "KEYCHAIN_SERVICE")).toBe(
      KEYCHAIN_SERVICE,
    );
    expect(pythonString(pythonSource, "KEYCHAIN_SECURITY_BINARY")).toBe(
      KEYCHAIN_SECURITY_BINARY,
    );
    expect(pythonTuple(pythonSource, "KEYCHAIN_PROVIDER_KEYS")).toEqual([
      ...SecretCredentialKeys,
    ]);
    expect(pythonTuple(pythonSource, "PROVIDER_CONFIGURATION_KEYS")).toEqual([
      ...ProviderConfigurationKeys,
    ]);
    expect(pythonString(pythonSource, "KEYCHAIN_ACCOUNT_MAPPING")).toBe(
      KEYCHAIN_ACCOUNT_MAPPING,
    );
    expect(
      pythonBoolean(pythonSource, "KEYCHAIN_REQUIRES_WORKER_RESTART"),
    ).toBe(KEYCHAIN_REQUIRES_WORKER_RESTART);
    expect(
      pythonNumber(pythonSource, "KEYCHAIN_LOOKUP_TIMEOUT_SECONDS") * 1_000,
    ).toBe(KEYCHAIN_COMMAND_TIMEOUT_MS);
    expect(KEYCHAIN_ACCOUNT_MAPPING).toBe("key");
    expect(KEYCHAIN_REQUIRES_WORKER_RESTART).toBe(true);
  });
});
