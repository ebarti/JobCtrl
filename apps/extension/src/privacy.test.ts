import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_PAGE_MATCHES = new Set(["http://*/*", "https://*/*"]);
const FORBIDDEN_NETWORK_PATTERNS = [/<all_urls>/, /wss?:\/\//, /fetch\(["'`]https?:\/\/(?!127\.0\.0\.1:8766|localhost:8766)/];

describe("extension privacy boundary", () => {
  it("wildcards HTTP(S) page and brokered Discovery network access", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "public/manifest.json"), "utf8")) as {
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: Array<{ matches?: string[] }>;
      content_security_policy?: { extension_pages?: string };
    };

    expect(new Set(manifest.permissions ?? [])).toEqual(
      new Set(["activeTab", "alarms", "declarativeNetRequest", "scripting", "storage"]),
    );
    expect(new Set(manifest.host_permissions ?? [])).toEqual(WEB_PAGE_MATCHES);
    expect(new Set(manifest.content_scripts?.[0]?.matches ?? [])).toEqual(WEB_PAGE_MATCHES);
    expect(manifest.content_security_policy?.extension_pages).toContain("connect-src http: https:");
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
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
