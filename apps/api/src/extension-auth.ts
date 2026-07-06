import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TOKEN_FILENAME = "extension-capability-token";
const TOKEN_BYTES = 32;
const TOKEN_FILE_MODE = 0o600;
const APP_DIR_MODE = 0o700;

export interface LocalCapabilityToken {
  token: string;
  tokenPath: string;
  created: boolean;
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
