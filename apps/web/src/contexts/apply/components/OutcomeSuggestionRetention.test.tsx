import { JobCtrlApiError } from "@jobctrl/api-client";
import type { OutcomeSuggestionDecisionResponse } from "@jobctrl/contracts";
import { createTenantId } from "@jobctrl/domain-types";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { PortsProvider, type Ports } from "../../../shared/providers/PortsProvider.js";
import { TenantProvider } from "../../../shared/providers/TenantProvider.js";
import { sampleApplicationOutcomes } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts, FakeSessionPort } from "../../../test/testPorts.js";
import { OutcomeDraftRetentionProvider, OutcomeSuggestionsPanel } from "./ApplicationOutcomes.js";

const suggestion = sampleApplicationOutcomes.suggestions[0]!;
const savedSuggestion = {
  ...suggestion, status: "ignored" as const, decidedAt: "2026-10-01T12:00:00.000Z",
  decisionReason: "Earlier synthetic review", decidedOutcomeId: null,
};

function mount(ports: Ports, jobKey: string, show: boolean, pending = true) {
  return (
    <OutcomeDraftRetentionProvider>
      <PortsProvider ports={ports}>
        <TenantProvider>
          {show ? <OutcomeSuggestionsPanel jobId={jobKey} suggestions={pending ? [{ ...suggestion, jobKey }] : []} /> : <p>Another route</p>}
        </TenantProvider>
      </PortsProvider>
    </OutcomeDraftRetentionProvider>
  );
}

it("isolates a late conflict and retained correction between tenants with colliding IDs", async () => {
  const user = userEvent.setup();
  const otherTenant = createTenantId("synthetic-suggestion-tenant-b");
  let reject!: (error: Error) => void;
  const decision = vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; }));
  const portsA = buildTestPorts({ api: { decideOutcomeSuggestion: decision } });
  const portsB: Ports = { ...portsA, session: new FakeSessionPort({ tenantId: otherTenant, userId: null }) };
  const view = renderWithProviders(mount(portsA, suggestion.jobKey, true));

  await user.type(screen.getByLabelText("Local note"), "Tenant A synthetic correction");
  await user.click(screen.getByRole("button", { name: /^correct suggestion/i }));
  await waitFor(() => expect(decision).toHaveBeenCalledTimes(1));
  view.rerender(mount(portsB, suggestion.jobKey, true));
  expect(screen.getByLabelText("Local note")).toHaveValue("");
  await user.type(screen.getByLabelText("Local note"), "Tenant B synthetic correction");

  await act(async () => { reject(new JobCtrlApiError(409, "Conflict", undefined, {
    ok: false, error: "outcome_suggestion_conflict", suggestion: savedSuggestion, outcome: null,
  })); });
  expect(screen.getByLabelText("Local note")).toHaveValue("Tenant B synthetic correction");
  expect(screen.queryByText(/Earlier synthetic review/)).not.toBeInTheDocument();
  view.rerender(mount(portsA, suggestion.jobKey, true, false));
  expect(screen.getByLabelText("Local note")).toHaveValue("Tenant A synthetic correction");
  expect(await screen.findByRole("alert")).toHaveTextContent("Requested decision: correct");
  expect(screen.getByRole("alert")).toHaveTextContent("Saved decision: ignored");
  expect(screen.getByRole("alert")).toHaveTextContent("Earlier synthetic review");
  view.rerender(mount(portsB, suggestion.jobKey, true));
  expect(screen.getByLabelText("Local note")).toHaveValue("Tenant B synthetic correction");
});

it("keeps a pending correction through route and job changes until its late acknowledgement", async () => {
  const user = userEvent.setup();
  const otherJob = "synthetic-other-job";
  let finish!: (value: OutcomeSuggestionDecisionResponse) => void;
  const pending = new Promise<OutcomeSuggestionDecisionResponse>((resolve) => { finish = resolve; });
  const decision = vi.fn(() => pending);
  const ports = buildTestPorts({ api: { decideOutcomeSuggestion: decision } });
  const view = renderWithProviders(mount(ports, suggestion.jobKey, true));
  await user.type(screen.getByLabelText("Local note"), "Original synthetic correction");
  await user.click(screen.getByRole("button", { name: /^correct suggestion/i }));
  await waitFor(() => expect(decision).toHaveBeenCalledTimes(1));

  view.rerender(mount(ports, otherJob, true));
  expect(screen.getByLabelText("Local note")).toHaveValue("");
  await user.type(screen.getByLabelText("Local note"), "Other job synthetic correction");
  view.rerender(mount(ports, suggestion.jobKey, false));
  view.rerender(mount(ports, suggestion.jobKey, true, false));
  expect(screen.getByLabelText("Local note")).toHaveValue("Original synthetic correction");
  expect(screen.getByLabelText("Local note")).toBeDisabled();

  const saved: OutcomeSuggestionDecisionResponse = { ok: true, disposition: "applied",
    suggestion: { ...suggestion, status: "corrected", decisionReason: null,
      decidedAt: "2026-10-01T12:00:00.000Z", decidedOutcomeId: "synthetic-outcome" },
    outcome: { ...sampleApplicationOutcomes.outcomes[0]!, outcomeId: "synthetic-outcome",
      jobKey: suggestion.jobKey, suggestionId: suggestion.suggestionId, source: "email_suggestion",
      note: "Original synthetic correction" },
  };
  await act(async () => { finish(saved); await pending; });
  expect(await screen.findByText(/recorded while you were away/i)).toBeInTheDocument();
  expect(screen.getByLabelText("Local note")).toHaveValue("Original synthetic correction");
  expect(screen.getByRole("button", { name: /^correct suggestion/i })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Dismiss" }));
  view.rerender(mount(ports, otherJob, true));
  expect(screen.getByLabelText("Local note")).toHaveValue("Other job synthetic correction");
  expect(decision).toHaveBeenCalledTimes(1);
});
