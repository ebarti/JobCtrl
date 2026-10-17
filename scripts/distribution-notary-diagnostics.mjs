import { createHash, createPrivateKey, sign } from "node:crypto";
import { pathToFileURL } from "node:url";

const ENDPOINTS = [
  ["notary", "https://appstoreconnect.apple.com/notary/v2/submissions"],
  ["app-store-connect", "https://api.appstoreconnect.apple.com/v1/apps?limit=1"],
];

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function boundedErrorBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

// This runs only inside the protected signing job after credential validation
// fails. It must never authorize publication or replace notarization checks.
export async function collectNotaryDiagnostics({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const keyId = env.JOBCTRL_APPLE_NOTARY_KEY_ID ?? "";
  const issuer = env.JOBCTRL_APPLE_NOTARY_ISSUER ?? "";
  const encodedKey = env.JOBCTRL_APPLE_NOTARY_API_KEY ?? "";
  const report = {
    schemaVersion: 1,
    checkedAt: new Date(now()).toISOString(),
    credentialFingerprints: { keyIdSha256: keyId ? fingerprint(keyId) : null, issuerSha256: issuer ? fingerprint(issuer) : null },
    probes: [],
  };
  let token;
  try {
    if (!keyId || !issuer || !encodedKey) throw new Error();
    const key = createPrivateKey(encodedKey);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    const issuedAt = Math.floor(now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: issuer, iat: issuedAt, exp: issuedAt + 60, aud: "appstoreconnect-v1" })).toString("base64url");
    const signed = `${header}.${payload}`;
    token = `${signed}.${sign("sha256", Buffer.from(signed), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  } catch {
    return { ...report, status: "invalid-credential-format" };
  }
  const secrets = [token, keyId, issuer, encodedKey, ...encodedKey.split(/\r?\n/).filter((line) => line.length > 16)];
  const redact = (value) => {
    if (typeof value !== "string") return null;
    let result = value;
    for (const secret of secrets) result = result.split(secret).join("[redacted]");
    return result.slice(0, 2048);
  };
  report.probes = await Promise.all(ENDPOINTS.map(async ([service, url]) => {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(15000),
      });
      const probe = {
        service,
        httpStatus: response.status,
        requestId: redact(response.headers.get("x-apple-request-uuid") ?? response.headers.get("x-apple-jingle-correlation-key") ?? response.headers.get("x-request-id")),
      };
      if (response.ok) {
        await response.body?.cancel();
        return probe;
      }
      let body;
      try { body = await boundedErrorBody(response); } catch { body = null; }
      return {
        ...probe,
        notaryError: service === "notary" && body && typeof body === "object"
          ? { name: redact(body.name), description: redact(body.description), labels: Array.isArray(body.labels) ? body.labels.slice(0, 5).map(redact) : [] }
          : null,
        errors: Array.isArray(body?.errors)
          ? body.errors.slice(0, 5).map((error) => ({ code: redact(error?.code), title: redact(error?.title), detail: redact(error?.detail) }))
          : [],
      };
    } catch {
      // Transport exceptions can contain request headers. Never print them.
      return { service, status: "transport-error" };
    }
  }));
  return { ...report, status: "diagnosed" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await collectNotaryDiagnostics(), null, 2));
  } catch {
    console.error("Notary diagnostics could not complete; original validation failure remains authoritative.");
    process.exitCode = 1;
  }
}
