import { useState } from "react";
import { z } from "zod";

import type { ProfileTransferPort } from "../../../shared/ports/ProfileTransferPort.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";

const uploadState = z.object({ filename: z.string(), pdfBase64: z.string(), importProfile: z.boolean(), importStyle: z.boolean() }).passthrough();
const selectedRecord = z.object({ version: z.literal(2), revision: z.number(), state: uploadState }).passthrough();
const legacyRecord = z.object({ version: z.literal(1), state: uploadState }).passthrough();
const reviewsRecord = z.object({ version: z.union([z.literal(1), z.literal(2)]), drafts: z.array(z.unknown()) }).passthrough();

type Attachment = { record_id: string; filename: string; sha256: string; is_pdf: boolean };
type Unavailable = { record_id: string; filename?: string; reason: string };
interface BrowserSourcesManifest {
  format: "jobctrl.profile-browser-sources.v1"; version: 1; complete: boolean;
  known_attachment_ids: string[]; known_attachments: Attachment[]; unavailable_refs: Unavailable[];
  sources: Array<{ source_id: string; text: string; kind: "resume_pdf"; attachment: { filename: string; mime_type: string; sha256: string; data_base64: string }; provenance: { record_id: string; origin: "browser_import"; state: "selected" | "legacy"; status: string } }>;
  review_records: unknown; raw_records: { selected: string | null; legacy: string | null; reviews: string | null }; errors: string[];
}

async function inspectBrowserSources(port: ProfileTransferPort): Promise<BrowserSourcesManifest> {
  const records = await port.inspect();
  const manifest: BrowserSourcesManifest = {
    format: "jobctrl.profile-browser-sources.v1", version: 1, complete: true,
    known_attachment_ids: [], known_attachments: [], unavailable_refs: [], sources: [], review_records: null,
    raw_records: { selected: records.selectedRaw, legacy: records.legacyRaw, reviews: records.reviewsRaw }, errors: [...records.errors],
  };
  const readUpload = async (raw: string | null, kind: "selected" | "legacy") => {
    if (raw === null) return;
    const recordId = kind === "selected" ? "browser:profile-import-v2" : "browser:profile-import-v1";
    let value: unknown;
    try { value = JSON.parse(raw); } catch { manifest.errors.push(`${kind} import record is unreadable; raw data is preserved in this bundle.`); return; }
    const parsed = kind === "selected" ? selectedRecord.safeParse(value) : legacyRecord.safeParse(value);
    if (!parsed.success) { manifest.errors.push(`${kind} import record has an unknown format; raw data is preserved in this bundle.`); return; }
    const { filename, pdfBase64 } = parsed.data.state;
    if (!filename && !pdfBase64) return;
    manifest.known_attachment_ids.push(recordId);
    if (!filename || !pdfBase64) { manifest.errors.push(`${kind} import has incomplete attachment data; raw data is preserved in this bundle.`); return; }
    try {
      const digest = await port.digestPdf(pdfBase64);
      manifest.known_attachments.push({ record_id: recordId, filename, sha256: digest.sha256, is_pdf: digest.isPdf });
      manifest.sources.push({ source_id: recordId, text: "", kind: "resume_pdf", attachment: {
        filename, mime_type: digest.isPdf ? "application/pdf" : "application/octet-stream", sha256: digest.sha256, data_base64: pdfBase64,
      }, provenance: { record_id: recordId, origin: "browser_import", state: kind, status: digest.isPdf ? "retained" : "non_pdf" } });
    } catch {
      manifest.errors.push(`${kind} attachment could not be verified; raw data is preserved in this bundle.`);
    }
  };
  await Promise.all([readUpload(records.selectedRaw, "selected"), readUpload(records.legacyRaw, "legacy")]);
  if (records.reviewsRaw !== null) {
    try {
      const value: unknown = JSON.parse(records.reviewsRaw);
      const parsed = reviewsRecord.safeParse(value);
      if (!parsed.success) throw new Error("Invalid record");
      manifest.review_records = value;
      const visit = (value: unknown, path: string) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const record = value as Record<string, unknown>;
        if (typeof record.filename === "string" && record.filename) manifest.unavailable_refs.push({ record_id: path, filename: record.filename,
          reason: "Review record does not retain a verified link to PDF bytes." });
        for (const [key, nested] of Object.entries(record)) {
          if (key.startsWith("__jobctrl_preserved_legacy_review_v1")) visit(nested, `${path}/${key}`);
          if (key.startsWith("__jobctrl_resolved_legacy_review_v1") && nested && typeof nested === "object" && "record" in nested) visit((nested as { record: unknown }).record, `${path}/${key}`);
        }
      };
      parsed.data.drafts.forEach((draft, index) => {
        const id = draft && typeof draft === "object" && "id" in draft && typeof draft.id === "string" ? draft.id : String(index);
        visit(draft, `browser:review:${id}`);
      });
    } catch { manifest.errors.push("Review records have an unknown format; raw data is preserved in this bundle."); }
  }
  const after = await port.inspect();
  if (after.errors.length || after.selectedRaw !== records.selectedRaw || after.legacyRaw !== records.legacyRaw || after.reviewsRaw !== records.reviewsRaw) {
    manifest.errors.push("Browser records changed or could not be rechecked during export. Inspect them again before transfer.");
  }
  manifest.complete = manifest.errors.length === 0 && manifest.known_attachment_ids.every((id) => manifest.sources.some((source) => source.source_id === id));
  return manifest;
}

export function ProfileTransferExport() {
  const { profileTransfer, blobDownload } = usePorts();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Pick<BrowserSourcesManifest, "complete" | "known_attachments" | "unavailable_refs" | "errors"> | null>(null);
  const inspect = async (download: boolean) => {
    setPending(true);
    try {
      const manifest = await inspectBrowserSources(profileTransfer);
      setResult({ complete: manifest.complete, known_attachments: manifest.known_attachments, unavailable_refs: manifest.unavailable_refs, errors: manifest.errors });
      if (download) blobDownload.save(new Blob([JSON.stringify(manifest)], { type: "application/json" }), "jobctrl-profile-browser-sources.json");
    } catch { setResult({ complete: false, known_attachments: [], unavailable_refs: [], errors: ["Browser sources could not be inspected. No browser data was changed."] }); }
    finally { setPending(false); }
  };
  return <section className="card" aria-labelledby="browser-sources-title">
    <h2 id="browser-sources-title">Transfer browser-held Profile sources</h2>
    <p>The Profile transfer also needs source PDFs and import review records stored by this browser. Inspect and export them from the original browser before transferring your Profile.</p>
    <div className="toolbar"><Button type="button" variant="outline" disabled={pending} onClick={() => void inspect(false)}>Inspect browser sources</Button>
      <Button type="button" disabled={pending} onClick={() => void inspect(true)}>Export browser source bundle</Button></div>
    {result ? <div role="status"><p>{result.complete ? "All identified browser-held attachment bytes were included in this inspection." : "Browser-held attachment inspection is incomplete; the transfer must not proceed until the issues below are resolved."} {result.known_attachments.length} attachment(s) found{result.unavailable_refs.length ? `; ${result.unavailable_refs.length} review reference(s) have no verified PDF linkage` : ""}.</p>
      {result.known_attachments.map((item) => <p key={item.record_id}>{item.filename}: {item.is_pdf ? "PDF" : "non-PDF bytes retained"}, SHA-256 {item.sha256}</p>)}
      {result.unavailable_refs.map((item) => <p key={item.record_id}>Unresolved review reference {item.record_id}{item.filename ? ` (${item.filename})` : ""}: {item.reason}</p>)}
      {result.errors.map((error) => <p key={error}>{error}</p>)}
    </div> : null}
  </section>;
}
