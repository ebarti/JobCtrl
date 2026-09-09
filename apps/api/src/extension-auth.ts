import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TOKEN_FILENAME = "extension-capability-token";
const DISCOVERY_INSTALLATION_FILENAME = "extension-discovery-installation-id";
const TOKEN_BYTES = 32;
const TOKEN_FILE_MODE = 0o600;
const APP_DIR_MODE = 0o700;

export interface LocalCapabilityToken {
  token: string;
  tokenPath: string;
  created: boolean;
}

export interface DiscoveryInstallationClaim {
  installationId: string;
  changed: boolean;
}

export function localCapabilityTokenPath(appDir: string): string {
  return path.join(appDir, TOKEN_FILENAME);
}

export function ensureLocalCapabilityToken(appDir: string): LocalCapabilityToken {
  const tokenPath = localCapabilityTokenPath(appDir);
  const existing = readTokenFile(tokenPath);
  if (existing) {
    return { token: existing, tokenPath, created: false };
  }
  return writeFreshLocalCapabilityToken(appDir);
}

export function rotateLocalCapabilityToken(appDir: string): LocalCapabilityToken {
  return writeFreshLocalCapabilityToken(appDir);
}

export function readDiscoveryInstallationId(appDir: string): string | null {
  const value = readTokenFile(path.join(appDir, DISCOVERY_INSTALLATION_FILENAME));
  return value && isUuid(value) ? value : null;
}

export function claimDiscoveryInstallationId(
  appDir: string,
  installationId: string,
  replace: boolean,
): DiscoveryInstallationClaim {
  if (!isUuid(installationId)) {
    throw new Error("Discovery extension installation id must be a UUID.");
  }
  const current = readDiscoveryInstallationId(appDir);
  if (current === installationId) {
    return { installationId, changed: false };
  }
  if (!current && !replace) {
    throw new DiscoveryInstallationSelectionRequiredError();
  }
  if (current && !replace) {
    throw new DiscoveryInstallationConflictError();
  }
  fs.mkdirSync(appDir, { recursive: true, mode: APP_DIR_MODE });
  const targetPath = path.join(appDir, DISCOVERY_INSTALLATION_FILENAME);
  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${installationId}\n`, { mode: TOKEN_FILE_MODE, flag: "wx" });
    fs.renameSync(temporaryPath, targetPath);
    fs.chmodSync(targetPath, TOKEN_FILE_MODE);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return { installationId, changed: true };
}

export function clearDiscoveryInstallationId(appDir: string): void {
  try {
    fs.unlinkSync(path.join(appDir, DISCOVERY_INSTALLATION_FILENAME));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

export class DiscoveryInstallationConflictError extends Error {
  constructor() {
    super("Another Chrome extension installation is already selected for Discovery.");
    this.name = "DiscoveryInstallationConflictError";
  }
}

export class DiscoveryInstallationSelectionRequiredError extends Error {
  constructor() {
    super("Select a Chrome profile for Discovery from the extension popup.");
    this.name = "DiscoveryInstallationSelectionRequiredError";
  }
}

export function isAuthorizedLocalCapabilityToken(
  authorizationHeader: string | string[] | undefined,
  appDir: string,
): boolean {
  const presented = parseBearerToken(authorizationHeader);
  if (!presented) {
    return false;
  }
  const expected = readTokenFile(localCapabilityTokenPath(appDir));
  if (!expected) {
    return false;
  }
  return constantTimeEqual(presented, expected);
}

function writeFreshLocalCapabilityToken(appDir: string): LocalCapabilityToken {
  fs.mkdirSync(appDir, { recursive: true, mode: APP_DIR_MODE });
  const tokenPath = localCapabilityTokenPath(appDir);
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: TOKEN_FILE_MODE });
  fs.chmodSync(tokenPath, TOKEN_FILE_MODE);
  return { token, tokenPath, created: true };
}

function readTokenFile(tokenPath: string): string | null {
  try {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function parseBearerToken(header: string | string[] | undefined): string | null {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  if (values.length !== 1) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(values[0]?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
