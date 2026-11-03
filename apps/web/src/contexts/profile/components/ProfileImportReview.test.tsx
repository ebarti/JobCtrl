import { JobCtrlApiError } from "@jobctrl/api-client";
import { ProfileSchema, type ProfileUpdateRequest } from "@jobctrl/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts, InMemoryStoragePort } from "../../../test/testPorts.js";
import { useProfileImportReviewStore } from "../stores/profile-import-review-store.js";
import { ProfileImportReview } from "./ProfileImportReview.js";

const storage = new InMemoryStoragePort();

async function stage() {
  const base = structuredClone(sampleProfileResponse);
  base.profile = ProfileSchema.parse(ProfileSchema.parse(base.profile));
  await useProfileImportReviewStore.getState().stage({
    tenantId: "local",
    filename: "synthetic.pdf",
    importProfile: true,
    importStyle: true,
    base,
    result: {
      profile: {
        personal: { full_name: "Synthetic extracted name" },
        resume: {
          experience_entries: [
            {
              title: "Synthetic role",
              company: "Synthetic company",
              bullets: ["Synthetic result"],
            },
          ],
          education_entries: [],
          skill_categories: [],
          executive_profile: { baseline_text: "Synthetic summary" },
        },
      },
      style: { font_family: "roman" },
      source: { attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), extractedPersonal: { full_name: "Synthetic extracted name" },
        styleReceiptId: "00000000-0000-4000-8000-000000000001", inferredStyle: { font_family: "roman" } },
    },
  }, storage);
  return base;
}

beforeEach(() => {
  InMemoryStoragePort.transactionValues.clear();
  InMemoryStoragePort.failTransaction = null;
  InMemoryStoragePort.failWrite = null;
  useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
});

describe("import review", () => {
  it("keeps a complete swapped source tuple under another draft identity in recovery", async () => {
    await stage();
    const key = "jh:profile-import-review-v1";
    const stored = JSON.parse(InMemoryStoragePort.transactionValues.get(key)!);
    const firstId = stored.drafts[0].id;
    const secondId = "00000000-0000-4000-8000-000000000002";
    expect(firstId).not.toBe(secondId);
    stored.drafts[0].result = {
      profile: { personal: { full_name: "Synthetic second import" }, resume: {
        executive_profile: {}, experience_entries: [], education_entries: [], skill_categories: [],
      } }, style: { font_family: "sans" },
      source: { attemptId: secondId, determinationId: "b".repeat(64),
        extractedPersonal: { full_name: "Synthetic second import" }, styleReceiptId: secondId, inferredStyle: { font_family: "sans" } },
    };
    const swapped = structuredClone(stored.drafts[0]);
    const raw = JSON.stringify(stored);
    InMemoryStoragePort.transactionValues.set(key, raw);
    useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
    const updateProfile = vi.fn();
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { updateProfile } }) });
    await screen.findByText(/fields whose extraction source cannot be verified/i);
    expect(screen.queryByRole("button", { name: "Accept selected sections" })).not.toBeInTheDocument();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show recovery JSON" }));
    expect(JSON.parse((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value)).toEqual(swapped);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("keeps a pre-attempt summary-only draft recoverable without importing it", async () => {
    const legacy = { id: "legacy-summary", revision: 0, projectionVersion: 2, tenantId: "local", filename: "synthetic.pdf",
      importProfile: true, importStyle: false, attempt: null, base: { profileVersion: 4, profile: { personal: {} } },
      result: { profile: { personal: {}, resume: { executive_profile: { baseline_text: "Synthetic old summary" },
        experience_entries: [], education_entries: [], skill_categories: [] } }, source: { determinationId: "a".repeat(64) } } };
    const key = "jh:profile-import-review-v1";
    const raw = JSON.stringify({ version: 2, drafts: [legacy] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    const updateProfile = vi.fn();
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { updateProfile } }) });
    await screen.findByText(/fields whose extraction source cannot be verified/i);
    expect(screen.queryByRole("button", { name: "Accept selected sections" })).not.toBeInTheDocument();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show recovery JSON" }));
    expect(JSON.parse((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value)).toEqual(legacy);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("accepts a verified same-version v1 style directly", async () => {
    const current = structuredClone(sampleProfileResponse);
    current.profile = ProfileSchema.parse(ProfileSchema.parse(current.profile));
    const valid = { id: "00000000-0000-4000-8000-000000000001", revision: 0, projectionVersion: 1,
      tenantId: "local", filename: "synthetic-v1.pdf", importProfile: false, importStyle: true, attempt: null,
      base: { profileVersion: current.profileVersion, profile: { personal: {} } },
      result: { style: { font_family: "roman" }, source: {
        attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), styleReceiptId: "00000000-0000-4000-8000-000000000001", inferredStyle: { font_family: "roman" },
      } } };
    InMemoryStoragePort.transactionValues.set("jh:profile-import-review-v1", JSON.stringify({ version: 1, drafts: [valid] }));
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({ ...current, style: request.style, profileVersion: current.profileVersion! + 1 }));
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { profile: vi.fn(async () => current), updateProfile } }) });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Resume style" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    expect(updateProfile.mock.calls[0]![0]).toMatchObject({ expectedProfileVersion: current.profileVersion, style: { font_family: "roman" } });
    expect(await screen.findByRole("button", { name: "Show recovery JSON" })).toBeVisible();
  });

  it.each(["unsupported v3", "ambiguous v1", "ambiguous v2"])("refuses same-version acceptance of %s and preserves recovery", async (kind) => {
    const current = structuredClone(sampleProfileResponse);
    current.profile = ProfileSchema.parse(ProfileSchema.parse(current.profile));
    const invalid = {
      id: "00000000-0000-4000-8000-000000000001", revision: 0, projectionVersion: kind === "unsupported v3" ? 3 : kind === "ambiguous v1" ? 1 : 2,
      tenantId: "local", filename: "synthetic-invalid.pdf", importProfile: false, importStyle: true, attempt: null,
      base: { profileVersion: current.profileVersion, profile: { personal: {} } },
      result: { style: { font_family: "roman", ...(kind === "unsupported v3" ? {} : { synthetic_unexpected: "synthetic-private-style" }) },
        source: { attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), styleReceiptId: "00000000-0000-4000-8000-000000000001", inferredStyle: { font_family: "roman" } } },
    };
    const key = "jh:profile-import-review-v1";
    const raw = JSON.stringify({ version: 1, drafts: [invalid] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    const profile = vi.fn(async () => current);
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({ ...current, style: request.style, profileVersion: current.profileVersion! + 1 }));
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { profile, updateProfile } }) });
    if (kind === "unsupported v3") {
      fireEvent.click(await screen.findByRole("checkbox", { name: "Resume style" }));
      fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
      await screen.findByText(/review data could not be verified/i);
    } else {
      await screen.findByText(/fields whose extraction source cannot be verified/i);
      expect(screen.queryByRole("checkbox", { name: "Resume style" })).not.toBeInTheDocument();
    }
    expect(profile).not.toHaveBeenCalled();
    expect(updateProfile).not.toHaveBeenCalled();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show recovery JSON" }));
    expect(JSON.parse((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value)).toEqual(invalid);
  });

  it("retains an already-projected v1 change across a matching intermediate base, rebase and reload", async () => {
    const v1 = {
      id: "00000000-0000-4000-8000-000000000001", revision: 1, projectionVersion: 1, tenantId: "local", filename: "synthetic-v1.pdf",
      importProfile: true, importStyle: false, attempt: null,
      base: { profileVersion: 4, profile: { personal: { full_name: "Synthetic imported A" } } },
      result: { profile: { personal: { full_name: "Synthetic imported A" }, resume: {
        executive_profile: {}, experience_entries: [], education_entries: [], skill_categories: [],
      } }, source: { attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), extractedPersonal: { full_name: "Synthetic imported A" } } },
    };
    const key = "jh:profile-import-review-v1";
    const raw = JSON.stringify({ version: 1, drafts: [v1] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    const current = structuredClone(sampleProfileResponse);
    const canonical = ProfileSchema.parse(ProfileSchema.parse(current.profile));
    canonical.personal.full_name = "Synthetic current B";
    canonical.personal.password = "synthetic-canonical-password";
    canonical.resume.experience_entries[0]!.achievement_evidence = [{
      id: "synthetic-evidence", source_text: "Synthetic accepted evidence", scope: "", action: "", tools: [], metrics: [],
      outcome: "", evidence_strength: "verified", claim_confidence: 1, user_confirmed: true, tags: [],
    }];
    current.profile = canonical;
    current.profileVersion = 5;
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({ ...current, profile: request.profile, profileVersion: 6 }));
    const ports = buildTestPorts({ api: { profile: vi.fn(async () => current), updateProfile } });
    const view = renderWithProviders(<ProfileImportReview />, { ports });
    await screen.findByText("synthetic-v1.pdf");
    expect(screen.queryByRole("checkbox", { name: "Personal details" })).not.toBeInTheDocument();
    InMemoryStoragePort.failWrite = () => true;
    fireEvent.click(screen.getByRole("button", { name: "Load latest saved profile" }));
    await screen.findByText(/could not be saved/i);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    InMemoryStoragePort.failWrite = null;
    fireEvent.click(screen.getByRole("button", { name: "Load latest saved profile" }));
    await screen.findByText(/latest saved profile loaded/i);
    expect(screen.getByText("Full name: Synthetic imported A")).toBeVisible();
    expect(InMemoryStoragePort.transactionValues.get(key)).not.toContain("synthetic-canonical-password");
    view.unmount();
    useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
    renderWithProviders(<ProfileImportReview />, { ports });
    await screen.findByText("Full name: Synthetic imported A");
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    const saved = ProfileSchema.parse(updateProfile.mock.calls[0]![0].profile);
    expect(saved.personal.full_name).toBe("Synthetic imported A");
    expect(saved.resume.experience_entries[0]!.achievement_evidence).toEqual(canonical.resume.experience_entries[0]!.achievement_evidence);
    fireEvent.click(await screen.findByRole("button", { name: "Show recovery JSON" }));
    const recovered = JSON.parse((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value);
    expect(recovered.__jobctrl_preserved_legacy_review_v1).toEqual(v1);
  });

  it("reveals and copies no recovery data without an explicit user action", async () => {
    const base = structuredClone(sampleProfileResponse);
    base.profile = { ...ProfileSchema.parse(base.profile), legacy_only: "synthetic-private-recovery-data" };
    const legacy = { id: "legacy-draft", revision: 0, tenantId: "local", filename: "synthetic-legacy.pdf", importProfile: true, importStyle: false,
      base, result: { profile: { personal: { full_name: "Synthetic reviewed" } } }, attempt: null };
    InMemoryStoragePort.transactionValues.set("jh:profile-import-review-v1", JSON.stringify({ version: 1, drafts: [legacy] }));
    const profile = vi.fn();
    const updateProfile = vi.fn();
    const ports = buildTestPorts({ api: { profile, updateProfile } });
    const copy = vi.spyOn(ports.clipboard, "write");
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      renderWithProviders(<ProfileImportReview />, { ports });
      await screen.findByText(/fields whose extraction source cannot be verified/i);
      expect(screen.queryByRole("textbox", { name: "Preserved legacy review JSON" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
      const show = await screen.findByRole("button", { name: "Show recovery JSON" });
      expect(screen.queryByRole("textbox", { name: "Preserved legacy review JSON" })).not.toBeInTheDocument();
      expect(screen.getByText(/may contain sensitive profile information/i)).toBeVisible();
      expect(copy).not.toHaveBeenCalled();
      fireEvent.click(show);
      expect((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value).toContain("synthetic-private-recovery-data");
      expect(copy).not.toHaveBeenCalled();
      expect(profile).not.toHaveBeenCalled();
      expect(updateProfile).not.toHaveBeenCalled();
      expect(logs.flatMap((spy) => spy.mock.calls.flat().map(String)).join(" ")).not.toContain("synthetic-private-recovery-data");
    } finally {
      logs.forEach((spy) => spy.mockRestore());
    }
  });

  it("does not reinterpret an unconfirmed save from a previously rebased legacy draft", async () => {
    const base = structuredClone(sampleProfileResponse);
    const legacy = { id: "legacy-draft", revision: 0, tenantId: "local", filename: "synthetic-legacy.pdf", importProfile: true, importStyle: false,
      base, result: { profile: { personal: { full_name: "Synthetic reviewed" } } }, attempt: null };
    const pending = { ...legacy, revision: 2, projectionVersion: 1,
      __jobctrl_preserved_legacy_review_v1: legacy,
      attempt: { profileVersion: base.profileVersion, sections: ["personal"], count: 1 } };
    const key = "jh:profile-import-review-v1";
    const raw = JSON.stringify({ version: 1, drafts: [pending] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    const profile = vi.fn();
    const updateProfile = vi.fn();
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { profile, updateProfile } }) });
    await screen.findByText(/previous save was attempted and may have completed/i);
    expect(screen.queryByRole("button", { name: "Retry original save" })).not.toBeInTheDocument();
    expect(profile).not.toHaveBeenCalled();
    expect(updateProfile).not.toHaveBeenCalled();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Remove review draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show recovery JSON" }));
    expect(JSON.parse((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value)).toEqual(pending);
  });

  it("keeps a previously rebased legacy draft without source proof in recovery", async () => {
    const base = structuredClone(sampleProfileResponse);
    const oldProfile = ProfileSchema.parse(ProfileSchema.parse(base.profile));
    oldProfile.personal.full_name = "Synthetic name A";
    oldProfile.personal.email = "old@example.invalid";
    base.profile = oldProfile;
    const extracted = structuredClone(oldProfile);
    extracted.personal.email = "imported@example.invalid";
    const legacy = { id: "legacy-draft", revision: 0, tenantId: "local", filename: "synthetic-legacy.pdf", importProfile: true, importStyle: false,
      base, result: { profile: extracted }, attempt: null };
    const current = structuredClone(base);
    const currentProfile = ProfileSchema.parse(current.profile);
    currentProfile.personal.full_name = "Synthetic name B";
    current.profile = currentProfile;
    current.profileVersion = base.profileVersion! + 1;
    const alreadyRebased = { ...legacy, revision: 1, projectionVersion: 1,
      base: { profileVersion: current.profileVersion, profile: { personal: { full_name: "Synthetic name B", email: "old@example.invalid" } } },
      __jobctrl_preserved_legacy_review_v1: legacy };
    const key = "jh:profile-import-review-v1";
    InMemoryStoragePort.transactionValues.set(key, JSON.stringify({ version: 1, drafts: [alreadyRebased] }));
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({ ...current, profile: request.profile, profileVersion: current.profileVersion! + 1 }));
    const raw = InMemoryStoragePort.transactionValues.get(key);
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { profile: vi.fn(async () => current), updateProfile } }) });
    await screen.findByText(/fields whose extraction source cannot be verified/i);
    expect(screen.queryByRole("checkbox", { name: "Personal details" })).not.toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Show recovery JSON" }));
    expect(JSON.parse((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value)).toEqual(alreadyRebased);
  });

  it("retains unverifiable legacy personal fields across reload without overwriting newer values", async () => {
    const base = structuredClone(sampleProfileResponse);
    const oldProfile = ProfileSchema.parse(base.profile);
    oldProfile.personal.full_name = "Synthetic name A";
    oldProfile.personal.email = "old@example.invalid";
    base.profile = { ...oldProfile, legacy_only: "synthetic-only-in-old-base" };
    const extracted = structuredClone(oldProfile);
    extracted.personal.email = "imported@example.invalid";
    const legacy = { id: "legacy-draft", revision: 0, tenantId: "local", filename: "synthetic-legacy.pdf", importProfile: true, importStyle: false,
      base, result: { profile: extracted }, attempt: null };
    const key = "jh:profile-import-review-v1";
    InMemoryStoragePort.transactionValues.set(key, JSON.stringify({ version: 1, drafts: [legacy] }));
    const current = structuredClone(sampleProfileResponse);
    const currentProfile = ProfileSchema.parse(ProfileSchema.parse(current.profile));
    currentProfile.personal.full_name = "Synthetic name B";
    currentProfile.personal.email = "old@example.invalid";
    current.profile = currentProfile;
    current.profileVersion = base.profileVersion! + 1;
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({ ...current, profile: request.profile, profileVersion: current.profileVersion! + 1 }));
    const raw = InMemoryStoragePort.transactionValues.get(key);
    const view = renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { profile: vi.fn(async () => current), updateProfile } }) });
    await screen.findByText(/fields whose extraction source cannot be verified/i);
    expect(screen.queryByRole("checkbox", { name: "Personal details" })).not.toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Show recovery JSON" }));
    expect(JSON.parse((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value)).toEqual(legacy);
    view.unmount();
    useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
    renderWithProviders(<ProfileImportReview />);
    fireEvent.click(await screen.findByRole("button", { name: "Show recovery JSON" }));
    expect((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value).toContain("synthetic-only-in-old-base");
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("retains legacy data through rejection and leaves bytes untouched on a failed removal", async () => {
    const base = structuredClone(sampleProfileResponse);
    const oldProfile = ProfileSchema.parse(base.profile);
    const unique = "synthetic-only-in-old-base\r\nUnicode: e\u0301 \u00e9 \u{1f680}\u0000";
    base.profile = { ...oldProfile, legacy_only: unique };
    const legacy = { id: "legacy-draft", revision: 0, tenantId: "local", filename: "synthetic-legacy.pdf", importProfile: true, importStyle: false,
      base, result: { profile: { personal: { full_name: "Synthetic reviewed" } } }, attempt: null,
      __jobctrl_resolved_legacy_review_v1: { version: 1, record: { id: "legacy-draft", tenantId: "local", unique: "synthetic-collision" } } };
    const key = "jh:profile-import-review-v1";
    const raw = JSON.stringify({ version: 1, drafts: [legacy] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    renderWithProviders(<ProfileImportReview />);
    await screen.findByText(/fields whose extraction source cannot be verified/i);
    InMemoryStoragePort.failWrite = () => true;
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    await screen.findByText(/could not be removed/i);
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    InMemoryStoragePort.failWrite = null;
    const reject = screen.getByRole("button", { name: "Reject draft" });
    fireEvent.click(reject);
    fireEvent.click(reject);
    fireEvent.click(await screen.findByRole("button", { name: "Show recovery JSON" }));
    const recoveryJson = (screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value;
    expect(JSON.parse(recoveryJson)).toEqual(legacy);
    expect(useProfileImportReviewStore.getState().storageError).toBe(false);
    expect([...new TextEncoder().encode(JSON.parse(recoveryJson).base.profile.legacy_only)]).toEqual([...new TextEncoder().encode(unique)]);
  });

  it("keeps a confirmed legacy save recoverable when recording recovery fails", async () => {
    const base = structuredClone(sampleProfileResponse);
    const canonicalProfile = ProfileSchema.parse(ProfileSchema.parse(base.profile));
    base.profile = { ...canonicalProfile, legacy_only: "synthetic-only-in-old-base" };
    const legacy = { id: "00000000-0000-4000-8000-000000000001", revision: 0, tenantId: "local", filename: "synthetic-legacy.pdf", importProfile: true, importStyle: false,
      base, result: { profile: { personal: { full_name: "Synthetic reviewed" } }, source: { attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), extractedPersonal: { full_name: "Synthetic reviewed" } } }, attempt: null };
    const key = "jh:profile-import-review-v1";
    InMemoryStoragePort.transactionValues.set(key, JSON.stringify({ version: 1, drafts: [legacy] }));
    const canonical = { ...base, profile: canonicalProfile };
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({ ...canonical, profile: request.profile, profileVersion: base.profileVersion! + 1 }));
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { profile: vi.fn(async () => canonical), updateProfile } }) });
    await screen.findByText("Full name: Synthetic reviewed");
    InMemoryStoragePort.failWrite = (value) => value.includes("__jobctrl_resolved_legacy_review_v1");
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/selected sections were saved, but the review draft/i);
    expect(updateProfile).toHaveBeenCalledOnce();
    expect(JSON.stringify(updateProfile.mock.calls[0]![0])).not.toContain("synthetic-only-in-old-base");
    expect(InMemoryStoragePort.transactionValues.get(key)).toContain("synthetic-only-in-old-base");
    InMemoryStoragePort.failWrite = null;
    fireEvent.click(screen.getByRole("button", { name: "Remove saved draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show recovery JSON" }));
    expect((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value).toContain("synthetic-only-in-old-base");
    expect(updateProfile).toHaveBeenCalledOnce();
  });

  it.each(["changed", "unavailable"])("preserves a legacy draft when the canonical profile is %s", async (state) => {
    const base = structuredClone(sampleProfileResponse);
    const oldProfile = ProfileSchema.parse(base.profile);
    oldProfile.personal.password = "synthetic-legacy-password";
    base.profile = oldProfile;
    const extracted = structuredClone(oldProfile);
    extracted.personal.full_name = "Synthetic legacy review";
    const legacy = {
      id: "legacy-draft", revision: 4, tenantId: "local", filename: "synthetic-legacy.pdf",
      importProfile: true, importStyle: false, base,
      result: { profile: extracted, source: { text_preview: "Synthetic unique legacy preview" } },
      attempt: { profileVersion: base.profileVersion, sections: ["personal"], count: 1 },
    };
    const raw = JSON.stringify({ version: 1, drafts: [legacy] });
    const key = "jh:profile-import-review-v1";
    InMemoryStoragePort.transactionValues.set(key, raw);
    const current = structuredClone(base);
    const currentProfile = ProfileSchema.parse(current.profile);
    currentProfile.personal.password = "synthetic-new-password";
    current.profile = currentProfile;
    current.profileVersion = (base.profileVersion ?? 0) + 1;
    const profile = vi.fn(async () => {
      if (state === "unavailable") throw new Error("Synthetic unavailable profile");
      return current;
    });
    const updateProfile = vi.fn();
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { profile, updateProfile } }) });
    await screen.findByText(/previous save was attempted and may have completed/i);
    expect(screen.queryByRole("button", { name: "Retry original save" })).not.toBeInTheDocument();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    expect(profile).not.toHaveBeenCalled();
    expect(updateProfile).not.toHaveBeenCalled();
    expect(useProfileImportReviewStore.getState().drafts[0]).toEqual(legacy);
    fireEvent.click(screen.getByRole("button", { name: "Show recovery JSON" }));
    expect(JSON.parse((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value)).toEqual(legacy);
  });

  it("provides accessible review and selection controls", async () => {
    await stage();
    const view = renderWithProviders(<ProfileImportReview />);
    expect(await axe(view.container)).toHaveNoViolations();
  });
  it("accepts only receipt-bound personal fields after the A to B to C Profile race", async () => {
    const base = structuredClone(sampleProfileResponse);
    const a = ProfileSchema.parse(ProfileSchema.parse(base.profile));
    a.personal.full_name = "Synthetic name A";
    a.personal.email = "";
    base.profile = a;
    await useProfileImportReviewStore.getState().stage({
      tenantId: "local", filename: "synthetic-email.pdf", importProfile: true, importStyle: false, base,
      result: { profile: { personal: { email: "synthetic-race@example.invalid" } },
        source: { attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), extractedPersonal: { email: "synthetic-race@example.invalid" } } },
    }, storage);
    const current = structuredClone(base);
    const c = ProfileSchema.parse(ProfileSchema.parse(current.profile));
    c.personal.full_name = "Synthetic name C";
    current.profile = c;
    current.profileVersion = base.profileVersion! + 2;
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({ ...current, profile: request.profile,
      profileVersion: current.profileVersion! + 1 }));
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { profile: vi.fn(async () => current), updateProfile } }) });
    expect(await screen.findByText("Email: synthetic-race@example.invalid")).toBeVisible();
    expect(screen.queryByText(/Synthetic name B/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/saved profile changed/i);
    expect(updateProfile).not.toHaveBeenCalled();
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Load latest saved profile" }));
    await screen.findByText(/latest saved profile loaded/i);
    expect(screen.getByRole("checkbox", { name: "Personal details" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    const request = updateProfile.mock.calls[0]![0];
    expect(request.expectedProfileVersion).toBe(current.profileVersion);
    expect(ProfileSchema.parse(request.profile).personal).toMatchObject({
      full_name: "Synthetic name C", email: "synthetic-race@example.invalid",
    });
    expect(JSON.stringify(request)).not.toContain("Synthetic name B");
  });

  it("submits only recorded PDF style fields after a newer color change", async () => {
    const base = structuredClone(sampleProfileResponse);
    base.profile = ProfileSchema.parse(ProfileSchema.parse(base.profile));
    const baseStyle = { ...(base.style as Record<string, unknown>), moderncv_color: "red" };
    base.style = baseStyle;
    await useProfileImportReviewStore.getState().stage({ tenantId: "local", filename: "synthetic-style.pdf",
      importProfile: false, importStyle: true, base,
      result: { style: { paper_size: "letterpaper" }, source: {
        attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), styleReceiptId: "00000000-0000-4000-8000-000000000001", inferredStyle: { paper_size: "letterpaper" },
      } },
    }, storage);
    const current = { ...structuredClone(base), profileVersion: base.profileVersion! + 2,
      style: { ...baseStyle, moderncv_color: "green" } };
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({ ...current, style: { ...current.style, ...request.style as object },
      profileVersion: current.profileVersion + 1 }));
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { profile: vi.fn(async () => current), updateProfile } }) });
    expect(await screen.findByRole("checkbox", { name: "Resume style" })).toBeVisible();
    expect(screen.queryByText(/moderncv color/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Resume style" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/saved profile changed/i);
    expect(updateProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load latest saved profile" }));
    await screen.findByText(/latest saved profile loaded/i);
    expect(screen.getByRole("checkbox", { name: "Resume style" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Resume style" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    expect(updateProfile.mock.calls[0]![0]).toMatchObject({ expectedProfileVersion: current.profileVersion,
      style: { paper_size: "letterpaper" }, importStyleReceiptId: "00000000-0000-4000-8000-000000000001" });
    expect(updateProfile.mock.calls[0]![0].style).not.toHaveProperty("moderncv_color");
  });

  it("keeps inherited legacy style without PDF evidence in recovery", async () => {
    const base = structuredClone(sampleProfileResponse);
    const legacy = { id: "unverified-style", revision: 0, projectionVersion: 2, tenantId: "local",
      filename: "synthetic-legacy-style.pdf", importProfile: false, importStyle: true, attempt: null,
      base: { profileVersion: base.profileVersion, profile: { personal: {} } },
      result: { style: { font_family: "roman", moderncv_color: "blue" } },
    };
    const key = "jh:profile-import-review-v1";
    const raw = JSON.stringify({ version: 2, drafts: [legacy] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    const updateProfile = vi.fn();
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { updateProfile } }) });
    expect(await screen.findByText(/fields whose extraction source cannot be verified/i)).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Resume style" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show recovery JSON" }));
    expect(JSON.parse((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value)).toEqual(legacy);
    expect(updateProfile).not.toHaveBeenCalled();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
  });

  it("keeps older personal drafts without a source receipt in recovery and never saves them", async () => {
    const base = structuredClone(sampleProfileResponse);
    const legacy = { id: "unverified-personal", revision: 0, projectionVersion: 2, tenantId: "local",
      filename: "synthetic-legacy.pdf", importProfile: true, importStyle: false, attempt: null,
      base: { profileVersion: base.profileVersion, profile: { personal: { full_name: "Synthetic name A" } } },
      result: { profile: { personal: { full_name: "Synthetic inherited B", email: "synthetic@example.invalid" } } },
    };
    const key = "jh:profile-import-review-v1";
    const raw = JSON.stringify({ version: 2, drafts: [legacy] });
    InMemoryStoragePort.transactionValues.set(key, raw);
    const updateProfile = vi.fn();
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { updateProfile } }) });
    expect(await screen.findByText(/fields whose extraction source cannot be verified/i)).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Personal details" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show recovery JSON" }));
    expect(JSON.parse((screen.getByRole("textbox", { name: "Preserved legacy review JSON" }) as HTMLTextAreaElement).value)).toEqual(legacy);
    expect(updateProfile).not.toHaveBeenCalled();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
  });

  it("shows extracted fields without saving, and saves only the selected section", async () => {
    const base = await stage();
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({
      ...base,
      profile: request.profile ?? base.profile,
      profileVersion: (base.profileVersion ?? 0) + 1,
    }));
    renderWithProviders(<ProfileImportReview />, {
      ports: buildTestPorts({ api: { updateProfile, profile: vi.fn(async () => base) } }),
    });
    expect(screen.getByText(/Synthetic extracted name/)).toBeVisible();
    expect(screen.getByText(/Synthetic role/)).toBeVisible();
    expect(updateProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Experience" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Accept selected sections" }),
    );
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    expect(updateProfile.mock.calls[0]![0]).toMatchObject({
      expectedProfileVersion: base.profileVersion,
    });
    expect(updateProfile.mock.calls[0]![0].style).toBeUndefined();
    await waitFor(() =>
      expect(useProfileImportReviewStore.getState().drafts).toHaveLength(0),
    );
  });

  it("retains a failed/stale draft, reloads the saved version, and requires a new selection", async () => {
    const base = await stage();
    const newer = {
      ...structuredClone(base),
      profileVersion: (base.profileVersion ?? 0) + 1,
    };
    const updateProfile = vi
      .fn()
      .mockRejectedValueOnce(new JobCtrlApiError(409, "Conflict", undefined, { error: "stale_profile_version" }))
      .mockResolvedValueOnce({
        ...newer,
        profileVersion: newer.profileVersion + 1,
      });
    const profile = vi.fn().mockResolvedValueOnce(base).mockResolvedValue(newer);
    renderWithProviders(<ProfileImportReview />, {
      ports: buildTestPorts({ api: { updateProfile, profile } }),
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Resume style" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Accept selected sections" }),
    );
    await screen.findByText(/saved profile changed/i);
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Load latest saved profile" }),
    );
    await screen.findByText(/latest saved profile loaded/i);
    expect(
      screen.getByRole("checkbox", { name: "Resume style" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Accept selected sections" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Resume style" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Accept selected sections" }),
    );
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    expect(updateProfile.mock.calls[1]![0]).toMatchObject({
      expectedProfileVersion: newer.profileVersion,
      style: { font_family: "roman" },
    });
  });

  it("rejects a draft without writing profile data", async () => {
    await stage();
    const updateProfile = vi.fn();
    renderWithProviders(<ProfileImportReview />, {
      ports: buildTestPorts({ api: { updateProfile } }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    expect(updateProfile).not.toHaveBeenCalled();
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(0));
  });

  it("identifies a requested scope with no reviewable fields", async () => {
    const base = structuredClone(sampleProfileResponse);
    await useProfileImportReviewStore.getState().stage({
      tenantId: "local", filename: "synthetic-partial.pdf", importProfile: true,
      importStyle: true, base,
      result: { profile: { personal: { full_name: "Synthetic extracted name" } }, style: {},
        source: { attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), extractedPersonal: { full_name: "Synthetic extracted name" }, warnings: ["Synthetic page could not be read"] } },
    }, storage);
    renderWithProviders(<ProfileImportReview />);
    expect(screen.getByText(/no resume style is available/i)).toBeVisible();
    expect(screen.getByText("Synthetic page could not be read")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Personal details" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Resume style" })).not.toBeInTheDocument();
  });

  it("retains the draft when a save response is unconfirmed", async () => {
    const base = await stage();
    const updateProfile = vi.fn().mockRejectedValueOnce(new Error("synthetic connection lost"));
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { updateProfile, profile: vi.fn(async () => base) } }) });
    fireEvent.click(screen.getByRole("checkbox", { name: "Resume style" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/save could not be confirmed/i);
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
    expect(screen.getByText(/Synthetic extracted name/)).toBeVisible();
  });

  it("does not repeat a confirmed save when removing its stored draft fails", async () => {
    const base = await stage();
    const updateProfile = vi.fn().mockResolvedValue({ ...base, profileVersion: (base.profileVersion ?? 0) + 1 });
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { updateProfile, profile: vi.fn(async () => base) } }) });
    InMemoryStoragePort.failWrite = (value) => JSON.parse(value).drafts.length === 0;
    fireEvent.click(screen.getByRole("checkbox", { name: "Resume style" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/selected sections were saved, but the review draft changed or could not be removed/i);
    expect(screen.getByRole("button", { name: "Retry original save" })).toBeDisabled();
    expect(updateProfile).toHaveBeenCalledOnce();
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
    InMemoryStoragePort.failWrite = null;
    fireEvent.click(screen.getByRole("button", { name: "Remove saved draft" }));
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(0));
    expect(updateProfile).toHaveBeenCalledOnce();
  });

  it("retries the original selection after an ambiguous save only while its version is unchanged", async () => {
    const base = await stage();
    const updateProfile = vi.fn().mockRejectedValueOnce(new Error("synthetic lost response"))
      .mockResolvedValueOnce({ ...base, profileVersion: base.profileVersion! + 1 });
    const ports = buildTestPorts({ api: { updateProfile, profile: vi.fn(async () => base) } });
    const view = renderWithProviders(<ProfileImportReview />, { ports });
    fireEvent.click(screen.getByRole("checkbox", { name: "Experience" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/save could not be confirmed/i);
    view.unmount();
    useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
    renderWithProviders(<ProfileImportReview />, { ports });
    await screen.findByText(/previous save was attempted/i);
    expect(screen.getByRole("checkbox", { name: "Experience" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Load latest saved profile" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry original save" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    expect(updateProfile.mock.calls[1]![0]).toEqual(updateProfile.mock.calls[0]![0]);
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(0));
  });

  it("refuses to rebase or retry a possibly committed save after a newer edit", async () => {
    const base = await stage();
    let current = base;
    const updateProfile = vi.fn(async () => {
      current = { ...structuredClone(base), profileVersion: base.profileVersion! + 1 };
      throw new Error("synthetic response lost after commit");
    });
    const ports = buildTestPorts({ api: { updateProfile, profile: vi.fn(async () => current) } });
    const view = renderWithProviders(<ProfileImportReview />, { ports });
    fireEvent.click(screen.getByRole("checkbox", { name: "Experience" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/save could not be confirmed/i);
    view.unmount();
    useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
    renderWithProviders(<ProfileImportReview />, { ports });
    await screen.findByText(/previous save was attempted/i);
    expect(screen.getByRole("button", { name: "Load latest saved profile" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry original save" }));
    await screen.findByText(/cannot be retried or rebased safely/i);
    expect(updateProfile).toHaveBeenCalledOnce();
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
  });

  it.each(["projection", "version"])("offers truthful recovery for a damaged %s after an unconfirmed save", async (damage) => {
    const base = await stage();
    const key = "jh:profile-import-review-v1";
    const initial = JSON.parse(InMemoryStoragePort.transactionValues.get(key)!);
    initial.drafts[0].result.profile.personal.email = "imported@example.invalid";
    initial.drafts[0].result.source.extractedPersonal.email = "imported@example.invalid";
    InMemoryStoragePort.transactionValues.set(key, JSON.stringify(initial));
    useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
    await useProfileImportReviewStore.getState().hydrate(storage);
    const updateProfile = vi.fn().mockRejectedValueOnce(new Error("synthetic lost response"));
    const ports = buildTestPorts({ api: { updateProfile, profile: vi.fn(async () => base) } });
    const view = renderWithProviders(<ProfileImportReview />, { ports });
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/save could not be confirmed/i);
    view.unmount();
    const damaged = JSON.parse(InMemoryStoragePort.transactionValues.get(key)!);
    if (damage === "projection") damaged.drafts[0].base.profile.personal.email = "imported@example.invalid";
    else damaged.drafts[0].base.profileVersion += 1;
    const raw = JSON.stringify(damaged);
    InMemoryStoragePort.transactionValues.set(key, raw);
    useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
    renderWithProviders(<ProfileImportReview />, { ports });
    await screen.findByText(/previous save was attempted/i);
    fireEvent.click(screen.getByRole("button", { name: "Retry original save" }));
    const message = await screen.findByText(/original save cannot be retried safely/i);
    expect(message).toHaveTextContent(/previous save may have completed/i);
    expect(message).toHaveTextContent(/inspect the saved profile and account for that attempt/i);
    expect(message).not.toHaveTextContent(/load the latest profile/i);
    expect(screen.getByRole("button", { name: "Load latest saved profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove review draft" })).toBeEnabled();
    expect(updateProfile).toHaveBeenCalledOnce();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
  });

  it("refuses an incomplete canonical read before sending any profile write", async () => {
    const base = await stage();
    const incomplete = structuredClone(base);
    delete (incomplete.profile as { resume: { experience_entries: Array<{ achievement_evidence?: unknown }> } }).resume.experience_entries[0]!.achievement_evidence;
    const updateProfile = vi.fn();
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { updateProfile, profile: vi.fn(async () => incomplete) } }) });
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/saved profile is incomplete/i);
    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Personal details" })).toBeChecked();
    expect(useProfileImportReviewStore.getState().drafts[0]?.attempt).toBeNull();
  });

  it("merges reviewed fields onto the fresh canonical profile when the stored base is damaged", async () => {
    const base = await stage();
    const canonical = ProfileSchema.parse(base.profile);
    canonical.resume.experience_entries[0]!.achievement_evidence.push({
      id: "synthetic-confirmed", source_text: "Synthetic accepted evidence", scope: "", action: "",
      tools: [], metrics: [], outcome: "", evidence_strength: "verified", claim_confidence: 1,
      user_confirmed: true, tags: [],
    });
    base.profile = canonical;
    const key = "jh:profile-import-review-v1";
    const stored = JSON.parse(InMemoryStoragePort.transactionValues.get(key)!);
    expect(stored.drafts[0].base.profile).not.toHaveProperty("resume");
    stored.drafts[0].base.profile.resume = { experience_entries: [{ id: "synthetic-damaged-entry" }] };
    InMemoryStoragePort.transactionValues.set(key, JSON.stringify(stored));
    useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({ ...base, profile: request.profile, profileVersion: base.profileVersion! + 1 }));
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { updateProfile, profile: vi.fn(async () => base) } }) });
    await screen.findByText(/Synthetic extracted name/);
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    const sent = ProfileSchema.parse(updateProfile.mock.calls[0]![0].profile);
    expect(sent.resume.experience_entries[0]!.achievement_evidence).toEqual(canonical.resume.experience_entries[0]!.achievement_evidence);
  });

  it("requires a fresh review before saving a field hidden by a damaged base", async () => {
    const base = await stage();
    const key = "jh:profile-import-review-v1";
    const stored = JSON.parse(InMemoryStoragePort.transactionValues.get(key)!);
    stored.drafts[0].result.profile.personal.email = "imported@example.invalid";
    stored.drafts[0].result.source.extractedPersonal.email = "imported@example.invalid";
    stored.drafts[0].base.profile.personal.email = "imported@example.invalid";
    const raw = JSON.stringify(stored);
    InMemoryStoragePort.transactionValues.set(key, raw);
    useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
    const updateProfile = vi.fn(async (request: ProfileUpdateRequest) => ({ ...base, profile: request.profile, profileVersion: base.profileVersion! + 1 }));
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { updateProfile, profile: vi.fn(async () => base) } }) });
    await screen.findByText("Full name: Synthetic extracted name");
    expect(screen.queryByText("Email: imported@example.invalid")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/review fields changed against the saved profile/i);
    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Personal details" })).toBeChecked();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Load latest saved profile" }));
    await screen.findByText(/latest saved profile loaded/i);
    expect(screen.getByText("Email: imported@example.invalid")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Personal details" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    expect(ProfileSchema.parse(updateProfile.mock.calls[0]![0].profile).personal.email).toBe("imported@example.invalid");
  });

  it("does not rebase onto an incomplete canonical read", async () => {
    const base = await stage();
    const incomplete = structuredClone(base);
    delete (incomplete.profile as { resume: { experience_entries: Array<{ achievement_evidence?: unknown }> } }).resume.experience_entries[0]!.achievement_evidence;
    const key = "jh:profile-import-review-v1";
    const raw = InMemoryStoragePort.transactionValues.get(key);
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { profile: vi.fn(async () => incomplete) } }) });
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Load latest saved profile" }));
    await screen.findByText(/saved profile is incomplete/i);
    expect(screen.getByRole("checkbox", { name: "Personal details" })).toBeChecked();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(raw);
  });

  it("keeps the older selection visible when another tab changes or rejects its draft", async () => {
    await stage();
    const updateProfile = vi.fn();
    renderWithProviders(<ProfileImportReview />, { ports: buildTestPorts({ api: { updateProfile } }) });
    await waitFor(() => expect(useProfileImportReviewStore.getState().pendingIds).toHaveLength(0));
    const key = "jh:profile-import-review-v1";
    const newer = JSON.parse(InMemoryStoragePort.transactionValues.get(key)!);
    newer.drafts[0].revision += 1;
    newer.drafts[0].base.profileVersion += 1;
    const newerRaw = JSON.stringify(newer);
    InMemoryStoragePort.transactionValues.set(key, newerRaw);
    fireEvent.click(screen.getByRole("checkbox", { name: "Experience" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/not available at the reviewed version/i);
    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Experience" })).toBeChecked();
    expect(screen.getByText(/Synthetic role/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    await screen.findByText(/review draft changed or could not be removed/i);
    expect(screen.getByRole("checkbox", { name: "Experience" })).toBeChecked();
    expect(InMemoryStoragePort.transactionValues.get(key)).toBe(newerRaw);
    InMemoryStoragePort.transactionValues.set(key, JSON.stringify({ version: 1, drafts: [] }));
    await act(async () => { await useProfileImportReviewStore.getState().hydrate(storage); });
    expect(screen.getByText(/Synthetic role/)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Experience" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/not available at the reviewed version/i);
    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Experience" })).toBeChecked();
  });

  it("does not expose or discard another tenant's draft", async () => {
    const base = await stage();
    await useProfileImportReviewStore.getState().stage({
      tenantId: "other",
      filename: "other.pdf",
      importProfile: true,
      importStyle: false,
      base,
      result: {
        profile: { personal: { full_name: "Synthetic other tenant" } },
      },
    }, storage);
    renderWithProviders(<ProfileImportReview />);
    expect(
      screen.queryByText(/Synthetic other tenant/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toMatchObject([
      { tenantId: "other" },
    ]));
  });

  it("keeps a newer review draft when an earlier save completes", async () => {
    const base = await stage();
    let resolve!: (response: typeof base) => void;
    const updateProfile = vi.fn(
      () =>
        new Promise<typeof base>((done) => {
          resolve = done;
        }),
    );
    renderWithProviders(<ProfileImportReview />, {
      ports: buildTestPorts({ api: { updateProfile, profile: vi.fn(async () => base) } }),
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Resume style" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Accept selected sections" }),
    );
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    await act(async () => {
      await useProfileImportReviewStore.getState().stage({
        tenantId: "local",
        filename: "newer.pdf",
        importProfile: true,
        importStyle: false,
        base,
        result: {
          profile: { personal: { full_name: "Synthetic newer draft" } },
          source: { attemptId: "00000000-0000-4000-8000-000000000002", determinationId: "a".repeat(64), extractedPersonal: { full_name: "Synthetic newer draft" } },
        },
      }, storage);
    });
    await act(async () =>
      resolve({ ...base, profileVersion: (base.profileVersion ?? 0) + 1 }),
    );
    await waitFor(() =>
      expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1),
    );
    expect(useProfileImportReviewStore.getState().drafts[0]?.filename).toBe(
      "newer.pdf",
    );
    expect(screen.getByText(/Synthetic newer draft/)).toBeVisible();
  });
});
