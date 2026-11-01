import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";

import { createQaPdfBytes } from "../../../api/test/qa-seed.js";
import { loadE2eDbPath } from "../fixtures/e2e-state.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

test("stale score reset preserves accepted evidence and an active owner", async ({ page }) => {
  const dbPath = loadE2eDbPath(); // Verifies the workspace ownership receipt.
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const ids = { ready: randomUUID(), running: randomUUID(), hidden: randomUUID(), deleted: randomUUID() };
  const prefix = `qa-score-reset-${ids.ready.slice(0, 8)}`;
  const titles = { ready: `${prefix} ready`, running: `${prefix} running`, hidden: `${prefix} hidden`, deleted: `${prefix} deleted` };
  const artifactId = `qa-score-reset-${ids.ready}`;
  const textId = `${artifactId}-text`;
  const artifactPath = path.join(path.dirname(dbPath), `${artifactId}.pdf`);
  const textPath = path.join(path.dirname(dbPath), `${artifactId}.txt`);
  const resumeText = "Synthetic accepted resume.\n";
  const pdf = createQaPdfBytes(resumeText.trim());
  const now = new Date().toISOString();

  try {
    fs.writeFileSync(artifactPath, pdf, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(textPath, resumeText, { flag: "wx", mode: 0o600 });
    db.transaction(() => {
      const job = db.prepare(`INSERT INTO jobs (tenant_id,job_id,url,title,company,site,description,discovered_at)
        VALUES ('local',?,?,?,'Synthetic Co','qa','Synthetic posting',?)`);
      const score = db.prepare(`INSERT INTO job_scores (tenant_id,job_id,version,fit_score,breakdown_json,
        keywords_json,scored_at,criteria_json,trace_json) VALUES ('local',?,1,6,'{}','[]',?,'{}',?)`);
      const stage = db.prepare(`INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,updated_at,metadata_json)
        VALUES ('local',?,'score',?,2,?,?)`);
      const marker = db.prepare(`INSERT INTO job_score_staleness (tenant_id,job_id,stale_reason,old_policy_id,
        old_policy_version,new_policy_id,new_policy_version,marked_at,resolved)
        VALUES ('local',?,'scoring_policy_changed','synthetic-policy',3,'synthetic-policy',4,?,0)`);
      const event = db.prepare(`INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at)
        VALUES ('local',?,1,'score','QaInfo','info','Synthetic browser fixture',?)`);
      for (const key of ["ready", "running", "hidden", "deleted"] as const) {
        const id = ids[key];
        job.run(id, `https://example.test/${id}`, titles[key], now);
        score.run(id, now, JSON.stringify({ scoring_policy_id: "synthetic-policy", scoring_policy_version: 3 }));
        stage.run(id, key === "running" ? "running" : "stale", now,
          key === "running" ? JSON.stringify({ activityOwner: "synthetic-owner", workflowId: "synthetic-workflow" }) : null);
        marker.run(id, now);
        event.run(id, now);
      }
      db.prepare("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('local',?,?)").run(ids.hidden, now);
      db.prepare("INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at) VALUES ('local',?,?)").run(ids.deleted, now);
      db.prepare(`INSERT INTO job_stage_states (tenant_id,job_id,stage,state,updated_at)
        VALUES ('local',?,'apply','pending',?)`).run(ids.ready, now);
      db.prepare(`INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at,metadata_json)
        VALUES ('local',?,1,'resume_approved',?,?,?)`)
        .run(ids.ready, now, now, JSON.stringify({ __jobctrl_materials_lineage_id: randomUUID().replaceAll("-", "") }));
      const artifact = db.prepare(`INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,
        path,render_format,size_bytes,metadata_json,created_at) VALUES ('local',?,1,?,?,'approved',?,?,?,?,?)`);
      artifact.run(ids.ready, "tailored_resume", textId, textPath, "text", Buffer.byteLength(resumeText), "{}", now);
      artifact.run(ids.ready, "resume_pdf", artifactId, artifactPath, "html_pdf", pdf.length,
        JSON.stringify({ source_artifact_id: textId, source_generation: 1 }), now);
    })();

    const readApprovedSet = () => {
      const script = `
import json, sqlite3, sys
from pathlib import Path
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
conn = sqlite3.connect(Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True)
conn.row_factory = sqlite3.Row
current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, canonical_job_id(sys.argv[2]))
if current is None or current.tailored_resume is None or current.resume_pdf is None:
    raise RuntimeError('Expected a current approved resume text and PDF set')
print(json.dumps({
    'generation': current.generation, 'status': current.status,
    'text': {'id': current.tailored_resume.artifact_id, 'status': current.tailored_resume.status.value,
             'path': current.tailored_resume.path},
    'pdf': {'id': current.resume_pdf.artifact_id, 'status': current.resume_pdf.status.value,
            'path': current.resume_pdf.path, 'metadata': current.resume_pdf.metadata},
}))
conn.close()
`;
      const result = spawnSync(path.join(repoRoot, "workers/automation/.venv/bin/python"), ["-c", script, dbPath, ids.ready], {
        cwd: repoRoot,
        env: { ...process.env, PYTHONPATH: path.join(repoRoot, "workers/automation/src"), UV_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1" },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as unknown;
    };

    const allIds = Object.values(ids);
    const readEvidence = () => ({
      scores: db.prepare("SELECT * FROM job_scores WHERE tenant_id='local' AND job_id IN (?,?,?,?) ORDER BY job_id").all(...allIds),
      markers: db.prepare("SELECT * FROM job_score_staleness WHERE tenant_id='local' AND job_id IN (?,?,?,?) ORDER BY job_id").all(...allIds),
      materials: db.prepare("SELECT * FROM job_materials_artifacts WHERE tenant_id='local' AND job_id=? ORDER BY artifact_type").all(ids.ready),
      materialSet: db.prepare("SELECT * FROM job_materials WHERE tenant_id='local' AND job_id=?").all(ids.ready),
      protectedStages: db.prepare("SELECT * FROM job_stage_states WHERE tenant_id='local' AND job_id IN (?,?,?) ORDER BY job_id")
        .all(ids.running, ids.hidden, ids.deleted),
    });
    const evidence = readEvidence();
    const approved = readApprovedSet();
    expect(approved).toMatchObject({
      generation: 1, status: "resume_approved",
      text: { id: textId, status: "approved", path: textPath },
      pdf: { id: artifactId, status: "approved", path: artifactPath,
        metadata: { source_artifact_id: textId, source_generation: 1 } },
    });
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(`/jobs?q=${encodeURIComponent(prefix)}&stage=all&page=1&pageSize=50`);
    const ready = page.getByRole("row").filter({ hasText: titles.ready });
    const running = page.getByRole("row").filter({ hasText: titles.running });
    await expect(ready.locator(".score-stale-tag")).toHaveText("Stale score v3 -> v4");
    await expect(running.locator(".score-stale-tag")).toHaveText("Stale score v3 -> v4");
    await expect(page.getByText(titles.hidden)).toHaveCount(0);
    await expect(page.getByText(titles.deleted)).toHaveCount(0);
    const beforePdf = await page.request.get(`/v1/artifacts/${artifactId}/preview.pdf`);
    expect(beforePdf.status()).toBe(200);
    expect(await beforePdf.body()).toEqual(pdf);
    const readDisplayedSet = async () => {
      const response = await page.request.get("/v1/apply/review-queue");
      expect(response.status()).toBe(200);
      const queue = await response.json() as { items: Array<{ jobKey: string; materialsPreview: unknown }> };
      return queue.items.find((item) => item.jobKey === ids.ready)?.materialsPreview;
    };
    const displayed = await readDisplayedSet();
    expect(displayed).toMatchObject({ materialsGeneration: 1, resumeText: resumeText.trim(),
      resumeTextArtifactId: textId, resumePdfArtifactId: artifactId });

    const select = async () => {
      await ready.getByRole("checkbox").click();
      await running.getByRole("checkbox").click();
    };
    const reset = async (browser: Page) => {
      const response = browser.waitForResponse((item) =>
        new URL(item.url()).pathname === "/v1/scoring/stale-scores/actions/reset-for-rescore" && item.request().method() === "POST",
      );
      await browser.getByRole("button", { name: "Job operations" }).click();
      await browser.getByRole("menuitem", { name: "Reset stale selected" }).click();
      const result = await response;
      expect(result.status()).toBe(200);
      expect(result.request().postDataJSON()).toMatchObject({ jobKeys: expect.arrayContaining([ids.ready, ids.running]) });
      return result.json();
    };

    await select();
    expect(await reset(page)).toMatchObject({ count: 1, jobKeys: [ids.ready], skippedActiveJobKeys: [ids.running] });
    await expect(page.getByText(/wait for scoring to finish, then retry reset/i)).toBeVisible();
    await expect(ready.getByRole("checkbox")).toBeChecked();
    await expect(running.getByRole("checkbox")).toBeChecked();
    expect(readEvidence()).toEqual(evidence);
    expect(readApprovedSet()).toEqual(approved);
    expect(await readDisplayedSet()).toEqual(displayed);
    expect(fs.readFileSync(textPath, "utf8")).toBe(resumeText);
    expect(db.prepare("SELECT state FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='score'").get(ids.ready))
      .toEqual({ state: "pending" });

    const explicit = await page.request.post("/v1/scoring/stale-scores/actions/reset-for-rescore", {
      headers: { origin: new URL(page.url()).origin },
      data: { jobKeys: [ids.hidden, ids.deleted], limit: 1 },
    });
    expect(explicit.status()).toBe(200);
    expect(await explicit.json()).toMatchObject({ count: 0, jobKeys: [], skippedActiveJobKeys: [], alreadyPendingJobKeys: [] });
    expect(readEvidence()).toEqual(evidence);
    expect(readApprovedSet()).toEqual(approved);
    expect(await readDisplayedSet()).toEqual(displayed);
    const afterPdf = await page.request.get(`/v1/artifacts/${artifactId}/preview.pdf`);
    expect(afterPdf.status()).toBe(200);
    expect(await afterPdf.body()).toEqual(pdf);

    await page.reload();
    await expect(ready.locator(".score-stale-tag")).toHaveText("Stale score v3 -> v4");
    await select();
    expect(await reset(page)).toMatchObject({
      count: 0, jobKeys: [], skippedActiveJobKeys: [ids.running], alreadyPendingJobKeys: [ids.ready],
    });
    await expect(page.getByText(/already pending/i)).toBeVisible();
    expect(readEvidence()).toEqual(evidence);
    expect(db.prepare("SELECT job_id FROM job_events WHERE tenant_id='local' AND event_type='ScoreRescoreRequested' AND job_id IN (?,?,?,?)")
      .all(...allIds)).toEqual([{ job_id: ids.ready }]);
  } finally {
    await page.close();
    db.transaction(() => {
      for (const id of Object.values(ids)) {
        for (const table of ["artifact_list_projections", "job_detail_projections", "job_list_projections"]) {
          db.prepare(`DELETE FROM ${table} WHERE tenant_id='local' AND job_id=?`).run(id);
        }
        db.prepare("DELETE FROM jobs WHERE tenant_id='local' AND job_id=?").run(id);
      }
    })();
    db.close();
    fs.rmSync(artifactPath, { force: true });
    fs.rmSync(textPath, { force: true });
  }
});
