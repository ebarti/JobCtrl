import { ProfileSchema } from "@jobctrl/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { InMemoryStoragePort } from "../../../test/testPorts.js";
import { useProfileImportReviewStore, type ProfileImportReviewDraft } from "./profile-import-review-store.js";

const storage = new InMemoryStoragePort();
const key = "jh:profile-import-review-v1";
const draft = (filename: string) => ({
  tenantId: "local", filename, importProfile: true, importStyle: false,
  base: structuredClone(sampleProfileResponse),
  result: { profile: { personal: { full_name: `Synthetic ${filename}` } },
    source: { attemptId: crypto.randomUUID(), determinationId: "a".repeat(64), extractedPersonal: { full_name: `Synthetic ${filename}` } } },
});
const resetMemory = () => useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });

beforeEach(() => {
  InMemoryStoragePort.transactionValues.clear();
  InMemoryStoragePort.failWrite = null;
  InMemoryStoragePort.failTransaction = null;
  resetMemory();
});

describe("browser review draft storage", () => {
  it("uses the source attempt as draft identity and refuses to replace it with another draft", async () => {
    const original = draft("first.pdf");
    expect(await useProfileImportReviewStore.getState().stage(original, storage)).toBe(true);
    const before = InMemoryStoragePort.transactionValues.get(key)!;
    expect(JSON.parse(before).drafts[0].id).toBe(original.result.source.attemptId);
    expect(await useProfileImportReviewStore.getState().stage(original, storage)).toBe(true);
    expect(await useProfileImportReviewStore.getState().stage({ ...original, filename: "different.pdf" }, storage)).toBe(false);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(before);
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
  });

  it("refuses to rebase an invalid v2 projection without changing its stored bytes", async () => {
    const invalid = { id: "invalid-v2", revision: 0, projectionVersion: 2, tenantId: "local", filename: "synthetic.pdf",
      importProfile: false, importStyle: true, attempt: null,
      base: { profileVersion: 3, profile: { personal: {} } },
      result: { style: { font_family: "roman", synthetic_unexpected: "synthetic-private-style" } } };
    const raw = JSON.stringify({ version: 2, drafts: [invalid] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(true);
    const stored = useProfileImportReviewStore.getState().drafts[0]!;
    expect(await useProfileImportReviewStore.getState().rebase(stored, sampleProfileResponse, storage)).toBe(false);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
  });

  it.each(["unexpected fields", "unsupported version"])("preserves a v1 draft when its projection has %s", async (damage) => {
    const projected = {
      id: "projected-v1", revision: 1, projectionVersion: damage === "unsupported version" ? 3 : 1,
      tenantId: "local", filename: "synthetic-v1.pdf", importProfile: true, importStyle: false, attempt: null,
      base: { profileVersion: 4, profile: { personal: { full_name: "Synthetic imported A" } } },
      result: { profile: { personal: { full_name: "Synthetic imported A", ...(damage === "unexpected fields" ? { extra: "synthetic-unexpected" } : {}) },
        resume: { executive_profile: {}, experience_entries: [], education_entries: [], skill_categories: [] } } },
    };
    const raw = JSON.stringify({ version: 1, drafts: [projected] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(true);
    const stored = useProfileImportReviewStore.getState().drafts[0]!;
    const current = { ...structuredClone(sampleProfileResponse), profileVersion: 5 };
    expect(await useProfileImportReviewStore.getState().rebase(stored, current, storage)).toBe(false);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    expect(useProfileImportReviewStore.getState().drafts[0]).toEqual(projected);
  });

  it("retains unexpected fields in a newer record when a user removes the draft", async () => {
    expect(await useProfileImportReviewStore.getState().stage(draft("newer.pdf"), storage)).toBe(true);
    const stored = JSON.parse(InMemoryStoragePort.transactionValues.get(key)!);
    stored.drafts[0].base.profile.legacy_only = "synthetic-unexpected-base-data";
    InMemoryStoragePort.transactionValues.set(key, JSON.stringify(stored));
    resetMemory();
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(true);
    expect(await useProfileImportReviewStore.getState().discard(useProfileImportReviewStore.getState().drafts[0]!, storage)).toBe(true);
    expect(InMemoryStoragePort.transactionValues.get(key)).toContain("synthetic-unexpected-base-data");
  });

  it("fences an older v1-only tab from deleting a retained recovery record", async () => {
    const legacy = { ...draft("legacy.pdf"), id: "legacy-draft", revision: 0, attempt: null };
    InMemoryStoragePort.transactionValues.set(key, JSON.stringify({ version: 1, drafts: [legacy] }));
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(true);
    expect(await useProfileImportReviewStore.getState().discard(useProfileImportReviewStore.getState().drafts[0]!, storage)).toBe(true);
    const retained = InMemoryStoragePort.transactionValues.get(key)!;
    const oldEnvelope = z.object({ version: z.literal(1), drafts: z.array(z.unknown()) }).strict();
    await expect(storage.transact(key, (raw) => {
      const parsed = oldEnvelope.safeParse(JSON.parse(raw!));
      if (!parsed.success) throw new Error("Old tab refuses the newer envelope");
      return { result: null, write: JSON.stringify({ version: 1, drafts: [] }) };
    })).rejects.toThrow(/refuses/);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(retained);
    resetMemory();
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(true);
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
  });

  it("refuses rebase when an older rebased draft has an unreadable original snapshot", async () => {
    const base = structuredClone(sampleProfileResponse);
    const legacy = { ...draft("legacy.pdf"), id: "legacy-draft", revision: 1, projectionVersion: 1,
      base, __jobctrl_preserved_legacy_review_v1: { damaged: "synthetic-original-bytes" }, attempt: null };
    const raw = JSON.stringify({ version: 1, drafts: [legacy] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(true);
    const draftToRebase = useProfileImportReviewStore.getState().drafts[0]!;
    expect(await useProfileImportReviewStore.getState().rebase(draftToRebase, base, storage)).toBe(false);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
  });

  it("retains a complete legacy record atomically through rebase and reload", async () => {
    const base = structuredClone(sampleProfileResponse);
    const profile = ProfileSchema.parse(base.profile);
    profile.personal.password = "synthetic-legacy-only-password";
    base.profile = { ...profile, legacy_only: "synthetic-only-in-old-base" };
    const legacy = {
      ...draft("legacy.pdf"), id: "legacy-draft", revision: 2, base,
      result: { profile: { personal: { full_name: "Synthetic reviewed" } }, source: { text_preview: "synthetic-legacy-preview" } },
      attempt: null,
    };
    const keyCollision = "__jobctrl_preserved_legacy_review_v1";
    const existing = { ...legacy, [keyCollision]: "synthetic-existing-key" };
    const raw = JSON.stringify({ version: 1, drafts: [existing] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(true);
    const retained = useProfileImportReviewStore.getState().drafts[0]!;
    const newer = { ...structuredClone(sampleProfileResponse), profileVersion: base.profileVersion! + 1 };
    InMemoryStoragePort.failWrite = () => true;
    expect(await useProfileImportReviewStore.getState().rebase(retained, newer, storage)).toBe(false);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    expect(useProfileImportReviewStore.getState().drafts[0]).toEqual(existing);

    InMemoryStoragePort.failWrite = null;
    expect(await useProfileImportReviewStore.getState().rebase(retained, newer, storage)).toBe(true);
    const saved = JSON.parse(InMemoryStoragePort.transactionValues.get(key)!).drafts[0];
    expect(saved[keyCollision]).toBe("synthetic-existing-key");
    expect(saved[`${keyCollision}_`]).toEqual(existing);
    expect(saved.base.profileVersion).toBe(newer.profileVersion);
    expect(saved.base.profile).not.toHaveProperty("legacy_only");
    resetMemory();
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(true);
    expect(useProfileImportReviewStore.getState().drafts[0]).toEqual(saved);
    const afterReload = useProfileImportReviewStore.getState().drafts[0]!;
    const nextVersion = { ...newer, profileVersion: newer.profileVersion + 1 };
    expect(await useProfileImportReviewStore.getState().rebase(afterReload, nextVersion, storage)).toBe(true);
    const rebasedAgain = JSON.parse(InMemoryStoragePort.transactionValues.get(key)!).drafts[0];
    expect(rebasedAgain[`${keyCollision}_`]).toEqual(existing);
    expect(rebasedAgain).not.toHaveProperty(`${keyCollision}__`);
  });

  it("stores only review fields and version bindings, including after a rebase", async () => {
    const canonical = structuredClone(sampleProfileResponse);
    const input: Omit<ProfileImportReviewDraft, "id" | "revision" | "attempt"> = { ...draft("private.pdf"), base: canonical };
    const originalProfile = ProfileSchema.parse(canonical.profile);
    originalProfile.personal.password = "synthetic-password-never-persist";
    originalProfile.work_authorization.legally_authorized_to_work = "synthetic-unrelated-profile";
    canonical.profile = originalProfile;
    const canonicalBefore = structuredClone(canonical);
    input.result = {
      profile: {
        personal: { full_name: "Synthetic imported name", password: "synthetic-password-never-persist" },
        work_authorization: { private_note: "synthetic-unrelated-profile" },
        resume: { experience_entries: [{ title: "Synthetic reviewed role", company: "Synthetic employer", bullets: ["Synthetic reviewed bullet"], achievement_evidence: [{ source_text: "synthetic-unrelated-evidence" }] }] },
      },
      source: { attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), candidateDeterminationId: "b".repeat(64), text_preview: "synthetic-private-preview", candidateInterpretation: { private: "synthetic-unrelated-interpretation" }, warnings: ["Synthetic warning"] },
    };

    expect(await useProfileImportReviewStore.getState().stage(input, storage)).toBe(true);
    const checkStored = () => {
      const raw = InMemoryStoragePort.transactionValues.get(key)!;
      for (const secret of ["synthetic-password-never-persist", "synthetic-unrelated-profile", "synthetic-unrelated-evidence", "synthetic-private-preview", "synthetic-unrelated-interpretation"])
        expect(raw).not.toContain(secret);
      return JSON.parse(raw).drafts[0];
    };
    let saved = checkStored();
    expect(saved.projectionVersion).toBe(2);
    expect(saved.base.profile).not.toHaveProperty("resume");
    expect(saved.base.profile.personal).not.toHaveProperty("password");
    expect(saved.result.profile.personal).not.toHaveProperty("password");
    expect(saved.result.profile.resume.experience_entries[0]).not.toHaveProperty("achievement_evidence");
    expect(saved.result.profile.personal.full_name).toBe("Synthetic imported name");
    expect(saved.result.profile.resume.experience_entries[0]).toMatchObject({ title: "Synthetic reviewed role", bullets: ["Synthetic reviewed bullet"] });
    expect(saved.result.source).toEqual({ attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), candidateDeterminationId: "b".repeat(64), warnings: ["Synthetic warning"] });
    expect(canonical).toEqual(canonicalBefore);

    resetMemory();
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(true);
    const retained = useProfileImportReviewStore.getState().drafts[0]!;
    const newer = { ...canonical, profileVersion: canonical.profileVersion! + 1 };
    expect(await useProfileImportReviewStore.getState().rebase(retained, newer, storage)).toBe(true);
    saved = checkStored();
    expect(saved.base.profileVersion).toBe(newer.profileVersion);
    expect(saved.result.profile.resume.experience_entries[0].title).toBe("Synthetic reviewed role");
    expect(Object.keys(saved).some((name) => name.startsWith("__jobctrl_preserved_legacy_review"))).toBe(false);
  });

  it("retains concurrent drafts on reload and removes only the chosen draft", async () => {
    expect(await Promise.all([
      useProfileImportReviewStore.getState().stage(draft("one.pdf"), storage),
      useProfileImportReviewStore.getState().stage(draft("two.pdf"), storage),
    ])).toEqual([true, true]);
    resetMemory();
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(true);
    const drafts = useProfileImportReviewStore.getState().drafts;
    expect(drafts.map((item) => item.filename)).toEqual(["one.pdf", "two.pdf"]);
    expect(await useProfileImportReviewStore.getState().discard(drafts[0]!, storage)).toBe(true);
    resetMemory();
    await useProfileImportReviewStore.getState().hydrate(storage);
    expect(useProfileImportReviewStore.getState().drafts.map((item) => item.filename)).toEqual(["two.pdf"]);
  });

  it("keeps a failed write in session and retries without replacing corrupt stored bytes", async () => {
    InMemoryStoragePort.transactionValues.set(key, "synthetic-invalid-record");
    expect(await useProfileImportReviewStore.getState().stage(draft("retry.pdf"), storage)).toBe(false);
    expect(useProfileImportReviewStore.getState()).toMatchObject({ storageError: true, drafts: [{ filename: "retry.pdf" }] });
    expect(await useProfileImportReviewStore.getState().retry(storage)).toBe(false);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe("synthetic-invalid-record");
    InMemoryStoragePort.transactionValues.delete(key);
    expect(await useProfileImportReviewStore.getState().retry(storage)).toBe(true);
    resetMemory();
    await useProfileImportReviewStore.getState().hydrate(storage);
    expect(useProfileImportReviewStore.getState().drafts.map((item) => item.filename)).toEqual(["retry.pdf"]);
  });

  it("preserves the earlier base and draft when rebase or removal storage fails", async () => {
    await useProfileImportReviewStore.getState().stage(draft("one.pdf"), storage);
    const first = useProfileImportReviewStore.getState().drafts[0]!;
    const before = InMemoryStoragePort.transactionValues.get(key);
    InMemoryStoragePort.failWrite = () => true;
    const newer = { ...draft("one.pdf").base, profileVersion: first.base.profileVersion! + 1 };
    expect(await useProfileImportReviewStore.getState().rebase(first, newer, storage)).toBe(false);
    expect(await useProfileImportReviewStore.getState().discard(first, storage)).toBe(false);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(before);
    resetMemory();
    InMemoryStoragePort.failWrite = null;
    await useProfileImportReviewStore.getState().hydrate(storage);
    expect(useProfileImportReviewStore.getState().drafts[0]).toMatchObject({ id: first.id, base: first.base });
  });

  it("records attempts before dispatch and refuses stale rebase or clearing after another retry", async () => {
    await useProfileImportReviewStore.getState().stage(draft("one.pdf"), storage);
    const original = useProfileImportReviewStore.getState().drafts[0]!;
    const first = await useProfileImportReviewStore.getState().beginAttempt(original, ["experience"], storage);
    expect(first?.attempt).toEqual({ profileVersion: original.base.profileVersion, sections: ["experience"], count: 1 });
    expect(await useProfileImportReviewStore.getState().rebase(first!, draft("one.pdf").base, storage)).toBe(false);
    const retry = await useProfileImportReviewStore.getState().beginAttempt(first!, ["experience"], storage);
    expect(retry?.attempt?.count).toBe(2);
    expect(await useProfileImportReviewStore.getState().clearRejectedAttempt(first!, storage)).toBe(false);
    resetMemory();
    await useProfileImportReviewStore.getState().hydrate(storage);
    expect(useProfileImportReviewStore.getState().drafts[0]?.attempt?.count).toBe(2);
  });

  it("does not treat a missing stored attempt marker as a fresh draft", async () => {
    await useProfileImportReviewStore.getState().stage(draft("one.pdf"), storage);
    const first = useProfileImportReviewStore.getState().drafts[0]!;
    await useProfileImportReviewStore.getState().beginAttempt(first, ["experience"], storage);
    const damaged = JSON.parse(InMemoryStoragePort.transactionValues.get(key)!);
    delete damaged.drafts[0].attempt;
    const raw = JSON.stringify(damaged);
    InMemoryStoragePort.transactionValues.set(key, raw);
    resetMemory();
    expect(await useProfileImportReviewStore.getState().hydrate(storage)).toBe(false);
    expect(useProfileImportReviewStore.getState().storageError).toBe(true);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
  });
});
