import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ContactDetail,
  ContactImportResponse,
  ContactSummary,
} from "../src/contracts.js";
import { buildApp } from "../src/server.js";
import { initializeExactV7Database } from "./v7-schema.js";

const SECRET_NAME = "Jane Recruiter";
const SECRET_EMAIL = "jane@acme.example";
const JOB_ID_ONE = "00000000-0000-4000-8000-000000000011";
const JOB_ID_TWO = "00000000-0000-4000-8000-000000000012";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
});

function withTempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-contacts-"));
  const dbPath = path.join(dir, "jobs.db");
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const insertJob = db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
     VALUES ('local', ?, ?, 'Fixture job', '2026-07-31T12:00:00Z')`,
  );
  insertJob.run(JOB_ID_ONE, "https://jobs.example.test/one");
  insertJob.run(JOB_ID_TWO, "https://jobs.example.test/two");
  db.close();
  const app = buildApp({ dbPath, configPath: path.join(dir, "config.json") });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { app, dbPath };
}

async function createContact(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; contact: ContactDetail | undefined; body: unknown }> {
  const res = await app.inject({ method: "POST", url: "/v1/contacts", payload });
  const body = res.json() as { ok: boolean; contact?: ContactDetail };
  return { statusCode: res.statusCode, contact: body.contact, body };
}

describe("contacts API", () => {
  it("creates a contact and renders provenance for every fact (INV-2)", async () => {
    const { app } = withTempApp();
    const { statusCode, contact } = await createContact(app, {
      role: "recruiter",
      employer: "Acme",
      jobId: JOB_ID_ONE,
      attributes: [
        { kind: "name", value: SECRET_NAME },
        { kind: "email", value: SECRET_EMAIL },
      ],
    });
    expect(statusCode).toBe(200);
    expect(contact?.displayName).toBe(SECRET_NAME);
    expect(contact?.role).toBe("recruiter");
    expect(contact?.attributes).toHaveLength(2);
    for (const attribute of contact?.attributes ?? []) {
      expect(attribute.provenance.sourceKind).toBe("user_entered");
      expect(attribute.provenance.captureMethod).toBe("manual");
      expect(attribute.provenance.userConfirmed).toBe(true);
      expect(attribute.provenance.capturedAt).not.toBe("");
    }
  });

  it("lists contacts with source-kind provenance summary", async () => {
    const { app } = withTempApp();
    await createContact(app, {
      role: "recruiter",
      employer: "Acme",
      attributes: [{ kind: "name", value: SECRET_NAME }],
    });
    const res = await app.inject({ method: "GET", url: "/v1/contacts" });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: ContactSummary[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.displayName).toBe(SECRET_NAME);
    expect(items[0]?.sourceKinds).toEqual(["user_entered"]);
    expect(items[0]?.allConfirmed).toBe(true);
  });

  it("filters the list by application (jobId)", async () => {
    const { app } = withTempApp();
    await createContact(app, { employer: "Acme", jobId: JOB_ID_ONE, attributes: [{ kind: "name", value: "A" }] });
    await createContact(app, { employer: "Acme", jobId: JOB_ID_TWO, attributes: [{ kind: "name", value: "B" }] });
    const res = await app.inject({ method: "GET", url: `/v1/contacts?jobId=${JOB_ID_ONE}` });
    const items = (res.json() as { items: ContactSummary[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.jobId).toBe(JOB_ID_ONE);
  });

  it("rejects noncanonical JobId list filters before opening the database", async () => {
    const { app } = withTempApp();
    for (const jobId of [
      "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
      "https://jobs.example.test/not-an-id",
    ]) {
      const res = await app.inject({ method: "GET", url: `/v1/contacts?jobId=${encodeURIComponent(jobId)}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: "invalid_contact_query" });
    }
  });

  it("never leaks attribute values into job_events payloads (sensitivity)", async () => {
    const { app, dbPath } = withTempApp();
    await createContact(app, {
      employer: "Acme",
      attributes: [
        { kind: "name", value: SECRET_NAME },
        { kind: "email", value: SECRET_EMAIL },
      ],
    });
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT tenant_id, job_id, identity_version, event_type, payload_json, entity_kind, entity_ref FROM job_events",
    ).all() as Array<{
      tenant_id: string;
      job_id: string | null;
      identity_version: number;
      event_type: string;
      payload_json: string;
      entity_kind: string;
      entity_ref: string;
    }>;
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.event_type)).toContain("ContactCreated");
    for (const row of rows) {
      expect(row.tenant_id).toBe("local");
      expect(row.identity_version).toBe(1);
      expect(row.entity_kind).toBe("contact");
      expect(row.entity_ref).not.toBe("");
      expect(row.payload_json).not.toContain(SECRET_NAME);
      expect(row.payload_json).not.toContain(SECRET_EMAIL);
    }
  });

  it("rejects a contact with no employer and no jobId", async () => {
    const { app } = withTempApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      payload: { attributes: [{ kind: "name", value: "Nobody" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a URL-shaped JobId before contacts or events are written", async () => {
    const { app, dbPath } = withTempApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      payload: { employer: "Acme", jobId: "https://jobs.example.test/not-an-id" },
    });
    expect(res.statusCode).toBe(400);
    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM contacts").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count).toBe(0);
    db.close();
  });

  it("updates role and re-projects", async () => {
    const { app } = withTempApp();
    const created = await createContact(app, {
      employer: "Acme",
      attributes: [{ kind: "name", value: SECRET_NAME }],
    });
    const contactId = created.contact!.contactId;
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/contacts/${contactId}`,
      payload: { role: "referrer" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { contact: ContactDetail }).contact.role).toBe("referrer");
  });

  it("returns 404 for updating an unknown contact", async () => {
    const { app } = withTempApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/contacts/does-not-exist",
      payload: { role: "referrer" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("soft-deletes a contact and hides it from reads", async () => {
    const { app } = withTempApp();
    const created = await createContact(app, {
      employer: "Acme",
      attributes: [{ kind: "name", value: SECRET_NAME }],
    });
    const contactId = created.contact!.contactId;
    const del = await app.inject({ method: "DELETE", url: `/v1/contacts/${contactId}`, payload: { reason: "dup" } });
    expect(del.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/v1/contacts/${contactId}` });
    expect(detail.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: "/v1/contacts" });
    expect((list.json() as { items: ContactSummary[] }).items).toHaveLength(0);
  });

  it("imports a CSV list, tagging provenance and skipping linkless rows", async () => {
    const { app } = withTempApp();
    const csvText =
      "name,email,employer,role\n" +
      "Bob Manager,bob@globex.example,Globex,hiring_manager\n" +
      "Orphan,orphan@nowhere.example,,\n";
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "referrals.csv", csvText },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json() as ContactImportResponse;
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);

    const detail = await app.inject({ method: "GET", url: `/v1/contacts/${result.contactIds[0]}` });
    const contact = (detail.json() as { contact: ContactDetail }).contact;
    expect(contact.role).toBe("hiring_manager");
    for (const attribute of contact.attributes) {
      expect(attribute.provenance.sourceKind).toBe("user_imported_list");
      expect(attribute.provenance.sourceRef).toBe("referrals.csv");
    }
  });

  it("revalidates CSV job links at commit and still imports valid neighboring rows", async () => {
    const { app, dbPath } = withTempApp();
    const content = [
      "name,employer,job_id",
      "Ready,Review Company,",
      `Linked,,${JOB_ID_TWO}`,
      "Missing,,00000000-0000-4000-8000-000000000099",
    ].join("\n");
    const preview = (
      await app.inject({
        method: "POST",
        url: "/v1/contacts/import",
        payload: { filename: "links.csv", format: "csv", mode: "preview", content },
      })
    ).json() as ContactImportResponse;
    expect(preview.summary).toMatchObject({ ready: 2, invalid: 1 });
    expect(preview.items[2]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_job_link" }),
    ]));

    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM jobs WHERE tenant_id = 'local' AND job_id = ?").run(JOB_ID_TWO);
    db.close();

    const committed = (
      await app.inject({
        method: "POST",
        url: "/v1/contacts/import",
        payload: { filename: "links.csv", format: "csv", mode: "commit", content },
      })
    ).json() as ContactImportResponse;
    expect(committed).toMatchObject({ imported: 1, skipped: 2, summary: { ready: 1, invalid: 2 } });
    const check = new Database(dbPath, { readonly: true });
    expect((check.prepare("SELECT COUNT(*) AS count FROM contacts").get() as { count: number }).count).toBe(1);
    check.close();
  });

  it("previews vCard 3.0/4.0 facts and outcomes without writing SQLite", async () => {
    const { app, dbPath } = withTempApp();
    const content = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Dana\\, Reyes",
      "ORG:Acme\\; Research;People",
      "item1.EMAIL;TYPE=work:dana@acme.example",
      "TITLE:VP Talent",
      "PHOTO;VALUE=uri:https://images.example.test/dana.jpg",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "N:Blake;Morgan;;;",
      "ORG:Globex",
      "TEL;VALUE=uri:tel:+1-555-0102",
      "URL:https://globex.example/people/morgan",
      "NOTE:Met at the unicode",
      " conference",
      "END:VCARD",
    ].join("\r\n");
    const before = new Database(dbPath, { readonly: true });
    const beforeContacts = (before.prepare("SELECT COUNT(*) AS count FROM contacts").get() as { count: number }).count;
    const beforeEvents = (before.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count;
    before.close();

    const response = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "network.vcf", format: "vcard", mode: "preview", content },
    });
    expect(response.statusCode).toBe(200);
    const preview = response.json() as ContactImportResponse;
    expect(preview).toMatchObject({
      format: "vcard",
      mode: "preview",
      imported: 0,
      summary: { total: 2, ready: 2, duplicates: 0, invalid: 0, unsupported: 1 },
    });
    expect(preview.items[0]).toMatchObject({
      displayName: "Dana, Reyes",
      employer: "Acme; Research",
      role: "other",
      status: "ready",
    });
    expect(preview.items[0]?.attributes).toEqual(expect.arrayContaining([
      { kind: "email", value: "dana@acme.example" },
      { kind: "title", value: "VP Talent" },
    ]));
    expect(preview.items[0]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported_property", property: "PHOTO", severity: "warning" }),
      expect.objectContaining({ code: "ignored_parameter", property: "EMAIL", severity: "warning" }),
    ]));
    expect(preview.items[1]?.attributes).toEqual(expect.arrayContaining([
      { kind: "name", value: "Morgan Blake" },
      { kind: "phone", value: "+1-555-0102" },
      { kind: "profile_url", value: "https://globex.example/people/morgan" },
      { kind: "note", value: "Met at the unicodeconference" },
    ]));

    const after = new Database(dbPath, { readonly: true });
    expect((after.prepare("SELECT COUNT(*) AS count FROM contacts").get() as { count: number }).count).toBe(beforeContacts);
    expect((after.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count).toBe(beforeEvents);
    after.close();
  });

  it("commits reviewed vCards with filename provenance and deduplicates replay", async () => {
    const { app } = withTempApp();
    const content = "BEGIN:VCARD\nVERSION:4.0\nFN:Dana Reyes\nORG:Acme\nEMAIL:dana@acme.example\nTITLE:VP Talent\nEND:VCARD";
    const first = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "network.vcf", format: "vcard", mode: "commit", content },
    });
    const committed = first.json() as ContactImportResponse;
    expect(committed).toMatchObject({ imported: 1, skipped: 0, summary: { ready: 1, duplicates: 0, invalid: 0 } });
    const detail = await app.inject({ method: "GET", url: `/v1/contacts/${committed.contactIds[0]}` });
    const contact = (detail.json() as { contact: ContactDetail }).contact;
    expect(contact.role).toBe("other");
    expect(contact.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "title", value: "VP Talent" }),
    ]));
    for (const attribute of contact.attributes) {
      expect(attribute.provenance).toMatchObject({
        sourceKind: "user_imported_list",
        sourceRef: "network.vcf",
      });
    }

    const replay = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "network.vcf", format: "vcard", mode: "commit", content },
    });
    expect(replay.json()).toMatchObject({ imported: 0, skipped: 1, summary: { duplicates: 1 } });
  });

  it("reports malformed, unsupported encodings and ambiguous identifiers without importing", async () => {
    const { app } = withTempApp();
    await createContact(app, {
      employer: "Acme",
      attributes: [{ kind: "email", value: "same@acme.example" }],
    });
    await createContact(app, {
      employer: "Acme",
      attributes: [{ kind: "phone", value: "+1 555 0109" }],
    });
    const content = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN;ENCODING=QUOTED-PRINTABLE:Dana=20Reyes",
      "ORG:Acme",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Ambiguous Person",
      "ORG:Acme",
      "EMAIL:same@acme.example",
      "TEL:+1 555 0109",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:2.1",
      "FN:Old Card",
      "ORG:Acme",
      "END:VCARD",
    ].join("\n");
    const response = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "unsafe.vcf", format: "vcard", mode: "commit", content },
    });
    const result = response.json() as ContactImportResponse;
    expect(result.imported).toBe(0);
    expect(result.summary.invalid).toBe(3);
    expect(result.items.map((item) => item.issues.map((issue) => issue.code))).toEqual([
      expect.arrayContaining(["unsupported_encoding"]),
      expect.arrayContaining(["ambiguous_identity"]),
      expect.arrayContaining(["unsupported_version"]),
    ]);
  });

  it("decodes escaped vCard text exactly once and rejects qualified TEL URI identity", async () => {
    const { app } = withTempApp();
    const escapedName = String.raw`Test\name`;
    const content = String.raw`BEGIN:VCARD
VERSION:4.0
FN:Test\\name
ORG:Acme
TEL;VALUE=uri:tel:5550100;phone-context=office-a.example
END:VCARD`;
    const response = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "qualified.vcf", format: "vcard", mode: "preview", content },
    });
    const preview = response.json() as ContactImportResponse;
    expect(preview.items[0]?.displayName).toBe(escapedName);
    expect(preview.items[0]?.attributes.find((attribute) => attribute.kind === "name")?.value).toBe(escapedName);
    expect(preview.items[0]).toMatchObject({ status: "invalid" });
    expect(preview.items[0]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported_qualified_tel_uri", property: "TEL" }),
    ]));
  });

  it("does not erase unsafe phone qualifiers when deduplicating", async () => {
    const { app } = withTempApp();
    await createContact(app, {
      employer: "Acme",
      attributes: [{ kind: "phone", value: "5550100 ext 1" }],
    });
    const content = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Safe Plain Phone",
      "ORG:Acme",
      "TEL:+55501001",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:SIP Phone",
      "ORG:Acme",
      "TEL;VALUE=uri:sip:55501001@office.example",
      "END:VCARD",
    ].join("\n");
    const result = (
      await app.inject({
        method: "POST",
        url: "/v1/contacts/import",
        payload: { filename: "phones.vcf", format: "vcard", mode: "preview", content },
      })
    ).json() as ContactImportResponse;
    expect(result.items[0]).toMatchObject({ status: "ready", duplicate: null });
    expect(result.items[1]).toMatchObject({ status: "invalid" });
    expect(result.items[1]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported_tel_uri" }),
    ]));
  });

  it("preserves imported provenance on unrelated edits (INV-2 regression)", async () => {
    const { app } = withTempApp();
    const csvText =
      "name,email,employer,role\n" + "Bob Manager,bob@globex.example,Globex,hiring_manager\n";
    const imported = (
      await app.inject({
        method: "POST",
        url: "/v1/contacts/import",
        payload: { filename: "referrals.csv", csvText },
      })
    ).json() as ContactImportResponse;
    const contactId = imported.contactIds[0]!;
    const before = (
      (await app.inject({ method: "GET", url: `/v1/contacts/${contactId}` })).json() as {
        contact: ContactDetail;
      }
    ).contact;
    const originalByKind = new Map(before.attributes.map((attribute) => [attribute.kind, attribute]));

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/contacts/${contactId}`,
      payload: {
        role: "referrer",
        attributes: [
          { kind: "name", value: "Bob Manager" },
          { kind: "email", value: "bob@globex.example" },
          { kind: "phone", value: "+1 555 0100" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const after = (res.json() as { contact: ContactDetail }).contact;
    const afterByKind = new Map(after.attributes.map((attribute) => [attribute.kind, attribute]));
    for (const kind of ["name", "email"]) {
      const kept = afterByKind.get(kind)!;
      const original = originalByKind.get(kind)!;
      expect(kept.provenance.sourceKind).toBe("user_imported_list");
      expect(kept.provenance.sourceRef).toBe("referrals.csv");
      expect(kept.provenance.capturedAt).toBe(original.provenance.capturedAt);
      expect(kept.attributeId).toBe(original.attributeId);
    }
    expect(afterByKind.get("phone")!.provenance.sourceKind).toBe("user_entered");

    const revalued = await app.inject({
      method: "PATCH",
      url: `/v1/contacts/${contactId}`,
      payload: {
        attributes: [
          { kind: "name", value: "Bob Manager" },
          { kind: "email", value: "bob.manager@globex.example" },
        ],
      },
    });
    const finalByKind = new Map(
      (revalued.json() as { contact: ContactDetail }).contact.attributes.map((attribute) => [
        attribute.kind,
        attribute,
      ]),
    );
    expect(finalByKind.get("name")!.provenance.sourceKind).toBe("user_imported_list");
    expect(finalByKind.get("email")!.provenance.sourceKind).toBe("user_entered");
  });
});
