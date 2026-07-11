import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signDescriptor } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  renderHomebrewFormula,
  loadHomebrewReleaseTrust,
  homebrewPublicationInputs,
  validateRenderedHomebrewFormula,
  verifyHomebrewPromotionEvidence,
} from "./distribution-homebrew.mjs";
import { releasePublicationInputs } from "./distribution-release.mjs";

const execFileAsync = promisify(execFile);

function stableDescriptor() {
  return {
    schemaVersion: 1,
    channel: "stable",
    sequence: 42,
    minimumSafeSequence: 1,
    revokedBuildIds: [],
    buildId: "stable-build-0000042",
    appVersion: "2.0.0",
    platform: { id: "darwin-arm64", os: "darwin", arch: "arm64" },
    artifact: {
      url: "https://releases.jobctrl.dev/v1/stable/jobctrl-2.0.0-darwin-arm64.zip",
      sha256: "a".repeat(64),
      sizeBytes: 12345,
      archiveType: "zip",
      manifestSha256: "b".repeat(64),
    },
  };
}

function signedStableFixture(descriptorRaw) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    signature: {
      schemaVersion: 1,
      status: "signed",
      algorithm: "ed25519",
      keyId: "jobctrl-release-v1",
      signature: signDescriptor(null, Buffer.concat([Buffer.from("jobctrl:release-descriptor:v1\0"), Buffer.from(descriptorRaw)]), privateKey).toString("base64"),
    },
    trust: new Map([["jobctrl-release-v1", publicKey]]),
    privateKey,
  };
}

test("Homebrew render uses the exact signed curl ZIP identity without a toolchain or HEAD formula", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-homebrew-formula-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const descriptorRaw = `${JSON.stringify(stableDescriptor(), null, 2)}\n`;
  const signed = signedStableFixture(descriptorRaw);
  const signatureRaw = `${JSON.stringify(signed.signature, null, 2)}\n`;
  const descriptorUrl = "https://releases.jobctrl.dev/v1/stable/darwin-arm64.json";
  const rendered = await renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl, trust: signed.trust });
  const formulaPath = path.join(root, "jobctrl.rb");
  await writeFile(formulaPath, rendered.formula);
  assert.equal(validateRenderedHomebrewFormula({ formula: rendered.formula, descriptor: stableDescriptor(), descriptorRaw, signatureRaw, descriptorUrl }), true);
  assert.match(rendered.formula, /url "https:\/\/releases\.jobctrl\.dev\/v1\/stable\/jobctrl-2\.0\.0-darwin-arm64\.zip"/);
  assert.match(rendered.formula, /JOBCTRL_MANIFEST_SHA256 = "b{64}"/);
  assert.match(rendered.formula, /JOBCTRL_BUILD_ID = "stable-build-0000042"/);
  assert.match(rendered.formula, /resource "jobctrl-release-descriptor"/);
  assert.match(rendered.formula, /bootstrap\.install cached_download => "jobctrl-release\.zip"/);
  assert.match(rendered.formula, /homebrew-bootstrap\.json/);
  assert.match(rendered.formula, /bin\.install_symlink bootstrap\/"jobctrl"/);
  assert.doesNotMatch(rendered.formula, /Pathname\.new\(Dir\.home\)/);
  assert.match(rendered.formula, /Open3\.capture2e/);
  assert.match(rendered.formula, /--verify", "--deep", "--strict", "--check-notarization", "-R=notarized/);
  assert.match(rendered.formula, /--assess", "--type", "execute", "--verbose=4/);
  assert.doesNotMatch(rendered.formula, /context:primary-signature/);
  assert.match(rendered.formula, /source=Notarized Developer ID/);
  assert.match(rendered.formula, /outermost_chromium_apps/);
  assert.doesNotMatch(rendered.formula, /depends_on|^\s*head\s+|git clone/);
  assert.deepEqual(
    releasePublicationInputs({ descriptorRaw, descriptorUrl }),
    homebrewPublicationInputs({ descriptorRaw, descriptorUrl }),
    "curl/bootstrap and Homebrew must bind the exact ZIP, version, SHA, manifest, build, and descriptor identity",
  );
  assert.deepEqual(rendered.publicationInputs, releasePublicationInputs({ descriptorRaw, descriptorUrl }));
  await execFileAsync("/usr/bin/ruby", ["-c", formulaPath]);
});

test("Homebrew promotion verification fails closed without P6 signature and published-asset smoke evidence", async () => {
  const descriptorRaw = `${JSON.stringify(stableDescriptor(), null, 2)}\n`;
  const signed = signedStableFixture(descriptorRaw);
  const signatureRaw = `${JSON.stringify(signed.signature, null, 2)}\n`;
  const descriptorUrl = "https://releases.jobctrl.dev/v1/stable/darwin-arm64.json";
  const rendered = await renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl, trust: signed.trust });
  const evidence = {
    schemaVersion: 1,
    status: "verified",
    signatureVerified: true,
    publishedArtifactSmoke: "passed",
    descriptorSha256: rendered.descriptorSha256,
    formulaSha256: (await import("node:crypto")).createHash("sha256").update(rendered.formula).digest("hex"),
    artifact: {
      url: stableDescriptor().artifact.url,
      sha256: stableDescriptor().artifact.sha256,
      manifestSha256: stableDescriptor().artifact.manifestSha256,
      buildId: stableDescriptor().buildId,
      appVersion: stableDescriptor().appVersion,
    },
  };
  const verified = await verifyHomebrewPromotionEvidence({ descriptorRaw, signatureRaw, descriptorUrl, formulaRaw: rendered.formula, evidenceRaw: JSON.stringify(evidence), trust: signed.trust });
  assert.equal(verified.artifact.buildId, stableDescriptor().buildId);
  evidence.publishedArtifactSmoke = "missing";
  await assert.rejects(
    verifyHomebrewPromotionEvidence({ descriptorRaw, signatureRaw, descriptorUrl, formulaRaw: rendered.formula, evidenceRaw: JSON.stringify(evidence), trust: signed.trust }),
    /not verified after signed artifact smoke/,
  );
  const local = stableDescriptor();
  local.channel = "local";
  local.artifact.url = "file:///jobctrl-local-release/jobctrl-2.0.0-darwin-arm64.zip";
  await assert.rejects(
    renderHomebrewFormula({ descriptorRaw: JSON.stringify(local), signatureRaw: JSON.stringify({ ...signed.signature, status: "unsigned-local", keyId: "local-development", signature: null }), descriptorUrl, trust: signed.trust }),
    /network release descriptor requires a release signature|stable descriptor/,
  );

  evidence.publishedArtifactSmoke = "passed";
  const mutations = [
    `${rendered.formula}\nsystem("false")\n`,
    rendered.formula.replace(
      'desc "Local-first job search mission control: discover, score, tailor, apply"',
      'desc "Tampered JobCtrl formula"',
    ),
    rendered.formula.replace('    verify_notarized_bundle!(buildpath/"launcher/jobctrl-installer")\n', ""),
  ];
  for (const mutatedFormula of mutations) {
    assert.notEqual(mutatedFormula, rendered.formula);
    await execFileAsync("/usr/bin/ruby", ["-c", "-e", mutatedFormula]);
    const selfAssertedEvidence = {
      ...evidence,
      formulaSha256: (await import("node:crypto")).createHash("sha256").update(mutatedFormula).digest("hex"),
    };
    await assert.rejects(
      verifyHomebrewPromotionEvidence({
        descriptorRaw,
        signatureRaw,
        descriptorUrl,
        formulaRaw: mutatedFormula,
        evidenceRaw: JSON.stringify(selfAssertedEvidence),
        trust: signed.trust,
      }),
      /canonical checked-in template render byte-for-byte/,
    );
  }
});

test("tap sync has no caller-controlled template input", async () => {
  const workflow = await readFile(path.join(process.cwd(), ".github", "workflows", "sync-homebrew-tap.yml"), "utf8");
  assert.doesNotMatch(workflow, /template_path|--template/);
});

test("Homebrew trust verification rejects empty or wrong trust, wrong domains, tampering, unknown keys, and Ruby URL injection", async () => {
  const descriptorRaw = `${JSON.stringify(stableDescriptor(), null, 2)}\n`;
  const signed = signedStableFixture(descriptorRaw);
  const signatureRaw = `${JSON.stringify(signed.signature, null, 2)}\n`;
  const descriptorUrl = "https://releases.jobctrl.dev/v1/stable/darwin-arm64.json";
  assert.equal((await loadHomebrewReleaseTrust()).size, 0, "P4 must fail closed until P6 provisions the canonical key registry");
  await assert.rejects(renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl, trust: new Map() }), /no Homebrew release trust key/);
  const wrong = generateKeyPairSync("ed25519");
  await assert.rejects(renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl, trust: new Map([["jobctrl-release-v1", wrong.publicKey]]) }), /signature verification failed/);

  const wrongDomainSignature = {
    ...signed.signature,
    signature: signDescriptor(null, Buffer.concat([Buffer.from("jobctrl:manifest:v1\0"), Buffer.from(descriptorRaw)]), signed.privateKey).toString("base64"),
  };
  await assert.rejects(renderHomebrewFormula({ descriptorRaw, signatureRaw: JSON.stringify(wrongDomainSignature), descriptorUrl, trust: signed.trust }), /signature verification failed/);
  await assert.rejects(renderHomebrewFormula({ descriptorRaw: descriptorRaw.replace("stable-build-0000042", "stable-build-0000043"), signatureRaw, descriptorUrl, trust: signed.trust }), /signature verification failed/);
  await assert.rejects(renderHomebrewFormula({ descriptorRaw, signatureRaw: JSON.stringify({ ...signed.signature, keyId: "unknown-key" }), descriptorUrl, trust: signed.trust }), /no Homebrew release trust key/);

  const injected = stableDescriptor();
  injected.artifact.url = 'https://releases.jobctrl.dev/v1/stable/jobctrl.zip";system("bad")#';
  const injectedRaw = JSON.stringify(injected);
  const injectedSigned = signedStableFixture(injectedRaw);
  await assert.rejects(
    renderHomebrewFormula({ descriptorRaw: injectedRaw, signatureRaw: JSON.stringify(injectedSigned.signature), descriptorUrl, trust: injectedSigned.trust }),
    /whitespace, quotes, or backslashes|canonical/,
  );
  await assert.rejects(
    renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl: 'https://releases.jobctrl.dev/v1/stable/x";system("bad")#', trust: signed.trust }),
    /whitespace, quotes, or backslashes|canonical/,
  );
});

test("Homebrew formula validation rejects a render that omits launcher or Chromium notarization gates", async () => {
  const descriptorRaw = `${JSON.stringify(stableDescriptor(), null, 2)}\n`;
  const signed = signedStableFixture(descriptorRaw);
  const signatureRaw = `${JSON.stringify(signed.signature, null, 2)}\n`;
  const descriptorUrl = "https://releases.jobctrl.dev/v1/stable/darwin-arm64.json";
  const rendered = await renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl, trust: signed.trust });
  assert.throws(
    () => validateRenderedHomebrewFormula({ formula: rendered.formula.replace('verify_notarized_bundle!(buildpath/"launcher/jobctrl")', ""), descriptor: stableDescriptor(), descriptorRaw, signatureRaw, descriptorUrl }),
    /launcher\/jobctrl/,
  );
  assert.throws(
    () => validateRenderedHomebrewFormula({ formula: rendered.formula.replace('gatekeeper_output.include?("source=Notarized Developer ID")', "true"), descriptor: stableDescriptor(), descriptorRaw, signatureRaw, descriptorUrl }),
    /source=Notarized Developer ID/,
  );
  assert.throws(
    () => validateRenderedHomebrewFormula({ formula: rendered.formula.replaceAll("outermost_chromium_apps", "chromium_apps"), descriptor: stableDescriptor(), descriptorRaw, signatureRaw, descriptorUrl }),
    /outermost_chromium_apps/,
  );
});
