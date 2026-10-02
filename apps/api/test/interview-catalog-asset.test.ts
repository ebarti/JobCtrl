import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InterviewCatalogAssetError, loadInterviewCatalogAsset } from "../src/interview-catalog-asset.js";

describe("interview catalog asset ownership", () => {
  let directory: string;
  const rawBytes = Buffer.from('{"schemaVersion":1,"cards":[]}\n');
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-catalog-")); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  function writeAsset(relative: string): string {
    const asset = path.join(directory, relative);
    fs.mkdirSync(path.dirname(asset), { recursive: true });
    fs.writeFileSync(asset, rawBytes);
    return asset;
  }

  it("reads source bytes without rewriting their digest", () => {
    const sourceAssetPath = writeAsset("source/catalog.v1.json");
    const asset = loadInterviewCatalogAsset({ environment: {}, sourceAssetPath });
    expect(asset.rawBytes).toEqual(rawBytes);
    expect(asset.rawDigest).toBe(createHash("sha256").update(rawBytes).digest("hex"));
    expect(asset.data).toEqual({ schemaVersion: 1, cards: [] });
  });

  it("reads the fixed installed worker asset with no source tree", () => {
    writeAsset("payload/worker/site-packages/jobctrl/assets/interview/catalog.v1.json");
    const asset = loadInterviewCatalogAsset({
      environment: { JOBCTRL_PAYLOAD_DIR: path.join(directory, "payload") },
      sourceAssetPath: path.join(directory, "absent-source.json"),
    });
    expect(asset.rawBytes).toEqual(rawBytes);
    expect(asset.rawDigest).toBe(createHash("sha256").update(rawBytes).digest("hex"));
  });

  it("fails closed when the installed asset is absent despite a valid source asset", () => {
    const sourceAssetPath = writeAsset("source/catalog.v1.json");
    fs.mkdirSync(path.join(directory, "payload"));
    expect(() => loadInterviewCatalogAsset({
      environment: { JOBCTRL_PAYLOAD_DIR: path.join(directory, "payload") }, sourceAssetPath,
    })).toThrow(InterviewCatalogAssetError);
  });

  it("rejects an installed asset symlink outside the payload", () => {
    const sourceAssetPath = writeAsset("source/catalog.v1.json");
    const asset = path.join(directory, "payload/worker/site-packages/jobctrl/assets/interview/catalog.v1.json");
    fs.mkdirSync(path.dirname(asset), { recursive: true });
    fs.symlinkSync(sourceAssetPath, asset);
    expect(() => loadInterviewCatalogAsset({
      environment: { JOBCTRL_PAYLOAD_DIR: path.join(directory, "payload") },
    })).toThrow(InterviewCatalogAssetError);
  });

  it.each(["", "relative/payload"])("rejects a configured invalid payload %j", (payload) => {
    const sourceAssetPath = writeAsset("source/catalog.v1.json");
    expect(() => loadInterviewCatalogAsset({
      environment: { JOBCTRL_PAYLOAD_DIR: payload }, sourceAssetPath,
    })).toThrow(InterviewCatalogAssetError);
  });

  it("bounds asset size and rejects corrupt JSON without disclosing its content", () => {
    const sourceAssetPath = writeAsset("source/catalog.v1.json");
    fs.writeFileSync(sourceAssetPath, "private-invalid-json");
    expect(() => loadInterviewCatalogAsset({ environment: {}, sourceAssetPath }))
      .toThrow("The installed interview catalog is unavailable or invalid.");
    fs.truncateSync(sourceAssetPath, 8 * 1024 * 1024 + 1);
    expect(() => loadInterviewCatalogAsset({ environment: {}, sourceAssetPath })).toThrow(InterviewCatalogAssetError);
  });
});
