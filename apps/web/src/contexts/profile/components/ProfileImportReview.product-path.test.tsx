import fs from "node:fs";
import path from "node:path";
import { JobCtrlApiClient } from "@jobctrl/api-client";
import { ProfileSchema } from "@jobctrl/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { server as mockServer } from "../../../test/msw/server.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts, InMemoryStoragePort } from "../../../test/testPorts.js";
import { ImportConfirmForm } from "../forms/import-confirm-form.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";
import { useProfileImportReviewStore } from "../stores/profile-import-review-store.js";
import { ProfileImportReview } from "./ProfileImportReview.js";

const productPathTest = process.env.JOBCTRL_PRODUCT_PATH_PROOF === "1" ? it : it.skip;
productPathTest("runs actual import to visible review and preserves profile through conflict, acceptance, failure and rejection", async () => {
  const appDir = process.env.JOBCTRL_DIR!;
  const pdf = fs.readFileSync(path.join(appDir, "..", "synthetic.pdf"));
  const apiBase = process.env.TASK_API_URL!;
  const requests: Array<{ method: string; url: string; status: number; json: Record<string, unknown> }> = [];
  // MSW normally forbids all unhandled network. For this one test, allow only
  // the explicitly owned loopback API and continue rejecting all other URLs.
  mockServer.close();
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const target = new URL(String(input), apiBase);
    if (target.origin !== apiBase) throw new Error("Network outside the owned API is prohibited");
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("origin", "http://127.0.0.1:5173");
    headers.set("sec-fetch-site", "same-site");
    const response = await nativeFetch(target, { ...init, headers });
    const json = await response.clone().json() as Record<string, unknown>;
    requests.push({ method, url: target.pathname, status: response.status, json });
    return response;
  });
  const client = new JobCtrlApiClient(apiBase, 120_000);
  let race = false;
  let beforeImport: (() => Promise<void>) | null = null;
  let concurrentVersion: number | null = null;
  const ports = buildTestPorts({ api: {
    profile: () => client.profile(),
    importResume: async (body) => {
      if (beforeImport) { const callback = beforeImport; beforeImport = null; await callback(); }
      return client.importResume(body);
    },
    updateProfile: async (body) => {
      if (race) {
        race = false;
        const latest = await client.profile();
        const changed = ProfileSchema.parse(structuredClone(latest.profile));
        changed.personal.full_name = "Synthetic newer edit";
        const newer = await client.updateProfile({ profile: changed, expectedProfileVersion: latest.profileVersion });
        concurrentVersion = newer.profileVersion;
      }
      return client.updateProfile(body);
    },
  } });
  const storage = ports.storage;
  InMemoryStoragePort.transactionValues.clear();
  useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
  useProfileImportStore.setState({ pendingImports: [], completedImports: [] });
  try {
    const initial = await client.updateProfile({ expectedProfileVersion: null, profile: {
      personal: { full_name: "Synthetic original" },
      resume: { experience_entries: [{ id: "synthetic-existing-role", title: "Synthetic existing role", company: "Synthetic existing employer",
        bullets: ["Synthetic previously accepted result"], achievement_evidence: [{ id: "synthetic-existing-evidence",
          source_text: "Synthetic previously accepted result", user_confirmed: true, evidence_strength: "verified", claim_confidence: 1 }] }] },
    } });
    const before = await client.profile();
    expect(before.profileVersion).toBe(initial.profileVersion);
    const existingEvidence = ProfileSchema.parse(before.profile).resume.experience_entries[0]!.achievement_evidence;
    expect(existingEvidence[0]!.user_confirmed).toBe(true);

    async function extract(filename: string, bytes: Buffer, importProfile = true, importStyle = false) {
      await useProfileImportStore.getState().retryStorage(storage);
      expect(await useProfileImportStore.getState().setUpload(filename, bytes.toString("base64"), storage)).toBe(true);
      expect(await useProfileImportStore.getState().setOptions(importProfile, importStyle, storage)).toBe(true);
      const view = renderWithProviders(<ImportConfirmForm />, { withRouter: true, ports });
      fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
      return view;
    }

    let view = await extract("synthetic-first.pdf", pdf);
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1), { timeout: 90_000 });
    await waitFor(() => expect(useProfileImportStore.getState().filename).toBe(""), { timeout: 10_000 });
    view.unmount();
    const importCall = requests.find((row) => row.url === "/v1/profile/import-resume" && row.status === 200)!;
    expect(importCall).toBeDefined();
    expect(importCall.json).toMatchObject({
      source: { status: "pending_confirmation", pages: 1, determinationId: expect.stringMatching(/^[0-9a-f]{64}$/) },
      profile: { resume: { experience_entries: [expect.objectContaining({
        title: "Synthetic imported role", bullets: ["Synthetic imported accomplishment"], achievement_evidence: [],
      })] } },
    });
    expect(await client.profile()).toEqual(before);

    view = renderWithProviders(<ProfileImportReview />, { ports });
    expect(await screen.findByText(/Synthetic imported role/)).toBeVisible();
    expect(screen.getByText(/Synthetic imported accomplishment/)).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Experience" }));
    race = true;
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/saved profile changed/i, {}, { timeout: 10_000 });
    expect(requests.some((row) => row.method === "PATCH" && row.url === "/v1/profile" && row.status === 409 && row.json.error === "stale_profile_version")).toBe(true);
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
    const concurrent = await client.profile();
    expect(concurrent.profileVersion).toBe(concurrentVersion);
    expect(ProfileSchema.parse(concurrent.profile).personal.full_name).toBe("Synthetic newer edit");
    expect(ProfileSchema.parse(concurrent.profile).resume.experience_entries).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Load latest saved profile" }));
    await screen.findByText(/latest saved profile loaded/i);
    expect(screen.getByRole("checkbox", { name: "Experience" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Accept selected sections" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Experience" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(0), { timeout: 10_000 });
    const accepted = await client.profile();
    expect(accepted.profileVersion).toBe((concurrentVersion ?? 0) + 1);
    expect(ProfileSchema.parse(accepted.profile).personal.full_name).toBe("Synthetic newer edit");
    expect(ProfileSchema.parse(accepted.profile).resume.experience_entries[0]!.achievement_evidence).toEqual(existingEvidence);
    expect(ProfileSchema.parse(accepted.profile).resume.experience_entries[1]).toMatchObject({
      title: "Synthetic imported role", bullets: ["Synthetic imported accomplishment"], achievement_evidence: [],
    });
    view.unmount();

    view = await extract("synthetic-reject.pdf", pdf);
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1), { timeout: 90_000 });
    await waitFor(() => expect(useProfileImportStore.getState().filename).toBe(""), { timeout: 10_000 });
    view.unmount();
    expect(await client.profile()).toEqual(accepted);
    view = await extract("synthetic-failure.pdf", Buffer.from("%PDF-1.4 invalid synthetic PDF"));
    await screen.findByText(/import could not be completed/i, {}, { timeout: 90_000 });
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
    expect(useProfileImportStore.getState().filename).toBe("synthetic-failure.pdf");
    expect(await client.profile()).toEqual(accepted);
    view.unmount();

    view = renderWithProviders(<ProfileImportReview />, { ports });
    expect(await screen.findByText("synthetic-reject.pdf")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(0));
    expect(await client.profile()).toEqual(accepted);
    expect(requests.filter((row) => row.url === "/v1/profile/import-resume" && row.status === 200)).toHaveLength(2);
    expect(requests.some((row) => row.url === "/v1/profile/import-resume" && row.status >= 500)).toBe(true);
    view.unmount();

    // The UI captures A. The worker must then read B, while the PDF extracts
    // only an email. After a separate save to C, rebase and accept the email.
    let latest = await client.profile();
    const nameA = ProfileSchema.parse(structuredClone(latest.profile));
    nameA.personal.full_name = "Synthetic name A";
    nameA.personal.email = "";
    await client.updateProfile({ profile: nameA, expectedProfileVersion: latest.profileVersion });
    const baseA = await client.profile();
    beforeImport = async () => {
      const b = ProfileSchema.parse(structuredClone(baseA.profile));
      b.personal.full_name = "Synthetic name B";
      const savedB = await client.updateProfile({ profile: b, expectedProfileVersion: baseA.profileVersion });
      expect(ProfileSchema.parse(savedB.profile).personal.full_name).toBe("Synthetic name B");
    };
    const emailPdf = fs.readFileSync(path.join(appDir, "..", "synthetic-email-only.pdf"));
    view = await extract("synthetic-email-only.pdf", emailPdf);
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1), { timeout: 90_000 });
    await waitFor(() => expect(useProfileImportStore.getState().filename).toBe(""), { timeout: 10_000 });
    view.unmount();
    const emailImport = requests.filter((row) => row.url === "/v1/profile/import-resume" && row.status === 200).at(-1)!;
    const emailResult = emailImport.json as { profile: { personal: unknown }; source: { extractedPersonal: unknown } };
    expect(emailResult.profile.personal).toEqual({ email: "synthetic-race@example.invalid" });
    expect(emailResult.source.extractedPersonal).toEqual({ email: "synthetic-race@example.invalid" });
    latest = await client.profile();
    expect(ProfileSchema.parse(latest.profile).personal.full_name).toBe("Synthetic name B");
    const nameC = ProfileSchema.parse(structuredClone(latest.profile));
    nameC.personal.full_name = "Synthetic name C";
    const savedC = await client.updateProfile({ profile: nameC, expectedProfileVersion: latest.profileVersion });
    view = renderWithProviders(<ProfileImportReview />, { ports });
    expect(await screen.findByText("Email: synthetic-race@example.invalid")).toBeVisible();
    expect(screen.queryByText(/Full name: Synthetic name B/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/saved profile changed/i);
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
    expect(await client.profile()).toEqual(savedC);
    fireEvent.click(screen.getByRole("button", { name: "Load latest saved profile" }));
    await screen.findByText(/latest saved profile loaded/i);
    expect(screen.queryByText(/Full name: Synthetic name B/)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Personal details" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal details" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(0), { timeout: 10_000 });
    const final = await client.profile();
    expect(ProfileSchema.parse(final.profile).personal.full_name).toBe("Synthetic name C");
    expect(ProfileSchema.parse(final.profile).personal.email).toBe("synthetic-race@example.invalid");
    expect(ProfileSchema.parse(final.profile).resume.experience_entries[0]!.achievement_evidence).toEqual(existingEvidence);
    view.unmount();

    // Style metadata comes only from the PDF: the worker sees B's color,
    // then a later save changes it to C before the user reviews the result.
    latest = await client.profile();
    await client.updateProfile({ style: { moderncv_color: "red" }, expectedProfileVersion: latest.profileVersion });
    const styleA = await client.profile();
    beforeImport = async () => {
      const savedB = await client.updateProfile({ style: { moderncv_color: "blue" }, expectedProfileVersion: styleA.profileVersion });
      expect((savedB.style as Record<string, unknown>).moderncv_color).toBe("blue");
    };
    view = await extract("synthetic-style.pdf", pdf, false, true);
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1), { timeout: 90_000 });
    await waitFor(() => expect(useProfileImportStore.getState().filename).toBe(""), { timeout: 10_000 });
    view.unmount();
    const styleImport = requests.filter((row) => row.url === "/v1/profile/import-resume" && row.status === 200).at(-1)!;
    const styleResult = styleImport.json as { style: unknown; source: { inferredStyle: unknown } };
    expect(styleResult.style).toEqual({ paper_size: "letterpaper", document_font_size: "11pt", font_family: "sans" });
    expect(styleResult.source.inferredStyle).toEqual(styleResult.style);
    expect(styleResult.style).not.toHaveProperty("moderncv_color");
    latest = await client.profile();
    expect((latest.style as Record<string, unknown>).moderncv_color).toBe("blue");
    const styleC = await client.updateProfile({ style: { moderncv_color: "green" }, expectedProfileVersion: latest.profileVersion });
    view = renderWithProviders(<ProfileImportReview />, { ports });
    expect(await screen.findByRole("checkbox", { name: "Resume style" })).toBeVisible();
    expect(screen.queryByText(/moderncv color/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Resume style" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await screen.findByText(/saved profile changed/i);
    expect(await client.profile()).toEqual(styleC);
    fireEvent.click(screen.getByRole("button", { name: "Load latest saved profile" }));
    await screen.findByText(/latest saved profile loaded/i);
    expect(screen.getByRole("checkbox", { name: "Resume style" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Resume style" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected sections" }));
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(0), { timeout: 10_000 });
    const styled = await client.profile();
    expect((styled.style as Record<string, unknown>).moderncv_color).toBe("green");
    expect((styled.style as Record<string, unknown>).paper_size).toBe("letterpaper");
    view.unmount();
  } finally {
    vi.unstubAllGlobals();
    mockServer.listen({ onUnhandledRequest: "error" });
  }
}, 120_000);
