import type { JobApplicationOutcomeListResponse, ManualApplicationOutcomeRequest } from "@jobctrl/contracts";
import { LOCAL_TENANT, createTenantId, type TenantId } from "@jobctrl/domain-types";
import type { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { jobsKeys } from "../../contexts/operations/jobsKeys.js";
import { outcomesKeys } from "../../contexts/operations/outcomesKeys.js";
import { routeTree } from "../../routeTree.gen.js";
import { PortsProvider, type Ports } from "../../shared/providers/PortsProvider.js";
import { TenantProvider, useTenantId } from "../../shared/providers/TenantProvider.js";
import { makeJobDetail, sampleApplicationOutcomes, sampleInterviewPrep, sampleJob } from "../../test/fixtures/projections.js";
import { buildProviderHarness, createTestQueryClient } from "../../test/render.js";
import { buildTestPorts, FakeSessionPort } from "../../test/testPorts.js";

vi.mock("../../shared/ui/PdfPreviewViewer.js", () => ({ PdfPreviewViewer: () => null }));

const JOB_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const JOB_B = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const TenantMarker = () => <span data-testid="active-tenant">{useTenantId()}</span>;
const materialLocaleVariants = vi.fn(async () => ({ supportedLocales: [], variants: [], profileVersion: null, sources: [] }));

function preload(queryClient: QueryClient, tenant: TenantId, jobId: string, withPrep = false) {
  queryClient.setQueryData(jobsKeys.detail(tenant, jobId), makeJobDetail({ ...sampleJob, jobKey: jobId },
    withPrep ? { interviewPrep: { ...sampleInterviewPrep, jobId } } : {}));
  queryClient.setQueryData(outcomesKeys.detail(tenant, jobId), {
    ...sampleApplicationOutcomes, jobKey: jobId, outcomes: [], suggestions: [],
  } satisfies JobApplicationOutcomeListResponse);
}

function fixture(ports: Ports, queryClient: QueryClient) {
  const harness = buildProviderHarness({ queryClient, ports, withEventStream: true });
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [`/jobs/${JOB_A}`] }),
    context: { ports, queryClient, tenantId: LOCAL_TENANT } });
  const mount = (current: Ports) => <PortsProvider ports={current}><TenantProvider>
    <TenantMarker /><RouterProvider router={router} />
  </TenantProvider></PortsProvider>;
  const view = render(mount(ports), { wrapper: harness.Wrapper });
  return { router, mount, view };
}

async function findDraftNote(family: "manual" | "reflection" = "manual") {
  // Label resolution across every mounted form dominates these real-route
  // cases. Keep the real label association, scoped to its owning section.
  return waitFor(() => {
    const section = document.getElementById(family === "manual" ? "job-detail-outcomes" : "job-detail-interview");
    expect(section).not.toBeNull();
    return within(section!).getByLabelText(family === "manual" ? "Local note" : "Reflection note", {
      selector: family === "manual" ? "#manual-outcome-note" : "#interview-reflection-note",
    });
  });
}

async function findDraftButton(name: string, family: "manual" | "reflection" = "manual") {
  const form = (await findDraftNote(family)).closest("form");
  expect(form).not.toBeNull();
  return within(form!).findByRole("button", { name });
}

async function expandOutcomes(user: ReturnType<typeof userEvent.setup>) {
  const workspace = await screen.findByRole("article", { name: "Job details" });
  const header = workspace.querySelector("header");
  expect(header).not.toBeNull();
  await user.click(within(header!).getByRole("button", { name: "Sections" }));
  const menu = await screen.findByRole("navigation", { name: "Job detail sections" });
  expect(menu.parentElement).not.toBeNull();
  await user.click(within(menu.parentElement!).getByRole("button", { name: "Expand all" }));
  return findDraftNote();
}

it.each([false, true])("retains a %s pending manual draft through real A-B-A job routes", async pending => {
  const user = userEvent.setup();
  const queryClient = createTestQueryClient();
  preload(queryClient, LOCAL_TENANT, JOB_A);
  preload(queryClient, LOCAL_TENANT, JOB_B);
  const record = vi.fn(async (jobKey: string, body: ManualApplicationOutcomeRequest) => {
    if (record.mock.calls.length === 1) throw new Error("Synthetic lost acknowledgement");
    return { ok: true as const, outcome: { ...sampleApplicationOutcomes.outcomes[0]!, jobKey, outcomeId: body.requestId } };
  });
  const ports = buildTestPorts({ api: { recordManualApplicationOutcome: record, materialLocaleVariants } });
  const { router } = fixture(ports, queryClient);
  const first = await expandOutcomes(user);
  await user.type(first, "Synthetic job A draft");
  let request: ManualApplicationOutcomeRequest | undefined;
  if (pending) {
    await user.click(await findDraftButton("Record outcome"));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    request = record.mock.calls[0]![1];
    expect(await findDraftButton("Start a new action")).toBeEnabled();
  }
  await act(async () => { await router.navigate({ to: "/jobs/$jobId", params: { jobId: JOB_B } }); });
  const second = await expandOutcomes(user);
  expect(second).toHaveValue("");
  await user.type(second, "Synthetic job B draft");
  await act(async () => { await router.navigate({ to: "/jobs/$jobId", params: { jobId: JOB_A } }); });
  const returned = await expandOutcomes(user);
  expect(returned).toHaveValue("Synthetic job A draft");
  if (pending) {
    expect(returned).toBeDisabled();
    await user.click(await findDraftButton("Record outcome"));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(record.mock.calls[1]![1]).toEqual(request);
  }
  await act(async () => { await router.navigate({ to: "/jobs/$jobId", params: { jobId: JOB_B } }); });
  expect(await expandOutcomes(user)).toHaveValue("Synthetic job B draft");
});

it.each([
  ["manual", false], ["manual", true], ["reflection", false], ["reflection", true],
] as const)("retains a %s draft with pending=%s across cold tenant detail loading", async (family, pending) => {
  const user = userEvent.setup();
  const tenantB = createTenantId("synthetic-cold-tenant-b");
  const queryClient = createTestQueryClient();
  const withPrep = family === "reflection";
  const detail = (jobId: string) => makeJobDetail({ ...sampleJob, jobKey: jobId },
    withPrep ? { interviewPrep: { ...sampleInterviewPrep, jobId } } : {});
  const findNote = () => withPrep
    ? findDraftNote("reflection")
    : findDraftNote();
  const submitName = withPrep ? "Record reflection" : "Record outcome";
  preload(queryClient, LOCAL_TENANT, JOB_A, withPrep);
  let finishJob!: (value: ReturnType<typeof makeJobDetail>) => void;
  const pendingJob = new Promise<ReturnType<typeof makeJobDetail>>(resolve => { finishJob = resolve; });
  const record = vi.fn(async (jobKey: string, body: ManualApplicationOutcomeRequest) => {
    if (record.mock.calls.length === 1) throw new Error("Synthetic lost acknowledgement");
    return { ok: true as const, outcome: { ...sampleApplicationOutcomes.outcomes[0]!, jobKey, outcomeId: body.requestId } };
  });
  const portsA = buildTestPorts({ api: { job: vi.fn(async (jobId: string) => detail(jobId)), recordManualApplicationOutcome: record, materialLocaleVariants } });
  const apiB = Object.assign(Object.create(Object.getPrototypeOf(portsA.api)), portsA.api, { job: vi.fn(() => pendingJob) }) as Ports["api"];
  const portsB: Ports = { ...portsA, session: new FakeSessionPort({ tenantId: tenantB, userId: null }), api: apiB };
  const { mount, view } = fixture(portsA, queryClient);
  await expandOutcomes(user);
  const first = await findNote();
  await user.type(first, "Synthetic tenant A draft");
  let request: ManualApplicationOutcomeRequest | undefined;
  if (pending) {
    await user.click(await findDraftButton(submitName, family));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    request = record.mock.calls[0]![1];
    if (withPrep) expect(request.interviewPrepGeneration).toBe(1);
    expect(await findDraftButton("Start a new action", family)).toBeEnabled();
  }
  view.rerender(mount(portsB));
  expect(screen.getByTestId("active-tenant")).toHaveTextContent(tenantB);
  expect(await screen.findByText("Loading job.")).toBeInTheDocument();
  expect(screen.queryByDisplayValue("Synthetic tenant A draft")).not.toBeInTheDocument();
  await act(async () => { finishJob(detail(JOB_A)); await pendingJob; });
  const noteB = await findNote();
  expect(noteB).toHaveValue("");
  expect(noteB).toBeEnabled();
  await user.type(noteB, "Synthetic tenant B draft");
  view.rerender(mount(portsA));
  expect(screen.getByTestId("active-tenant")).toHaveTextContent(LOCAL_TENANT);
  const returned = await findNote();
  expect(returned).toHaveValue("Synthetic tenant A draft");
  if (pending) {
    expect(returned).toBeDisabled();
    await user.click(await findDraftButton(submitName, family));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(record.mock.calls[1]![1]).toEqual(request);
  }
  view.rerender(mount(portsB));
  expect(await findNote()).toHaveValue("Synthetic tenant B draft");
});

it("retains a manual draft while the nested run route replaces the drawer", async () => {
  const user = userEvent.setup();
  const queryClient = createTestQueryClient();
  preload(queryClient, LOCAL_TENANT, JOB_A);
  const ports = buildTestPorts({ api: { materialLocaleVariants } });
  const { router } = fixture(ports, queryClient);
  await user.type(await expandOutcomes(user), "Synthetic draft before run detail");
  await act(async () => { await router.navigate({ to: "/jobs/$jobId/run/$runId", params: { jobId: JOB_A, runId: "synthetic-run" } }); });
  expect(await screen.findByRole("article", { name: "Apply run details" })).toBeInTheDocument();
  expect(screen.queryByDisplayValue("Synthetic draft before run detail")).not.toBeInTheDocument();
  await act(async () => { await router.navigate({ to: "/jobs/$jobId", params: { jobId: JOB_A } }); });
  expect(await expandOutcomes(user)).toHaveValue("Synthetic draft before run detail");
});

it.each([
  ["manual", false], ["manual", true], ["reflection", false], ["reflection", true],
] as const)("retains a %s draft with pending=%s after visiting another section", async (family, pending) => {
  const user = userEvent.setup();
  const queryClient = createTestQueryClient();
  const withPrep = family === "reflection";
  const findNote = () => withPrep
    ? findDraftNote("reflection")
    : findDraftNote();
  const submitName = withPrep ? "Record reflection" : "Record outcome";
  preload(queryClient, LOCAL_TENANT, JOB_A, withPrep);
  const record = vi.fn(async (jobKey: string, body: ManualApplicationOutcomeRequest) => {
    if (record.mock.calls.length === 1) throw new Error("Synthetic lost acknowledgement");
    return { ok: true as const, outcome: { ...sampleApplicationOutcomes.outcomes[0]!, jobKey, outcomeId: body.requestId } };
  });
  const job = vi.fn(async (jobId: string) => makeJobDetail({ ...sampleJob, jobKey: jobId },
    withPrep ? { interviewPrep: { ...sampleInterviewPrep, jobId } } : {}));
  const ports = buildTestPorts({ api: { job, recordManualApplicationOutcome: record, materialLocaleVariants } });
  const { router } = fixture(ports, queryClient);
  await expandOutcomes(user);
  await user.type(await findNote(), "Synthetic draft before dashboard");
  let request: ManualApplicationOutcomeRequest | undefined;
  if (pending) {
    await user.click(await findDraftButton(submitName, family));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    request = record.mock.calls[0]![1];
    expect(await findDraftButton("Start a new action", family)).toBeEnabled();
  }
  await act(async () => { await router.navigate({ to: "/dashboard" }); });
  expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
  expect(screen.queryByDisplayValue("Synthetic draft before dashboard")).not.toBeInTheDocument();
  await act(async () => { await router.navigate({ to: "/jobs/$jobId", params: { jobId: JOB_A } }); });
  await expandOutcomes(user);
  const returned = await findNote();
  expect(returned).toHaveValue("Synthetic draft before dashboard");
  if (pending) {
    expect(returned).toBeDisabled();
    await user.click(await findDraftButton(submitName, family));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(record.mock.calls[1]![1]).toEqual(request);
  }
});

it.each([false, true])("retains a %s pending reflection through keyed job routes", async pending => {
  const user = userEvent.setup();
  const queryClient = createTestQueryClient();
  preload(queryClient, LOCAL_TENANT, JOB_A, true);
  preload(queryClient, LOCAL_TENANT, JOB_B, true);
  const record = vi.fn(async (jobKey: string, body: ManualApplicationOutcomeRequest) => {
    if (record.mock.calls.length === 1) throw new Error("Synthetic lost acknowledgement");
    return { ok: true as const, outcome: { ...sampleApplicationOutcomes.outcomes[0]!, jobKey, outcomeId: body.requestId } };
  });
  // The mutation invalidates the job detail even after an uncertain response.
  // Keep the refetched synthetic detail consistent with the preloaded prep.
  const job = vi.fn(async (jobId: string) => makeJobDetail({ ...sampleJob, jobKey: jobId }, {
    interviewPrep: { ...sampleInterviewPrep, jobId },
  }));
  const ports = buildTestPorts({ api: { job, recordManualApplicationOutcome: record, materialLocaleVariants } });
  const { router } = fixture(ports, queryClient);
  await expandOutcomes(user);
  await user.type(await findDraftNote("reflection"), "Synthetic job A reflection");
  let request: ManualApplicationOutcomeRequest | undefined;
  if (pending) {
    await user.click(await findDraftButton("Record reflection", "reflection"));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    request = record.mock.calls[0]![1];
    expect(request.interviewPrepGeneration).toBe(1);
    await waitFor(() => expect(job).toHaveBeenCalledWith(JOB_A));
  }
  await act(async () => { await router.navigate({ to: "/jobs/$jobId", params: { jobId: JOB_B } }); });
  await expandOutcomes(user);
  expect(await findDraftNote("reflection")).toHaveValue("");
  await user.type(await findDraftNote("reflection"), "Synthetic job B reflection");
  await act(async () => { await router.navigate({ to: "/jobs/$jobId", params: { jobId: JOB_A } }); });
  await expandOutcomes(user);
  const returned = await findDraftNote("reflection");
  expect(returned).toHaveValue("Synthetic job A reflection");
  if (pending) {
    expect(returned).toBeDisabled();
    await user.click(await findDraftButton("Record reflection", "reflection"));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(record.mock.calls[1]![1]).toEqual(request);
  }
});

it("does not let a late acknowledgement clear a newer action after route replacement", async () => {
  const user = userEvent.setup();
  const queryClient = createTestQueryClient();
  preload(queryClient, LOCAL_TENANT, JOB_A);
  preload(queryClient, LOCAL_TENANT, JOB_B);
  let finish!: (value: { ok: true; outcome: typeof sampleApplicationOutcomes.outcomes[number] }) => void;
  const pending = new Promise<{ ok: true; outcome: typeof sampleApplicationOutcomes.outcomes[number] }>(resolve => { finish = resolve; });
  const record = vi.fn(async (jobKey: string, body: ManualApplicationOutcomeRequest) => ({
    ok: true as const, outcome: { ...sampleApplicationOutcomes.outcomes[0]!, jobKey, outcomeId: body.requestId },
  })).mockReturnValueOnce(pending);
  const ports = buildTestPorts({ api: { recordManualApplicationOutcome: record, materialLocaleVariants } });
  const { router } = fixture(ports, queryClient);
  await user.type(await expandOutcomes(user), "Synthetic original action");
  await user.click(await findDraftButton("Record outcome"));
  await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
  const original = record.mock.calls[0]![1];
  await act(async () => { await router.navigate({ to: "/jobs/$jobId", params: { jobId: JOB_B } }); });
  await user.type(await expandOutcomes(user), "Synthetic other job draft");
  await act(async () => { await router.navigate({ to: "/jobs/$jobId", params: { jobId: JOB_A } }); });
  const returned = await expandOutcomes(user);
  expect(returned).toHaveValue("Synthetic original action");
  expect(returned).toBeDisabled();
  await user.click(await findDraftButton("Start a new action"));
  await user.type(returned, " with a deliberate change");
  await act(async () => { finish({ ok: true, outcome: sampleApplicationOutcomes.outcomes[0]! }); await pending; });
  expect(returned).toHaveValue("Synthetic original action with a deliberate change");
  expect(returned).toBeEnabled();
  await user.click(await findDraftButton("Record outcome"));
  await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
  expect(record.mock.calls[1]![1].requestId).not.toBe(original.requestId);
  await act(async () => { await router.navigate({ to: "/jobs/$jobId", params: { jobId: JOB_B } }); });
  expect(await expandOutcomes(user)).toHaveValue("Synthetic other job draft");
});
