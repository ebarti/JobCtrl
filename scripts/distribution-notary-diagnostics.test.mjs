import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectNotaryDiagnostics } from "./distribution-notary-diagnostics.mjs";

function credentials() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey,
    env: {
      JOBCTRL_APPLE_NOTARY_API_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      JOBCTRL_APPLE_NOTARY_KEY_ID: "synthetic-key-id",
      JOBCTRL_APPLE_NOTARY_ISSUER: "synthetic-issuer-id",
    },
  };
}

test("diagnostics use the existing identity for two bounded read-only Apple requests without publishing credentials", async () => {
  const { env, publicKey } = credentials();
  const requests = [];
  const now = () => 1700000000000;
  const report = await collectNotaryDiagnostics({ env, now, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    const token = options.headers.Authorization.slice("Bearer ".length);
    const [header, payload, signature] = token.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "ES256", kid: env.JOBCTRL_APPLE_NOTARY_KEY_ID, typ: "JWT" });
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), { iss: env.JOBCTRL_APPLE_NOTARY_ISSUER, iat: 1700000000, exp: 1700000060, aud: "appstoreconnect-v1" });
    assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
    return url.includes("/notary/")
      ? Response.json({ name: "FORBIDDEN.CONTRACT", description: `${token} ${env.JOBCTRL_APPLE_NOTARY_KEY_ID} ${env.JOBCTRL_APPLE_NOTARY_ISSUER} ${env.JOBCTRL_APPLE_NOTARY_API_KEY}`, labels: ["synthetic-policy"] }, { status: 403, headers: { "x-apple-request-uuid": "synthetic-request-id" } })
      : Response.json({ data: [{ privateAppName: "must-not-be-logged" }] });
  } });
  assert.deepEqual(requests.map((r) => r.url), ["https://appstoreconnect.apple.com/notary/v2/submissions", "https://api.appstoreconnect.apple.com/v1/apps?limit=1"]);
  for (const { options } of requests) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
  }
  assert.equal(report.probes[0].httpStatus, 403);
  assert.equal(report.probes[0].notaryError.name, "FORBIDDEN.CONTRACT");
  assert.deepEqual(report.probes[0].notaryError.labels, ["synthetic-policy"]);
  assert.equal(report.probes[0].requestId, "synthetic-request-id");
  assert.equal(report.probes[1].httpStatus, 200);
  assert.equal(report.credentialFingerprints.keyIdSha256, createHash("sha256").update(env.JOBCTRL_APPLE_NOTARY_KEY_ID).digest("hex"));
  const output = JSON.stringify(report);
  for (const secret of [...Object.values(env), requests[0].options.headers.Authorization.slice(7), "must-not-be-logged"]) assert.equal(output.includes(secret), false);
});

test("invalid credentials and transport failures never disclose exception contents", async () => {
  let calls = 0;
  const invalid = await collectNotaryDiagnostics({ env: {}, fetchImpl: async () => { calls++; } });
  assert.equal(invalid.status, "invalid-credential-format");
  assert.equal(calls, 0);
  const wrongKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const wrongCurve = await collectNotaryDiagnostics({ env: { ...credentials().env, JOBCTRL_APPLE_NOTARY_API_KEY: wrongKey }, fetchImpl: async () => { calls++; } });
  assert.equal(wrongCurve.status, "invalid-credential-format");
  assert.equal(calls, 0);
  const { env } = credentials();
  const report = await collectNotaryDiagnostics({ env, fetchImpl: async () => { throw new Error(env.JOBCTRL_APPLE_NOTARY_API_KEY); } });
  assert.deepEqual(report.probes, [{ service: "notary", status: "transport-error" }, { service: "app-store-connect", status: "transport-error" }]);
  assert.equal(JSON.stringify(report).includes(env.JOBCTRL_APPLE_NOTARY_API_KEY), false);
});

test("App Store Connect JSON API errors are redacted and credential identifiers are not normalized", async () => {
  const { env } = credentials();
  env.JOBCTRL_APPLE_NOTARY_KEY_ID += " ";
  env.JOBCTRL_APPLE_NOTARY_ISSUER += "\n";
  const report = await collectNotaryDiagnostics({ env, fetchImpl: async (_url, options) => {
    const [header, payload] = options.headers.Authorization.slice(7).split(".");
    assert.equal(JSON.parse(Buffer.from(header, "base64url")).kid, env.JOBCTRL_APPLE_NOTARY_KEY_ID);
    assert.equal(JSON.parse(Buffer.from(payload, "base64url")).iss, env.JOBCTRL_APPLE_NOTARY_ISSUER);
    return Response.json({ errors: [{ code: "FORBIDDEN", title: "Contract policy", detail: env.JOBCTRL_APPLE_NOTARY_ISSUER }] }, { status: 403 });
  } });
  assert.equal(report.probes[1].errors[0].code, "FORBIDDEN");
  assert.equal(report.probes[1].errors[0].detail, "[redacted]");
  assert.equal(report.credentialFingerprints.keyIdSha256, createHash("sha256").update(env.JOBCTRL_APPLE_NOTARY_KEY_ID).digest("hex"));
});

test("oversized or non-JSON Apple failures are not echoed", async () => {
  const { env } = credentials();
  const report = await collectNotaryDiagnostics({ env, fetchImpl: async (url) => new Response(url.includes("/notary/") ? "x".repeat(65537) : "<html>untrusted-error</html>", { status: 403 }) });
  assert.deepEqual(report.probes.map((p) => p.errors), [[], []]);
  assert.equal(JSON.stringify(report).includes("untrusted-error"), false);
});

test("successful authorization remains recorded when discarding the private response body fails", async () => {
  const { env } = credentials();
  const report = await collectNotaryDiagnostics({ env, fetchImpl: async () => ({
    status: 200,
    ok: true,
    headers: new Headers(),
    body: { cancel: async () => { throw new Error("discard failed"); } },
  }) });
  assert.deepEqual(report.probes.map((probe) => probe.httpStatus), [200, 200]);
});

test("the protected signing job preserves the validator's failure after diagnostics", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-distribution.yml", import.meta.url), "utf8");
  const block = workflow.match(/if xcrun notarytool store-credentials[^\n]+--validate; then[\s\S]*?\n\s+fi/)?.[0];
  assert.ok(block);
  for (const [validationExit, diagnosticExit] of [[42, 0], [42, 7], [0, 0]]) {
    const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail\nnotary_key=synthetic\nxcrun() { return ${validationExit}; }\nnode() { echo diagnostics-ran; return ${diagnosticExit}; }\n${block}`], {
      encoding: "utf8",
      env: { JOBCTRL_APPLE_NOTARY_PROFILE: "synthetic", JOBCTRL_APPLE_NOTARY_KEY_ID: "synthetic", JOBCTRL_APPLE_NOTARY_ISSUER: "synthetic" },
    });
    assert.equal(result.status, validationExit, result.stderr);
    assert.equal(result.stdout.includes("diagnostics-ran"), validationExit !== 0);
  }
  assert.equal(workflow.split("node scripts/distribution-notary-diagnostics.mjs").length - 1, 1);
  assert.doesNotMatch(workflow, /--no-validate/);
});
