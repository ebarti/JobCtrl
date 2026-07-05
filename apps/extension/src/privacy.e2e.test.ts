import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const DIST = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../dist/extension");
const FORBIDDEN_BUNDLE_PATTERNS = [/<all_urls>/, /https:\/\/\*\//, /fetch\(["'`]https?:\/\/(?!127\.0\.0\.1:8766|localhost:8766)/, /XMLHttpRequest/];

describe("built extension privacy boundary", () => {
  it("keeps the built manifest and bundle loopback-only", () => {
    const files = distFiles(DIST);
    const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8")) as {
      host_permissions?: string[];
      content_security_policy?: { extension_pages?: string };
    };
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1:8766/*", "http://localhost:8766/*"]);
    expect(manifest.content_security_policy?.extension_pages).toContain("connect-src http://127.0.0.1:8766 http://localhost:8766");

    const bundle = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    for (const pattern of FORBIDDEN_BUNDLE_PATTERNS) {
      expect(bundle).not.toMatch(pattern);
    }
  });
});

function distFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return distFiles(target);
    }
    return entry.isFile() ? [target] : [];
  });
}
