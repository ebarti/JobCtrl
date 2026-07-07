import fs from "node:fs";
import path from "node:path";

import type { CredentialKey, CredentialsResponse } from "@jobctl/contracts";
import { CredentialKeys } from "@jobctl/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CredentialStore } from "../src/credentials.js";
import { buildApp, type BuildAppOptions } from "../src/server.js";
import { createQaWorkspace, removeQaWorkspace, type QaWorkspace } from "./qa-seed.js";

const LOOPBACK_HEADERS = { origin: "http://127.0.0.1:5173" };

let workspace: QaWorkspace;
let options: BuildAppOptions;

beforeEach(() => {
  workspace = createQaWorkspace();
  options = {
    dbPath: workspace.dbPath,
    settingsPath: workspace.settingsPath,
    profilePreviewRenderer: async () => ({
      pdfBytes: Buffer.from("%PDF-1.4\n% QA preview\n"),
      htmlText: '<main class="resume-page">QA preview</main>',
    }),
    resumePdfRenderer: ({ htmlPath, pdfPath }) => {
      fs.writeFileSync(pdfPath, `%PDF-1.4 rendered\n${fs.readFileSync(htmlPath, "utf8")}`);
    },
  };
});

afterEach(() => {
  removeQaWorkspace(workspace);
});

describe("seeded local QA workflow", () => {
  it("soft deletes and restores all matching jobs without touching nonmatching rows", async () => {
    const app = buildApp(options);

    const initial = await app.inject({ method: "GET", url: "/v1/jobs?deleted=active&pageSize=50&sort=title&dir=asc" });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json().pagination.total).toBe(4);
    expect(initial.json().items.map((job: { title: string }) => job.title)).toEqual([
      "Command Center Solutions Project Manager",
      "Director of Marketing",
      "Director of Platform Engineering",
      "Senior Engineering Manager - Risk",
    ]);

    const deleteFailed = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-delete",
      headers: LOOPBACK_HEADERS,
      payload: {
        allMatching: true,
        filter: { deleted: "active", state: "failed" },
        jobKeys: [],
        reason: "seeded QA delete",
      },
    });
    expect(deleteFailed.statusCode, deleteFailed.body).toBe(200);
    expect(deleteFailed.json()).toMatchObject({
      count: 1,
      jobKeys: ["https://linkedin.com/jobs/view/qa-risk-manager"],
    });

    const activeRisk = await app.inject({ method: "GET", url: "/v1/jobs?deleted=active&q=risk" });
    expect(activeRisk.statusCode, activeRisk.body).toBe(200);
    expect(activeRisk.json().pagination.total).toBe(0);

    const deletedRisk = await app.inject({ method: "GET", url: "/v1/jobs?deleted=deleted&q=risk" });
    expect(deletedRisk.statusCode, deletedRisk.body).toBe(200);
    expect(deletedRisk.json().pagination.total).toBe(1);
    expect(deletedRisk.json().items[0]).toMatchObject({
      title: "Senior Engineering Manager - Risk",
      deletedAt: expect.any(String),
    });

    const dashboardAfterDelete = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
    expect(dashboardAfterDelete.statusCode, dashboardAfterDelete.body).toBe(200);
    expect(dashboardAfterDelete.json().activity.map((event: { message: string }) => event.message)).not.toContain(
      "QA score action failed",
    );

    const restoreDeleted = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-restore",
      headers: LOOPBACK_HEADERS,
      payload: { allMatching: true, filter: { deleted: "deleted" }, jobKeys: [] },
    });
    expect(restoreDeleted.statusCode, restoreDeleted.body).toBe(200);
    expect(restoreDeleted.json()).toMatchObject({ count: 1 });

    const restoredRisk = await app.inject({ method: "GET", url: "/v1/jobs?deleted=active&q=risk" });
    expect(restoredRisk.statusCode, restoredRisk.body).toBe(200);
    expect(restoredRisk.json().pagination.total).toBe(1);

    await app.close();
  });

  it("hides deleted job artifacts and apply runs while preserving missing-file open safety", async () => {
    const opener = vi.fn(async () => undefined);
    const app = buildApp({ ...options, artifactOpener: opener });

    const artifacts = await app.inject({ method: "GET", url: "/v1/artifacts?pageSize=20&sort=created_at&dir=desc" });
    expect(artifacts.statusCode, artifacts.body).toBe(200);
    expect(artifacts.json().pagination.total).toBe(8);
    const gitlabArtifacts = artifacts
      .json()
      .items.filter((artifact: { jobKey: string }) => artifact.jobKey === "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director");
    expect(gitlabArtifacts).toHaveLength(7);
    expect(gitlabArtifacts.map((artifact: { type: string }) => artifact.type).sort()).toEqual(
      expect.arrayContaining([
        "cover_letter",
        "cover_letter_pdf",
        "cover_letter_txt",
        "resume_pdf",
        "tailored_resume",
        "tailored_resume_pdf",
        "tailored_resume_txt",
      ]),
    );
    expect(new Set(gitlabArtifacts.map((artifact: { company: string }) => artifact.company))).toEqual(new Set(["GitLab"]));

    const activeArtifact = gitlabArtifacts.find((artifact: { type: string }) => artifact.type === "tailored_resume_txt") as {
      artifactId: string;
      localPath: string;
    };
    const openActive = await app.inject({
      method: "POST",
      url: `/v1/artifacts/${encodeURIComponent(activeArtifact.artifactId)}/open`,
      headers: LOOPBACK_HEADERS,
    });
    expect(openActive.statusCode, openActive.body).toBe(200);
    expect(openActive.json()).toMatchObject({ opened: true, path: activeArtifact.localPath });
    expect(opener).toHaveBeenCalledWith(activeArtifact.localPath);

    const missingArtifact = artifacts.json().items.find((artifact: { status: string }) => artifact.status === "missing") as {
      artifactId: string;
    };
    const openMissing = await app.inject({
      method: "POST",
      url: `/v1/artifacts/${encodeURIComponent(missingArtifact.artifactId)}/open`,
      headers: LOOPBACK_HEADERS,
    });
    expect(openMissing.statusCode, openMissing.body).toBe(404);
    expect(openMissing.json()).toMatchObject({ ok: false, error: "artifact_missing" });

    const deleteGitlab = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-delete",
      headers: LOOPBACK_HEADERS,
      payload: { allMatching: true, filter: { q: "platform", deleted: "active" }, jobKeys: [] },
    });
    expect(deleteGitlab.statusCode, deleteGitlab.body).toBe(200);
    expect(deleteGitlab.json()).toMatchObject({ count: 1 });

    const artifactsAfterDelete = await app.inject({ method: "GET", url: "/v1/artifacts?pageSize=20" });
    expect(artifactsAfterDelete.statusCode, artifactsAfterDelete.body).toBe(200);
    expect(artifactsAfterDelete.json().items.map((artifact: { jobKey: string }) => artifact.jobKey)).not.toContain(
      "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director",
    );

    const dashboardAfterDelete = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
    expect(dashboardAfterDelete.statusCode, dashboardAfterDelete.body).toBe(200);
    expect(dashboardAfterDelete.json().applyRuns.map((run: { jobKey: string }) => run.jobKey)).not.toContain(
      "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director",
    );

    await app.close();
  });

  it("persists profile, settings, credentials, and the rendered preview against seeded SQLite data", async () => {
    const credentialStore = createMemoryCredentialStore();
    const app = buildApp({ ...options, credentialStore });

    const settings = await app.inject({ method: "GET", url: "/v1/settings" });
    expect(settings.statusCode, settings.body).toBe(200);
    expect(settings.json().settings).toMatchObject({
      minFitScore: 7,
      scoreCriteria: "Prioritize platform reliability, security, and engineering leadership.",
      targetCriteria: "Remote-friendly senior engineering leadership roles.",
    });

    const updateSettings = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      headers: LOOPBACK_HEADERS,
      payload: {
        minFitScore: 8,
        scoreCriteria: "QA score criteria",
        targetCriteria: "QA targeting criteria",
      },
    });
    expect(updateSettings.statusCode, updateSettings.body).toBe(200);
    expect(JSON.parse(fs.readFileSync(workspace.settingsPath, "utf8"))).toMatchObject({
      min_fit_score: 8,
      score_criteria: "QA score criteria",
      target_criteria: "QA targeting criteria",
    });

    const profileResponse = await app.inject({ method: "GET", url: "/v1/profile" });
    expect(profileResponse.statusCode, profileResponse.body).toBe(200);
    const profileDraft = profileResponse.json().profile;
    profileDraft.personal.full_name = "QA Candidate Edited";
    const updateProfile = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: LOOPBACK_HEADERS,
      payload: { profileText: JSON.stringify(profileDraft, null, 2) },
    });
    expect(updateProfile.statusCode, updateProfile.body).toBe(200);
    const profileAfterUpdate = await app.inject({ method: "GET", url: "/v1/profile" });
    expect(profileAfterUpdate.statusCode, profileAfterUpdate.body).toBe(200);
    expect(profileAfterUpdate.json().profile.personal.full_name).toBe("QA Candidate Edited");

    const preview = await app.inject({ method: "GET", url: "/v1/profile/preview.pdf" });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers["content-type"]).toContain("application/pdf");
    const htmlPreview = await app.inject({ method: "GET", url: "/v1/profile/preview.html" });
    expect(htmlPreview.statusCode, htmlPreview.body).toBe(200);
    expect(htmlPreview.headers["content-type"]).toContain("text/html");

    const initialCredentials = await app.inject({ method: "GET", url: "/v1/credentials" });
    expect(initialCredentials.statusCode, initialCredentials.body).toBe(200);
    expect(initialCredentials.json().credentials.every((credential: { configured: boolean }) => !credential.configured)).toBe(true);

    const saveCredential = await app.inject({
      method: "PATCH",
      url: "/v1/credentials",
      headers: LOOPBACK_HEADERS,
      payload: { key: "OPENAI_API_KEY", value: "sk-qa" },
    });
    expect(saveCredential.statusCode, saveCredential.body).toBe(200);
    expect(saveCredential.json().credentials.find((credential: { key: string }) => credential.key === "OPENAI_API_KEY")).toMatchObject({
      configured: true,
      storage: "keychain",
    });

    const deleteCredential = await app.inject({
      method: "DELETE",
      url: "/v1/credentials/OPENAI_API_KEY",
      headers: LOOPBACK_HEADERS,
    });
    expect(deleteCredential.statusCode, deleteCredential.body).toBe(200);
    expect(deleteCredential.json().credentials.find((credential: { key: string }) => credential.key === "OPENAI_API_KEY")).toMatchObject({
      configured: false,
    });

    await app.close();
  });
});

function createMemoryCredentialStore(): CredentialStore {
  const values = new Map<CredentialKey, string>();
  const list = async (): Promise<CredentialsResponse> => ({
    ok: true,
    credentials: CredentialKeys.map((key) => ({
      key,
      label: key,
      configured: values.has(key),
      storage: "keychain" as const,
    })),
  });
  return {
    list,
    set: async (key, value) => {
      values.set(key, value);
      return list();
    },
    delete: async (key) => {
      values.delete(key);
      return list();
    },
  };
}
