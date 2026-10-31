import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ManualApplicationOutcomeRequest } from "@jobctrl/contracts";
import { LOCAL_TENANT, createTenantId } from "@jobctrl/domain-types";
import { expect, it, vi } from "vitest";

import { sampleApplicationOutcomes } from "../../../test/fixtures/projections.js";
import { createTestQueryClient, renderWithProviders } from "../../../test/render.js";
import { buildTestPorts, FakeSessionPort } from "../../../test/testPorts.js";
import { PortsProvider, type Ports } from "../../../shared/providers/PortsProvider.js";
import { TenantProvider, useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outcomesKeys } from "../../operations/outcomesKeys.js";
import { InterviewReflectionForm, JobOutcomePanel, ManualOutcomeForm } from "./ApplicationOutcomes.js";

const JOB_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const jobOutcomes = { ...sampleApplicationOutcomes, jobKey: JOB_ID,
  outcomes: sampleApplicationOutcomes.outcomes.map(outcome => ({ ...outcome, jobKey: JOB_ID })),
  suggestions: sampleApplicationOutcomes.suggestions.map(suggestion => ({ ...suggestion, jobKey: JOB_ID })) };
const TenantMarker = () => <span data-testid="active-tenant">{useTenantId()}</span>;

it("keeps manual outcome drafts private and retained across colliding tenant job IDs", async () => {
  const user = userEvent.setup();
  const tenantB = createTenantId("synthetic-manual-tenant-b");
  const jobId = JOB_ID;
  expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
  const portsA = buildTestPorts({ api: { jobApplicationOutcomes: vi.fn(async () => jobOutcomes) } });
  const portsB: Ports = { ...portsA, session: new FakeSessionPort({ tenantId: tenantB, userId: null }) };
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(outcomesKeys.detail(LOCAL_TENANT, jobId), jobOutcomes);
  queryClient.setQueryData(outcomesKeys.detail(tenantB, jobId), jobOutcomes);
  const mount = (ports: Ports) => <PortsProvider ports={ports}><TenantProvider><TenantMarker /><JobOutcomePanel jobId={jobId} /></TenantProvider></PortsProvider>;
  const view = renderWithProviders(mount(portsA), { queryClient });
  expect(screen.getByTestId("active-tenant")).toHaveTextContent(LOCAL_TENANT);
  const noteA = await screen.findByLabelText("Local note", { selector: "#manual-outcome-note" });
  await user.type(noteA, "Tenant A synthetic manual draft");
  expect(noteA).toHaveValue("Tenant A synthetic manual draft");
  view.rerender(mount(portsB));
  expect(screen.getByTestId("active-tenant")).toHaveTextContent(tenantB);
  expect(screen.getByLabelText("Local note", { selector: "#manual-outcome-note" })).toHaveValue("");
  await user.type(screen.getByLabelText("Local note", { selector: "#manual-outcome-note" }), "Tenant B synthetic manual draft");
  view.rerender(mount(portsA));
  expect(screen.getByLabelText("Local note", { selector: "#manual-outcome-note" })).toHaveValue("Tenant A synthetic manual draft");
  view.rerender(mount(portsB));
  expect(screen.getByLabelText("Local note", { selector: "#manual-outcome-note" })).toHaveValue("Tenant B synthetic manual draft");
});

it("retains separate manual drafts when switching jobs with warm cached outcomes", async () => {
  const user = userEvent.setup();
  const firstJob = JOB_ID;
  const secondJob = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
  const ports = buildTestPorts({ api: { jobApplicationOutcomes: vi.fn(async (jobKey: string) => ({ ...sampleApplicationOutcomes, jobKey })) } });
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(outcomesKeys.detail(LOCAL_TENANT, firstJob), jobOutcomes);
  queryClient.setQueryData(outcomesKeys.detail(LOCAL_TENANT, secondJob), { ...sampleApplicationOutcomes, jobKey: secondJob });
  const view = renderWithProviders(<JobOutcomePanel jobId={firstJob} />, { ports, queryClient });
  await user.type(await screen.findByLabelText("Local note", { selector: "#manual-outcome-note" }), "First job draft");
  view.rerender(<JobOutcomePanel jobId={secondJob} />);
  expect(screen.getByLabelText("Local note", { selector: "#manual-outcome-note" })).toHaveValue("");
  await user.type(screen.getByLabelText("Local note", { selector: "#manual-outcome-note" }), "Second job draft");
  view.rerender(<JobOutcomePanel jobId={firstJob} />);
  expect(screen.getByLabelText("Local note", { selector: "#manual-outcome-note" })).toHaveValue("First job draft");
});

it("retains a manual draft while another job's first outcome read is pending", async () => {
  const user = userEvent.setup();
  const otherJob = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
  let finish!: (value: typeof jobOutcomes) => void;
  const pending = new Promise<typeof jobOutcomes>(resolve => { finish = resolve; });
  const ports = buildTestPorts({ api: { jobApplicationOutcomes: vi.fn((jobKey: string) =>
    jobKey === otherJob ? pending : Promise.resolve(jobOutcomes)) } });
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(outcomesKeys.detail(LOCAL_TENANT, JOB_ID), jobOutcomes);
  const view = renderWithProviders(<JobOutcomePanel jobId={JOB_ID} />, { ports, queryClient });
  await user.type(await screen.findByLabelText("Local note", { selector: "#manual-outcome-note" }), "Retained during loading");
  view.rerender(<JobOutcomePanel jobId={otherJob} />);
  expect(screen.queryByLabelText("Local note", { selector: "#manual-outcome-note" })).not.toBeInTheDocument();
  view.rerender(<JobOutcomePanel jobId={JOB_ID} />);
  expect(await screen.findByLabelText("Local note", { selector: "#manual-outcome-note" })).toHaveValue("Retained during loading");
  await act(async () => { finish({ ...jobOutcomes, jobKey: otherJob }); await pending; });
});

it.each(["manual", "reflection"] as const)("retains the %s request and private fields independently for each tenant", async family => {
  const user = userEvent.setup();
  const tenantB = createTenantId("synthetic-retry-tenant-b");
  const jobId = JOB_ID;
  const success = async (jobKey: string, body: ManualApplicationOutcomeRequest) => ({
    ok: true as const, outcome: { ...sampleApplicationOutcomes.outcomes[0]!,
      outcomeId: body.requestId, jobKey, kind: body.kind, note: body.note ?? null },
  });
  const retryA = vi.fn(success).mockRejectedValueOnce(new Error("Synthetic uncertain acknowledgement"));
  const retryB = vi.fn(success).mockRejectedValueOnce(new Error("Synthetic uncertain acknowledgement"));
  const portsA = buildTestPorts({ api: { recordManualApplicationOutcome: retryA } });
  const portsB: Ports = { ...portsA, session: new FakeSessionPort({ tenantId: tenantB, userId: null }),
    api: { ...portsA.api, recordManualApplicationOutcome: retryB } };
  const mount = (ports: Ports) => <PortsProvider ports={ports}><TenantProvider>
    {family === "manual" ? <ManualOutcomeForm jobId={jobId} /> : <InterviewReflectionForm jobId={jobId} prepGeneration={2} />}
  </TenantProvider></PortsProvider>;
  const view = renderWithProviders(mount(portsA));
  const label = family === "manual" ? "Local note" : "Reflection note";
  const submit = family === "manual" ? "Record outcome" : "Record reflection";
  await user.type(screen.getByLabelText(label), "Tenant A private draft");
  await user.click(screen.getByRole("button", { name: submit }));
  await screen.findByRole("alert");
  const firstA = retryA.mock.calls[0]![1];
  expect(screen.getByLabelText(label)).toBeDisabled();

  view.rerender(mount(portsB));
  expect(screen.getByLabelText(label)).toHaveValue("");
  expect(screen.getByLabelText(label)).toBeEnabled();
  await user.type(screen.getByLabelText(label), "Tenant B private draft");
  await user.click(screen.getByRole("button", { name: submit }));
  await screen.findByRole("alert");
  const firstB = retryB.mock.calls[0]![1];
  expect(firstB.requestId).not.toBe(firstA.requestId);

  view.rerender(mount(portsA));
  expect(screen.getByLabelText(label)).toHaveValue("Tenant A private draft");
  expect(screen.getByLabelText(label)).toBeDisabled();
  await user.click(screen.getByRole("button", { name: submit }));
  await waitFor(() => expect(retryA).toHaveBeenCalledTimes(2));
  expect(retryA.mock.calls[1]![1]).toEqual(firstA);
  await waitFor(() => expect(screen.getByLabelText(label)).toHaveValue(""));

  view.rerender(mount(portsB));
  expect(screen.getByLabelText(label)).toHaveValue("Tenant B private draft");
  expect(screen.getByLabelText(label)).toBeDisabled();
  await user.click(screen.getByRole("button", { name: submit }));
  await waitFor(() => expect(retryB).toHaveBeenCalledTimes(2));
  expect(retryB.mock.calls[1]![1]).toEqual(firstB);
  await waitFor(() => expect(screen.getByLabelText(label)).toHaveValue(""));
  view.rerender(mount(portsA));
  expect(screen.getByLabelText(label)).toHaveValue("");
});

it("keeps a reopened pending draft until its original acknowledgement is reconciled", async () => {
  const user = userEvent.setup();
  const tenantB = createTenantId("synthetic-inflight-tenant-b");
  const jobId = JOB_ID;
  let finish!: (value: { ok: true; outcome: typeof sampleApplicationOutcomes.outcomes[number] }) => void;
  const inflight = new Promise<{ ok: true; outcome: typeof sampleApplicationOutcomes.outcomes[number] }>(resolve => { finish = resolve; });
  const record = vi.fn(async (_jobId: string, body: ManualApplicationOutcomeRequest) => ({
    ok: true as const, outcome: { ...sampleApplicationOutcomes.outcomes[0]!, outcomeId: body.requestId },
  })).mockReturnValueOnce(inflight);
  const portsA = buildTestPorts({ api: { recordManualApplicationOutcome: record } });
  const portsB: Ports = { ...portsA, session: new FakeSessionPort({ tenantId: tenantB, userId: null }) };
  const mount = (ports: Ports) => <PortsProvider ports={ports}><TenantProvider><ManualOutcomeForm jobId={jobId} /></TenantProvider></PortsProvider>;
  const view = renderWithProviders(mount(portsA));
  await user.type(screen.getByLabelText("Local note"), "Pending tenant A note");
  await user.click(screen.getByRole("button", { name: "Record outcome" }));
  const first = record.mock.calls[0]![1];
  view.rerender(mount(portsB));
  await user.type(screen.getByLabelText("Local note"), "Unsent tenant B note");
  view.rerender(mount(portsA));
  expect(screen.getByLabelText("Local note")).toHaveValue("Pending tenant A note");
  expect(screen.getByLabelText("Local note")).toBeDisabled();
  await act(async () => { finish({ ok: true, outcome: sampleApplicationOutcomes.outcomes[0]! }); await inflight; });
  expect(screen.getByLabelText("Local note")).toHaveValue("Pending tenant A note");
  await user.click(screen.getByRole("button", { name: "Record outcome" }));
  await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
  expect(record.mock.calls[1]![1]).toEqual(first);
  await waitFor(() => expect(screen.getByLabelText("Local note")).toHaveValue(""));
  view.rerender(mount(portsB));
  expect(screen.getByLabelText("Local note")).toHaveValue("Unsent tenant B note");
});
