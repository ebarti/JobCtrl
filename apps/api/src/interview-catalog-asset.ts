import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const SOURCE_ASSET = fileURLToPath(new URL(
  "../../../workers/automation/src/jobctrl/assets/interview/catalog.v1.json",
  import.meta.url,
));
const INSTALLED_ASSET = "worker/site-packages/jobctrl/assets/interview/catalog.v1.json";

export class InterviewCatalogAssetError extends Error {
  constructor() {
    super("The installed interview catalog is unavailable or invalid.");
    this.name = "InterviewCatalogAssetError";
  }
}

export interface InterviewCatalogAssetOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Source-only test seam. An installed payload never falls back to this path. */
  readonly sourceAssetPath?: string;
}

export interface InterviewCatalogAsset {
  readonly rawBytes: Buffer;
  readonly rawDigest: string;
  readonly data: unknown;
}

/** Read the single packaged catalog; missing installed assets fail closed. */
export function loadInterviewCatalogAsset(
  options: InterviewCatalogAssetOptions = {},
): InterviewCatalogAsset {
  try {
    const environment = options.environment ?? process.env;
    const configuredPayload = environment.JOBCTRL_PAYLOAD_DIR;
    let assetPath: string;
    if (configuredPayload !== undefined) {
      if (!configuredPayload.trim() || !path.isAbsolute(configuredPayload)) {
        throw new InterviewCatalogAssetError();
      }
      const payloadDir = fs.realpathSync(configuredPayload);
      assetPath = fs.realpathSync(path.join(payloadDir, INSTALLED_ASSET));
      const relative = path.relative(payloadDir, assetPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new InterviewCatalogAssetError();
      }
    } else {
      assetPath = options.sourceAssetPath ?? SOURCE_ASSET;
    }
    const stat = fs.statSync(assetPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CATALOG_BYTES) {
      throw new InterviewCatalogAssetError();
    }
    const rawBytes = fs.readFileSync(assetPath);
    if (rawBytes.length > MAX_CATALOG_BYTES) throw new InterviewCatalogAssetError();
    return {
      rawBytes,
      rawDigest: createHash("sha256").update(rawBytes).digest("hex"),
      data: JSON.parse(rawBytes.toString("utf8")) as unknown,
    };
  } catch {
    // Paths and parser details are intentionally kept out of the public error.
    throw new InterviewCatalogAssetError();
  }
}
