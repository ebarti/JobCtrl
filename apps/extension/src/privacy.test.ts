import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SUPPORTED_ATS_HOST_PERMISSIONS } from "./ats";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOOPBACK_PERMISSIONS = new Set(["http://127.0.0.1:8766/*", "http://localhost:8766/*"]);
const FORBIDDEN_NETWORK_PATTERNS = [/https:\/\/\*\//, /<all_urls>/, /wss?:\/\//, /fetch\(["'`]https?:\/\/(?!127\.0\.0\.1:8766|localhost:8766)/];

describe("extension privacy boundary", () => {
  it("limits manifest network reach to loopback origins", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "public/manifest.json"), "utf8")) as {
      host_permissions?: string[];
      content_scripts?: Array<{ matches?: string[] }>;
      content_security_policy?: { extension_pages?: string };
    };

    expect(new Set(manifest.host_permissions ?? [])).toEqual(LOOPBACK_PERMISSIONS);
    expect(new Set(manifest.content_scripts?.[0]?.matches ?? [])).toEqual(new Set(SUPPORTED_ATS_HOST_PERMISSIONS));
    expect(manifest.content_security_policy?.extension_pages).toContain("connect-src http://127.0.0.1:8766 http://localhost:8766");
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
    expect(JSON.stringify(manifest)).not.toContain("https://*/*");
  });

  it("does not introduce non-loopback network literals in extension sources", () => {
    const source = [path.join(ROOT, "popup.html"), ...sourceFiles(path.join(ROOT, "src"))]
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    for (const pattern of FORBIDDEN_NETWORK_PATTERNS) {
      expect(source).not.toMatch(pattern);
    }
  });
});

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(target);
    }
    return entry.isFile() && /\.(ts|html|css)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
      ? [target]
      : [];
  });
}
