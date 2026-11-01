import { QueryClientProvider } from "@tanstack/react-query";
import { JobCtrlApiError } from "@jobctrl/api-client";
import type { ResumeTemplateDefaultSelectionRequest, ResumeTemplateDefaultSelectionResponse, ResumeTemplateVersionSaveRequest, ResumeTemplateVersionSaveResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT, type TenantId } from "@jobctrl/domain-types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { EventStreamProvider } from "../../operations/providers/EventStreamProvider.js";
import { SseEventStreamAdapter } from "../../../shared/adapters/local/SseEventStreamAdapter.js";
import { PortsProvider } from "../../../shared/providers/PortsProvider.js";
import { TenantProvider } from "../../../shared/providers/TenantProvider.js";
import { sampleResumeTemplateListResponse } from "../../../test/fixtures/projections.js";
import { createTestQueryClient } from "../../../test/render.js";
import { buildTestPorts, FakeSessionPort } from "../../../test/testPorts.js";
import { profileKeys } from "../queryKeys.js";
import { ResumeTemplatePanel } from "./ResumeTemplatePanel.js";

vi.mock("../../materials/components/ResumeAuditPins.js", () => ({
  ResumeStandalonePlateEditor: ({ workspaceControls }: { workspaceControls: ReactNode }) => <div>{workspaceControls}</div>,
}));

class ControlledEventSource {
  static instances: ControlledEventSource[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  constructor(_url: string) { ControlledEventSource.instances.push(this); }
  close() {}
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(new Event(type)); }
}

beforeEach(() => { ControlledEventSource.instances = []; vi.stubGlobal("EventSource", ControlledEventSource); });
afterEach(() => vi.unstubAllGlobals());

it("shows the pinned and active versions separately and pins the selected version", async () => {
  const queryClient = createTestQueryClient();
  const template = structuredClone(sampleResumeTemplateListResponse.templates[0]!);
  template.templateId = "synthetic-template";
  template.displayName = "Synthetic template";
  template.builtIn = false;
  template.activeVersion = { ...template.activeVersion, templateId: template.templateId, versionId: "synthetic-v2", versionNumber: 2 };
  const oldDefault = { ...sampleResumeTemplateListResponse.builtInDefault, templateId: template.templateId,
    templateVersionId: "synthetic-v1", templateVersionNumber: 1, templateName: template.displayName, assignmentSource: "profile_default" as const };
  let canonical = { ...structuredClone(sampleResumeTemplateListResponse), templates: [template], defaultTemplate: oldDefault };
  const setDefault = vi.fn(async (request: { templateId: string; versionId?: string }) => {
    canonical = { ...canonical, defaultTemplate: { ...oldDefault, templateVersionId: request.versionId!, templateVersionNumber: 2 } };
    return { ok: true as const, defaultTemplate: canonical.defaultTemplate };
  });
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => structuredClone(canonical), setDefaultResumeTemplate: setDefault,
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);

  await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Synthetic template"));
  const button = screen.getByRole("button", { name: "set default" });
  expect(button).toBeEnabled();
  expect(screen.getByText("Selected saved version: 2")).toBeInTheDocument();
  expect(screen.getByText("Default: Synthetic template, version 1")).toBeInTheDocument();
  expect(screen.queryByText("default template")).not.toBeInTheDocument();
  fireEvent.click(button);
  await waitFor(() => expect(setDefault).toHaveBeenCalledWith({ templateId: "synthetic-template", versionId: "synthetic-v2", expectedActiveVersionId: "synthetic-v2" }));
  await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 2")).toBeInTheDocument());
  expect(screen.getByText("default template")).toBeInTheDocument();
  expect(button).toBeDisabled();
});

it("does not confuse equal version IDs from different template families", async () => {
  const queryClient = createTestQueryClient();
  const template = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!),
    templateId: "synthetic-other-family", displayName: "Other family", builtIn: false };
  template.activeVersion = { ...template.activeVersion, templateId: template.templateId };
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => ({ ...structuredClone(sampleResumeTemplateListResponse), templates: [template] }),
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);

  await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Other family"));
  expect(screen.getByRole("button", { name: "set default" })).toBeEnabled();
  expect(screen.queryByText("default template")).not.toBeInTheDocument();
  expect(screen.getByText("Default: Modern HTML, version 1")).toBeInTheDocument();
});

it("identifies the built-in fallback when no profile default is pinned", async () => {
  const queryClient = createTestQueryClient();
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => ({ ...structuredClone(sampleResumeTemplateListResponse), defaultTemplate: null }),
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);

  await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Modern HTML"));
  expect(screen.getByText("Default: Modern HTML, version 1 (built-in)")).toBeInTheDocument();
  expect(screen.queryByText("default template")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "set default" })).toBeEnabled();
});

it("retains the draft but requires a fresh default read when no cached response remains", async () => {
  const queryClient = createTestQueryClient();
  let failRead = false;
  const tenantA = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => {
      if (failRead) throw new Error("Synthetic read failure");
      return structuredClone(sampleResumeTemplateListResponse);
    },
  } });
  const tenantB = { ...tenantA, session: new FakeSessionPort({ tenantId: "synthetic-tenant-b" as TenantId, userId: null }),
    api: { ...tenantA.api, resumeTemplates: async () => ({ ...structuredClone(sampleResumeTemplateListResponse),
      templates: sampleResumeTemplateListResponse.templates.map((template) => ({ ...structuredClone(template), displayName: "Tenant B template" })) }) } };
  const mount = (ports: typeof tenantA) => <PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>;
  const view = render(mount(tenantA));
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue("Modern HTML"));
  fireEvent.change(name, { target: { value: "Tenant A draft" } });
  view.rerender(mount(tenantB));
  await waitFor(() => expect(name).toHaveValue("Tenant B template"));
  queryClient.removeQueries({ queryKey: profileKeys.resumeTemplates(LOCAL_TENANT), exact: true });
  failRead = true;
  view.rerender(mount(tenantA));
  await screen.findByText("Could not refresh templates. Check the current default before changing it.");
  expect(name).toHaveValue("Tenant A draft");
  expect(screen.getByRole("button", { name: "save default" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "set default" })).toBeDisabled();
  failRead = false;
  fireEvent.click(screen.getByRole("button", { name: "retry templates" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "save default" })).toBeEnabled());
  expect(name).toHaveValue("Tenant A draft");
});

it("requires review after a direct default conflicts with a newer version", async () => {
  const queryClient = createTestQueryClient();
  const first = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!),
    templateId: "synthetic-template", displayName: "Synthetic template", builtIn: false };
  first.activeVersion = { ...first.activeVersion, templateId: first.templateId, versionId: "synthetic-v2", versionNumber: 2 };
  const newer = { ...first, displayName: "Newer synthetic template", activeVersion: {
    ...first.activeVersion, versionId: "synthetic-v3", versionNumber: 3,
  } };
  const oldDefault = { ...sampleResumeTemplateListResponse.builtInDefault, templateId: first.templateId,
    templateVersionId: "synthetic-v1", templateVersionNumber: 1, templateName: first.displayName, assignmentSource: "profile_default" as const };
  let canonical = { ...structuredClone(sampleResumeTemplateListResponse), templates: [first], defaultTemplate: oldDefault };
  const setDefault = vi.fn(async (request: { templateId: string; versionId?: string; expectedActiveVersionId?: string }) => {
    if (setDefault.mock.calls.length === 1) {
      canonical = { ...canonical, templates: [newer] };
      throw new JobCtrlApiError(409, "Conflict", "The template changed.");
    }
    canonical = { ...canonical, defaultTemplate: { ...oldDefault, templateVersionId: request.versionId!, templateVersionNumber: 3 } };
    return { ok: true as const, defaultTemplate: canonical.defaultTemplate };
  });
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => structuredClone(canonical), setDefaultResumeTemplate: setDefault,
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);

  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue("Synthetic template"));
  fireEvent.change(name, { target: { value: "Synthetic draft" } });
  fireEvent.click(screen.getByRole("button", { name: "set default" }));
  await screen.findByRole("group", { name: "Review changed template" });
  await waitFor(() => expect(screen.getByText("Selected saved version: 3")).toBeInTheDocument());
  expect(name).toHaveValue("Synthetic draft");
  expect(setDefault).toHaveBeenCalledTimes(1);
  expect(setDefault).toHaveBeenCalledWith({ templateId: first.templateId, versionId: "synthetic-v2", expectedActiveVersionId: "synthetic-v2" });
  expect(screen.getByRole("button", { name: "set default" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Keep draft and review latest version" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "set default" })).toBeEnabled());
  expect(name).toHaveValue("Synthetic draft");
  fireEvent.click(screen.getByRole("button", { name: "set default" }));
  await waitFor(() => expect(setDefault).toHaveBeenLastCalledWith({ templateId: first.templateId, versionId: "synthetic-v3", expectedActiveVersionId: "synthetic-v3" }));
  await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 3")).toBeInTheDocument());
});

it.each(["set default", "save default"] as const)(
  "reconciles a lost %s response only after a fresh read confirms the requested version",
  async (action) => {
    const queryClient = createTestQueryClient();
    const first = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!),
      templateId: "synthetic-template", displayName: "Synthetic template", builtIn: false };
    first.activeVersion = { ...first.activeVersion, templateId: first.templateId, versionId: "synthetic-v1" };
    const second = { ...first, activeVersion: { ...first.activeVersion, versionId: "synthetic-v2", versionNumber: 2 } };
    const oldDefault = { ...sampleResumeTemplateListResponse.builtInDefault, templateId: first.templateId,
      templateVersionId: "synthetic-v1", templateVersionNumber: 1, templateName: first.displayName, assignmentSource: "profile_default" as const };
    let canonical = { ...structuredClone(sampleResumeTemplateListResponse),
      templates: [action === "set default" ? second : first], defaultTemplate: oldDefault };
    let releaseRead!: () => void;
    let holdRead = false;
    const setDefault = vi.fn(async () => {
      canonical = { ...canonical, defaultTemplate: { ...oldDefault, templateVersionId: "synthetic-v2", templateVersionNumber: 2 } };
      holdRead = true;
      throw new Error("Synthetic response lost after commit");
    });
    const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
      resumeTemplates: async () => {
        if (holdRead) await new Promise<void>((resolve) => { releaseRead = resolve; });
        return structuredClone(canonical);
      },
      saveResumeTemplate: async () => {
        canonical = { ...canonical, templates: [second] };
        return { ok: true as const, template: second };
      },
      setDefaultResumeTemplate: setDefault,
    } });
    render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
      <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
    </QueryClientProvider></TenantProvider></PortsProvider>);

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Synthetic template"));
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(await screen.findByText(/Synthetic response lost after commit/)).toBeInTheDocument();
    expect(screen.getByText("Last read default: Synthetic template, version 1")).toBeInTheDocument();
    await waitFor(() => expect(typeof releaseRead).toBe("function"));
    await act(async () => { holdRead = false; releaseRead(); });
    await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 2")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(/Synthetic response lost after commit/)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "set default" })).toBeDisabled();
    expect(setDefault).toHaveBeenCalledOnce();
  },
);

it.each(["set default", "save default"] as const)(
  "confirms a lost %s response after the tenant query is recreated",
  async (action) => {
    const queryClient = createTestQueryClient();
    const eventStream = new SseEventStreamAdapter();
    const first = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!),
      templateId: "tenant-a-template", displayName: "Tenant A template", builtIn: false };
    first.activeVersion = { ...first.activeVersion, templateId: first.templateId, versionId: "tenant-a-v1", versionNumber: 1 };
    const second = { ...first, displayName: action === "save default" ? "Tenant A accepted" : first.displayName,
      activeVersion: { ...first.activeVersion, versionId: "tenant-a-v2", versionNumber: 2 } };
    const oldDefault = { ...sampleResumeTemplateListResponse.builtInDefault, templateId: first.templateId,
      templateVersionId: "tenant-a-v1", templateVersionNumber: 1, templateName: first.displayName, assignmentSource: "profile_default" as const };
    let canonical = { ...structuredClone(sampleResumeTemplateListResponse),
      templates: [action === "set default" ? second : first], defaultTemplate: oldDefault };
    let failRead = false;
    let returnOldDefaultOnce = false;
    const readA = vi.fn(async () => {
      if (failRead) throw new Error("Synthetic template read failure");
      if (returnOldDefaultOnce) {
        returnOldDefaultOnce = false;
        return { ...structuredClone(canonical), defaultTemplate: oldDefault };
      }
      return structuredClone(canonical);
    });
    const saveA = vi.fn(async (_request: ResumeTemplateVersionSaveRequest) => {
      canonical = { ...canonical, templates: [second] };
      return { ok: true as const, template: second };
    });
    const setDefaultA = vi.fn(async (_request: ResumeTemplateDefaultSelectionRequest) => {
      canonical = { ...canonical, defaultTemplate: { ...oldDefault, templateName: second.displayName,
        templateVersionId: "tenant-a-v2", templateVersionNumber: 2 } };
      failRead = true;
      throw new Error("Synthetic response lost after commit");
    });
    const tenantA = buildTestPorts({ eventStream, api: {
      resumeTemplates: readA, saveResumeTemplate: saveA, setDefaultResumeTemplate: setDefaultA,
    } });
    const tenantB = { ...tenantA, session: new FakeSessionPort({ tenantId: "synthetic-tenant-b" as TenantId, userId: null }),
      api: { ...tenantA.api, resumeTemplates: async () => ({ ...structuredClone(sampleResumeTemplateListResponse),
        templates: [{ ...second, displayName: "Tenant B template" }],
        defaultTemplate: { ...oldDefault, templateVersionId: "tenant-a-v2", templateVersionNumber: 2, templateName: "Tenant B template" },
      }) } };
    const mount = (ports: typeof tenantA) => <PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
      <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
    </QueryClientProvider></TenantProvider></PortsProvider>;
    const view = render(mount(tenantA));
    const name = await screen.findByLabelText("Name");
    await waitFor(() => expect(name).toHaveValue("Tenant A template"));
    const queryKey = profileKeys.resumeTemplates(LOCAL_TENANT);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey, exact: true });
      await queryClient.refetchQueries({ queryKey, exact: true });
    });
    expect(queryClient.getQueryState(queryKey)!.dataUpdateCount).toBeGreaterThanOrEqual(3);
    fireEvent.change(name, { target: { value: action === "save default" ? "Tenant A accepted" : "Tenant A initial draft" } });
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(await screen.findByText(/Synthetic response lost after commit/)).toBeInTheDocument();
    await screen.findByText("Could not refresh templates. Check the current default before changing it.");
    expect(setDefaultA).toHaveBeenCalledWith({ templateId: "tenant-a-template", versionId: "tenant-a-v2", expectedActiveVersionId: "tenant-a-v2" });
    if (action === "save default") {
      expect(saveA).toHaveBeenCalledWith(expect.objectContaining({ templateId: "tenant-a-template", expectedVersionId: "tenant-a-v1", displayName: "Tenant A accepted" }));
      expect(screen.getByText("Selected saved version: 2")).toBeInTheDocument();
    }
    await waitFor(() => expect(name).toBeEnabled());
    fireEvent.change(name, { target: { value: "Tenant A newer draft" } });

    // A matching default in another tenant must not confirm A's lost response.
    view.rerender(mount(tenantB));
    await waitFor(() => expect(name).toHaveValue("Tenant B template"));
    expect(screen.queryByText(/Synthetic response lost after commit/)).not.toBeInTheDocument();
    fireEvent.change(name, { target: { value: "Tenant B draft" } });
    view.rerender(mount(tenantA));
    await waitFor(() => expect(name).toHaveValue("Tenant A newer draft"));
    expect(screen.getByText(/Synthetic response lost after commit/)).toBeInTheDocument();
    view.rerender(mount(tenantB));
    await waitFor(() => expect(name).toHaveValue("Tenant B draft"));

    act(() => { queryClient.removeQueries({ queryKey, exact: true }); });
    expect(queryClient.getQueryState(queryKey)).toBeUndefined();
    failRead = false;
    returnOldDefaultOnce = true;
    const readsBeforeRecreation = readA.mock.calls.length;
    view.rerender(mount(tenantA));
    await waitFor(() => expect(readA.mock.calls.length).toBeGreaterThan(readsBeforeRecreation));
    await waitFor(() => expect(screen.getByText("Default: Tenant A template, version 1")).toBeInTheDocument());
    expect(queryClient.getQueryState(queryKey)!.dataUpdateCount).toBe(1);
    expect(screen.getByText(/Synthetic response lost after commit/)).toBeInTheDocument();
    expect(name).toHaveValue("Tenant A newer draft");

    await act(async () => { await queryClient.refetchQueries({ queryKey, exact: true }); });
    await waitFor(() => expect(screen.getByText(`Default: ${second.displayName}, version 2`)).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(/Synthetic response lost after commit/)).not.toBeInTheDocument());
    expect(queryClient.getQueryState(queryKey)!.dataUpdateCount).toBe(2);
    expect(screen.getByText("Selected saved version: 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "set default" })).toBeDisabled();
    expect(name).toHaveValue("Tenant A newer draft");
    view.rerender(mount(tenantB));
    await waitFor(() => expect(name).toHaveValue("Tenant B draft"));
  },
);

it.each(["set default", "save default"] as const)(
  "labels the prior default as last read while %s is pending",
  async (action) => {
    const queryClient = createTestQueryClient();
    const first = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!),
      templateId: "synthetic-template", displayName: "Synthetic template", builtIn: false };
    first.activeVersion = { ...first.activeVersion, templateId: first.templateId, versionId: "synthetic-v1" };
    const second = { ...first, activeVersion: { ...first.activeVersion, versionId: "synthetic-v2", versionNumber: 2 } };
    const oldDefault = { ...sampleResumeTemplateListResponse.builtInDefault, templateId: first.templateId,
      templateVersionId: "synthetic-v1", templateVersionNumber: 1, templateName: first.displayName, assignmentSource: "profile_default" as const };
    let canonical = { ...structuredClone(sampleResumeTemplateListResponse),
      templates: [action === "set default" ? second : first], defaultTemplate: oldDefault };
    let finishDefault!: () => void;
    const setDefault = vi.fn(async () => {
      canonical = { ...canonical, defaultTemplate: { ...oldDefault, templateVersionId: "synthetic-v2", templateVersionNumber: 2 } };
      await new Promise<void>((resolve) => { finishDefault = resolve; });
      return { ok: true as const, defaultTemplate: canonical.defaultTemplate };
    });
    const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
      resumeTemplates: async () => structuredClone(canonical),
      saveResumeTemplate: async () => {
        canonical = { ...canonical, templates: [second] };
        return { ok: true as const, template: second };
      },
      setDefaultResumeTemplate: setDefault,
    } });
    render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
      <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
    </QueryClientProvider></TenantProvider></PortsProvider>);

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Synthetic template"));
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledOnce());
    expect(screen.getByText("Last read default: Synthetic template, version 1")).toBeInTheDocument();
    expect(screen.queryByText("default template")).not.toBeInTheDocument();
    await act(async () => { finishDefault(); });
    await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 2")).toBeInTheDocument());
  },
);

it("does not reconcile an unconfirmed write from a read started before the response failed", async () => {
  const queryClient = createTestQueryClient();
  const template = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!),
    templateId: "synthetic-template", displayName: "Synthetic template", builtIn: false };
  template.activeVersion = { ...template.activeVersion, templateId: template.templateId, versionId: "synthetic-v2", versionNumber: 2 };
  const oldDefault = { ...sampleResumeTemplateListResponse.builtInDefault, templateId: template.templateId,
    templateVersionId: "synthetic-v1", templateVersionNumber: 1, templateName: template.displayName, assignmentSource: "profile_default" as const };
  const canonical = { ...structuredClone(sampleResumeTemplateListResponse), templates: [template], defaultTemplate: oldDefault };
  let rejectDefault!: (error: Error) => void;
  let finishStaleRead!: (value: typeof canonical) => void;
  let finishFreshRead!: (value: typeof canonical) => void;
  let reads = 0;
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => {
      reads += 1;
      if (reads === 2) return new Promise<typeof canonical>((resolve) => { finishStaleRead = resolve; });
      if (reads === 3) return new Promise<typeof canonical>((resolve) => { finishFreshRead = resolve; });
      return structuredClone(canonical);
    },
    setDefaultResumeTemplate: async () => new Promise<ResumeTemplateDefaultSelectionResponse>((_resolve, reject) => { rejectDefault = reject; }),
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);

  await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Synthetic template"));
  fireEvent.click(screen.getByRole("button", { name: "set default" }));
  await act(async () => { void queryClient.invalidateQueries(); });
  await waitFor(() => expect(reads).toBe(2));
  await act(async () => { rejectDefault(new Error("Synthetic response lost")); });
  await waitFor(() => expect(reads).toBe(3));
  expect(await screen.findByText(/Synthetic response lost/)).toBeInTheDocument();
  await act(async () => { finishStaleRead({ ...canonical, defaultTemplate: { ...oldDefault, templateVersionId: "synthetic-v2", templateVersionNumber: 2 } }); });
  expect(screen.getByText(/Synthetic response lost/)).toBeInTheDocument();
  expect(screen.getByText("Last read default: Synthetic template, version 1")).toBeInTheDocument();
  await act(async () => { finishFreshRead(canonical); });
  await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 1")).toBeInTheDocument());
  expect(screen.getByText(/Synthetic response lost/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "set default" })).toBeEnabled();
});

it("marks a failed default refresh as last read and allows an explicit read retry", async () => {
  const queryClient = createTestQueryClient();
  const template = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!),
    templateId: "synthetic-template", displayName: "Synthetic template", builtIn: false };
  template.activeVersion = { ...template.activeVersion, templateId: template.templateId, versionId: "synthetic-v2", versionNumber: 2 };
  const oldDefault = { ...sampleResumeTemplateListResponse.builtInDefault, templateId: template.templateId,
    templateVersionId: "synthetic-v1", templateVersionNumber: 1, templateName: template.displayName, assignmentSource: "profile_default" as const };
  let canonical = { ...structuredClone(sampleResumeTemplateListResponse), templates: [template], defaultTemplate: oldDefault };
  let holdRead = false;
  let rejectRefresh!: (error: Error) => void;
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => {
      if (holdRead) return new Promise<typeof canonical>((_resolve, reject) => { rejectRefresh = reject; });
      return structuredClone(canonical);
    },
    setDefaultResumeTemplate: async () => {
      canonical = { ...canonical, defaultTemplate: { ...oldDefault, templateVersionId: "synthetic-v2", templateVersionNumber: 2 } };
      holdRead = true;
      return { ok: true as const, defaultTemplate: canonical.defaultTemplate };
    },
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);

  await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Synthetic template"));
  fireEvent.click(screen.getByRole("button", { name: "set default" }));
  expect(await screen.findByText("Last read default: Synthetic template, version 1")).toBeInTheDocument();
  expect(screen.getByText("Refreshing resume templates.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "set default" })).toBeDisabled();
  expect(screen.queryByText("default template")).not.toBeInTheDocument();
  await act(async () => { rejectRefresh(new Error("Synthetic template read failure")); });
  expect(await screen.findByText("Could not refresh templates. Check the current default before changing it.")).toBeInTheDocument();
  holdRead = false;
  fireEvent.click(screen.getByRole("button", { name: "retry templates" }));
  await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 2")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "set default" })).toBeDisabled();
  expect(screen.queryByText("Could not refresh templates. Check the current default before changing it.")).not.toBeInTheDocument();
});

it("retains a saved version when default selection fails and clears the error on retry", async () => {
  const queryClient = createTestQueryClient();
  const template = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!),
    templateId: "synthetic-template", displayName: "Synthetic template", builtIn: false };
  template.activeVersion = { ...template.activeVersion, templateId: template.templateId, versionId: "synthetic-v1" };
  const oldDefault = { ...sampleResumeTemplateListResponse.builtInDefault, templateId: template.templateId,
    templateVersionId: "synthetic-v1", templateVersionNumber: 1, templateName: template.displayName, assignmentSource: "profile_default" as const };
  let canonical = { ...structuredClone(sampleResumeTemplateListResponse), templates: [template], defaultTemplate: oldDefault };
  const saved = { ...template, activeVersion: { ...template.activeVersion, versionId: "synthetic-v2", versionNumber: 2 } };
  const save = vi.fn(async () => {
    if (save.mock.calls.length === 1) throw new Error("Synthetic save failure");
    canonical = { ...canonical, templates: [saved] };
    return { ok: true as const, template: saved };
  });
  const setDefault = vi.fn(async () => {
    if (setDefault.mock.calls.length === 1) throw new Error("Synthetic default failure");
    canonical = { ...canonical, defaultTemplate: { ...oldDefault, templateVersionId: "synthetic-v2", templateVersionNumber: 2 } };
    return { ok: true as const, defaultTemplate: canonical.defaultTemplate };
  });
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => structuredClone(canonical), saveResumeTemplate: save, setDefaultResumeTemplate: setDefault,
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);

  await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Synthetic template"));
  fireEvent.click(screen.getByRole("button", { name: "save default" }));
  expect(await screen.findByText("Synthetic save failure")).toBeInTheDocument();
  expect(setDefault).not.toHaveBeenCalled();
  expect(screen.getByText("Selected saved version: 1")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 1")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("button", { name: "save default" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "save default" }));
  expect(await screen.findByText("The version was saved, but the default change was not confirmed: Synthetic default failure")).toBeInTheDocument();
  expect(save).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Selected saved version: 2")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 1")).toBeInTheDocument());
  const button = screen.getByRole("button", { name: "set default" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(setDefault).toHaveBeenLastCalledWith({ templateId: "synthetic-template", versionId: "synthetic-v2", expectedActiveVersionId: "synthetic-v2" }));
  await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 2")).toBeInTheDocument());
  expect(screen.queryByText(/Synthetic default failure/)).not.toBeInTheDocument();
  expect(save).toHaveBeenCalledTimes(2);
});

it("keeps an independent default error through save version and clears it on a successful save default", async () => {
  const queryClient = createTestQueryClient();
  const template = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!),
    templateId: "synthetic-template", displayName: "Synthetic template", builtIn: false };
  template.activeVersion = { ...template.activeVersion, templateId: template.templateId, versionId: "synthetic-v2", versionNumber: 2 };
  const oldDefault = { ...sampleResumeTemplateListResponse.builtInDefault, templateId: template.templateId,
    templateVersionId: "synthetic-v1", templateVersionNumber: 1, templateName: template.displayName, assignmentSource: "profile_default" as const };
  let canonical = { ...structuredClone(sampleResumeTemplateListResponse), templates: [template], defaultTemplate: oldDefault };
  const setDefault = vi.fn(async (request: { templateId: string; versionId?: string }) => {
    if (setDefault.mock.calls.length === 1) throw new Error("Synthetic direct default failure");
    canonical = { ...canonical, defaultTemplate: { ...oldDefault, templateVersionId: request.versionId!, templateVersionNumber: 4 } };
    return { ok: true as const, defaultTemplate: canonical.defaultTemplate };
  });
  let failSave = true;
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => structuredClone(canonical),
    saveResumeTemplate: async () => {
      if (failSave) {
        failSave = false;
        throw new Error("Synthetic save failure");
      }
      const versionNumber = canonical.templates[0]!.activeVersion.versionNumber + 1;
      const saved = { ...template, activeVersion: { ...template.activeVersion, versionId: `synthetic-v${versionNumber}`, versionNumber } };
      canonical = { ...canonical, templates: [saved] };
      return { ok: true as const, template: saved };
    },
    setDefaultResumeTemplate: setDefault,
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);

  await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Synthetic template"));
  fireEvent.click(screen.getByRole("button", { name: "set default" }));
  expect(await screen.findByText("Default change was not confirmed. Check the current default before retrying. Synthetic direct default failure")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "save default" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "save default" }));
  expect(await screen.findByText("Synthetic save failure")).toBeInTheDocument();
  expect(setDefault).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole("button", { name: "save version" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "save version" }));
  await waitFor(() => expect(screen.getByText("Selected saved version: 3")).toBeInTheDocument());
  expect(screen.getByText("Default change was not confirmed. Check the current default before retrying. Synthetic direct default failure")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 1")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("button", { name: "save default" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "save default" }));
  await waitFor(() => expect(screen.getByText("Default: Synthetic template, version 4")).toBeInTheDocument());
  expect(screen.queryByText(/Synthetic direct default failure/)).not.toBeInTheDocument();
  expect(setDefault).toHaveBeenLastCalledWith({ templateId: "synthetic-template", versionId: "synthetic-v4", expectedActiveVersionId: "synthetic-v4" });
});

it("retains a template draft through first open, a pending save, and an older refresh", async () => {
  const queryClient = createTestQueryClient();
  let canonical = structuredClone(sampleResumeTemplateListResponse);
  let resolveSave!: (value: ResumeTemplateVersionSaveResponse) => void;
  const read = vi.fn(async () => structuredClone(canonical));
  const save = vi.fn((_request: ResumeTemplateVersionSaveRequest) => new Promise<ResumeTemplateVersionSaveResponse>((resolve) => { resolveSave = resolve; }));
  const ports = buildTestPorts({
    eventStream: new SseEventStreamAdapter(),
    api: { resumeTemplates: read, saveResumeTemplate: save },
  });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue("Modern HTML"));
  fireEvent.change(name, { target: { value: "Unsaved synthetic template" } });
  fireEvent.change(screen.getByLabelText("Font scale"), { target: { value: "1.1" } });
  canonical = { ...canonical, templates: canonical.templates.map((template) => ({
    ...template, displayName: "Saved elsewhere", activeVersion: { ...template.activeVersion, versionId: "other-version", versionNumber: 2 },
  })) };
  await act(async () => { ControlledEventSource.instances[0]!.emit("open"); });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(name).toHaveValue("Unsaved synthetic template");
  expect(screen.getByLabelText("Font scale")).toHaveValue(1.1);
  expect(screen.getByRole("button", { name: "save version" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Keep draft and review latest version" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "save version" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "save version" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0]).toMatchObject({ displayName: "Unsaved synthetic template", theme: { fontScale: 1.1 } });
  await act(async () => {
    ControlledEventSource.instances[0]!.emit("error");
    ControlledEventSource.instances[0]!.emit("open");
  });
  expect(name).toHaveValue("Unsaved synthetic template");
  const accepted = { ...canonical.templates[0]!, templateId: "accepted-synthetic", builtIn: false,
    displayName: "Unsaved synthetic template", activeVersion: { ...canonical.templates[0]!.activeVersion, versionId: "accepted-v1", versionNumber: 1, theme: { ...canonical.templates[0]!.activeVersion.theme, fontScale: 1.1 } } };
  await act(async () => { resolveSave({ ok: true, template: accepted }); });
  await waitFor(() => expect(name).toHaveValue("Unsaved synthetic template"));
  expect(screen.getByLabelText("Font scale")).toHaveValue(1.1);
});

it("adopts a refreshed template when its current draft has no edits", async () => {
  const queryClient = createTestQueryClient();
  let canonical = structuredClone(sampleResumeTemplateListResponse);
  const read = vi.fn(async () => structuredClone(canonical));
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: { resumeTemplates: read } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue("Modern HTML"));
  canonical = { ...canonical, templates: canonical.templates.map((template) => ({
    ...template, displayName: "Current synthetic template", activeVersion: { ...template.activeVersion, versionId: "new-version", versionNumber: 2 },
  })) };
  await act(async () => { ControlledEventSource.instances[0]!.emit("open"); });
  await waitFor(() => expect(name).toHaveValue("Current synthetic template"));
});

it("keeps template drafts scoped to the tenant across a session switch", async () => {
  const queryClient = createTestQueryClient();
  const eventStream = new SseEventStreamAdapter();
  const tenantA = buildTestPorts({ eventStream, api: { resumeTemplates: async () => structuredClone(sampleResumeTemplateListResponse) } });
  const tenantBId = "synthetic-tenant-b" as TenantId;
  const tenantB = {
    ...tenantA,
    session: new FakeSessionPort({ tenantId: tenantBId, userId: null }),
    api: { ...tenantA.api, resumeTemplates: async () => ({ ...structuredClone(sampleResumeTemplateListResponse),
      templates: sampleResumeTemplateListResponse.templates.map((template) => ({ ...structuredClone(template), displayName: "Tenant B template" })) }) },
  };
  const mount = (ports: typeof tenantA) => <PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>;
  expect(tenantA.session.getSession().tenantId).toBe(LOCAL_TENANT);
  const view = render(mount(tenantA));
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue("Modern HTML"));
  fireEvent.change(name, { target: { value: "Tenant A draft" } });
  view.rerender(mount(tenantB));
  await waitFor(() => expect(name).toHaveValue("Tenant B template"));
  fireEvent.change(name, { target: { value: "Tenant B draft" } });
  view.rerender(mount(tenantA));
  await waitFor(() => expect(name).toHaveValue("Tenant A draft"));
  view.rerender(mount(tenantB));
  await waitFor(() => expect(name).toHaveValue("Tenant B draft"));
});

it.each(["success", "failure"] as const)(
  "settles a pending direct default for its original tenant after switching sessions (%s)",
  async (outcome) => {
    const queryClient = createTestQueryClient();
    const eventStream = new SseEventStreamAdapter();
    const template = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!),
      templateId: "tenant-a-template", displayName: "Tenant A template", builtIn: false };
    template.activeVersion = { ...template.activeVersion, templateId: template.templateId, versionId: "tenant-a-v2", versionNumber: 2 };
    const oldDefault = { ...sampleResumeTemplateListResponse.builtInDefault, templateId: template.templateId,
      templateVersionId: "tenant-a-v1", templateVersionNumber: 1, templateName: template.displayName, assignmentSource: "profile_default" as const };
    let canonical = { ...structuredClone(sampleResumeTemplateListResponse), templates: [template], defaultTemplate: oldDefault };
    let finish!: () => void;
    const setDefaultA = vi.fn(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      if (outcome === "failure") throw new Error("Tenant A synthetic failure");
      canonical = { ...canonical, defaultTemplate: { ...oldDefault, templateVersionId: "tenant-a-v2", templateVersionNumber: 2 } };
      return { ok: true as const, defaultTemplate: canonical.defaultTemplate };
    });
    const tenantA = buildTestPorts({ eventStream, api: { resumeTemplates: async () => structuredClone(canonical), setDefaultResumeTemplate: setDefaultA } });
    const tenantB = { ...tenantA, session: new FakeSessionPort({ tenantId: "synthetic-tenant-b" as TenantId, userId: null }),
      api: { ...tenantA.api, resumeTemplates: async () => ({ ...structuredClone(sampleResumeTemplateListResponse),
        templates: sampleResumeTemplateListResponse.templates.map((item) => ({ ...structuredClone(item), displayName: "Tenant B template" })) }) } };
    const mount = (ports: typeof tenantA) => <PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
      <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
    </QueryClientProvider></TenantProvider></PortsProvider>;
    const view = render(mount(tenantA));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Tenant A template"));
    fireEvent.click(screen.getByRole("button", { name: "set default" }));
    await waitFor(() => expect(setDefaultA).toHaveBeenCalledOnce());
    view.rerender(mount(tenantB));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Tenant B template"));
    expect(screen.getByRole("button", { name: "save default" })).toBeEnabled();
    view.rerender(mount(tenantA));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Tenant A template"));
    expect(screen.getByRole("button", { name: "setting" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "save version" })).toBeDisabled();
    view.rerender(mount(tenantB));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Tenant B template"));
    await act(async () => { finish(); });
    view.rerender(mount(tenantA));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Tenant A template"));
    if (outcome === "failure") {
      expect(await screen.findByText(/Tenant A synthetic failure/)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "set default" })).toBeEnabled());
      expect(screen.getByRole("button", { name: "save default" })).toBeEnabled();
      expect(screen.getByText("Default: Tenant A template, version 1")).toBeInTheDocument();
    } else {
      await waitFor(() => expect(screen.getByText("Default: Tenant A template, version 2")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "save default" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "set default" })).toBeDisabled();
    }
  },
);

it("finishes a pending save default for its original tenant after switching sessions", async () => {
  const queryClient = createTestQueryClient();
  let resolveSave!: (value: ResumeTemplateVersionSaveResponse) => void;
  const save = vi.fn((_request: ResumeTemplateVersionSaveRequest) => new Promise<ResumeTemplateVersionSaveResponse>((resolve) => { resolveSave = resolve; }));
  const defaultResult = { ok: true as const, defaultTemplate: sampleResumeTemplateListResponse.builtInDefault };
  const defaultA = vi.fn(async () => defaultResult);
  const defaultB = vi.fn(async () => defaultResult);
  const tenantA = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: { saveResumeTemplate: save, setDefaultResumeTemplate: defaultA } });
  const tenantB = { ...tenantA, session: new FakeSessionPort({ tenantId: "synthetic-tenant-b" as TenantId, userId: null }),
    api: { ...tenantA.api, setDefaultResumeTemplate: defaultB } };
  const mount = (ports: typeof tenantA) => <PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>;
  const view = render(mount(tenantA));
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue("Modern HTML"));
  fireEvent.change(name, { target: { value: "Tenant A accepted" } });
  fireEvent.click(screen.getByRole("button", { name: "save default" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  view.rerender(mount(tenantB));
  await waitFor(() => expect(name).toHaveValue("Modern HTML"));
  fireEvent.change(name, { target: { value: "Tenant B draft" } });
  view.rerender(mount(tenantA));
  await waitFor(() => expect(name).toHaveValue("Tenant A accepted"));
  expect(name).toBeDisabled();
  view.rerender(mount(tenantB));
  await waitFor(() => expect(name).toHaveValue("Tenant B draft"));
  const saved = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!), templateId: "tenant-a-saved", builtIn: false,
    displayName: "Tenant A accepted", activeVersion: { ...sampleResumeTemplateListResponse.templates[0]!.activeVersion, versionId: "tenant-a-version" } };
  await act(async () => { resolveSave({ ok: true, template: saved }); });
  await waitFor(() => expect(defaultA).toHaveBeenCalledWith({ templateId: "tenant-a-saved", versionId: "tenant-a-version", expectedActiveVersionId: "tenant-a-version" }));
  expect(defaultB).not.toHaveBeenCalled();
  expect(name).toHaveValue("Tenant B draft");
  view.rerender(mount(tenantA));
  await waitFor(() => expect(name).toHaveValue("Tenant A accepted"));
  await waitFor(() => expect(name).toBeEnabled());
});

it("keeps independent drafts when switching between templates", async () => {
  const user = userEvent.setup();
  const queryClient = createTestQueryClient();
  const first = sampleResumeTemplateListResponse.templates[0]!;
  const second = { ...structuredClone(first), templateId: "synthetic-second", displayName: "Synthetic second" };
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => ({ ...structuredClone(sampleResumeTemplateListResponse), templates: [structuredClone(first), second] }),
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue("Modern HTML"));
  fireEvent.change(name, { target: { value: "First draft" } });
  await user.click(screen.getByLabelText("Template"));
  await user.click(await screen.findByRole("option", { name: "Synthetic second" }));
  await waitFor(() => expect(name).toHaveValue("Synthetic second"));
  await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  fireEvent.change(name, { target: { value: "Second draft" } });
  await user.click(screen.getByLabelText("Template"));
  await user.click(await screen.findByRole("option", { name: "Modern HTML" }));
  await waitFor(() => expect(name).toHaveValue("First draft"));
  await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  await user.click(screen.getByLabelText("Template"));
  await user.click(await screen.findByRole("option", { name: "Synthetic second" }));
  await waitFor(() => expect(name).toHaveValue("Second draft"));
});

it("retains a draft when another template version arrives during a save and does not set the stale version as default", async () => {
  const queryClient = createTestQueryClient();
  const original = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!), builtIn: false };
  let canonical = { ...structuredClone(sampleResumeTemplateListResponse), templates: [original] };
  let resolveSave!: (value: ResumeTemplateVersionSaveResponse) => void;
  const save = vi.fn((_request: ResumeTemplateVersionSaveRequest) => new Promise<ResumeTemplateVersionSaveResponse>((resolve) => { resolveSave = resolve; }));
  const setDefault = vi.fn(async () => ({ ok: true as const, defaultTemplate: canonical.builtInDefault }));
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => structuredClone(canonical), saveResumeTemplate: save, setDefaultResumeTemplate: setDefault,
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue(original.displayName));
  fireEvent.change(name, { target: { value: "Synthetic in-flight draft" } });
  fireEvent.click(screen.getByRole("button", { name: "save default" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0]).toMatchObject({ templateId: original.templateId, expectedVersionId: original.activeVersion.versionId });
  expect(name).toBeDisabled();
  canonical = { ...canonical, templates: [{ ...original, displayName: "Concurrent version", activeVersion: {
    ...original.activeVersion, versionId: "concurrent-version", versionNumber: original.activeVersion.versionNumber + 1,
  } }] };
  await act(async () => { ControlledEventSource.instances[0]!.emit("open"); });
  await waitFor(() => expect(screen.getByRole("group", { name: "Review changed template" })).toBeInTheDocument());
  expect(name).toHaveValue("Synthetic in-flight draft");
  const saved = { ...original, displayName: "Synthetic in-flight draft", activeVersion: {
    ...original.activeVersion, versionId: "saved-version", versionNumber: original.activeVersion.versionNumber + 2,
  } };
  canonical = { ...canonical, templates: [saved] };
  await act(async () => resolveSave({ ok: true, template: saved }));
  await waitFor(() => expect(screen.getByText(/version was saved, but the template changed during the save/i)).toBeInTheDocument());
  expect(setDefault).not.toHaveBeenCalled();
  expect(name).toHaveValue("Synthetic in-flight draft");
  expect(screen.getByRole("button", { name: "save version" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Keep draft and review latest version" }));
  expect(name).toHaveValue("Synthetic in-flight draft");
  await waitFor(() => expect(screen.getByRole("button", { name: "save version" })).toBeEnabled());
});

it("keeps a saved version selectable when setting it as the default fails", async () => {
  const user = userEvent.setup();
  const queryClient = createTestQueryClient();
  const original = sampleResumeTemplateListResponse.templates[0]!;
  const saved = { ...structuredClone(original), builtIn: false, templateId: "saved-synthetic-template", displayName: "Saved synthetic version", activeVersion: {
    ...original.activeVersion, templateId: "saved-synthetic-template", versionId: "saved-synthetic-version",
  } };
  const setDefault = vi.fn(async () => { throw new Error("Synthetic default failure"); });
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => structuredClone(sampleResumeTemplateListResponse),
    saveResumeTemplate: async () => ({ ok: true as const, template: saved }), setDefaultResumeTemplate: setDefault,
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue(original.displayName));
  fireEvent.change(name, { target: { value: "Saved synthetic version" } });
  fireEvent.click(screen.getByRole("button", { name: "save default" }));
  await screen.findByText(/version was saved, but the default change was not confirmed/i);
  expect(name).toHaveValue("Saved synthetic version");
  expect(setDefault).toHaveBeenCalledWith({ templateId: saved.templateId, versionId: saved.activeVersion.versionId, expectedActiveVersionId: saved.activeVersion.versionId });
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  expect(await screen.findByRole("option", { name: "Saved synthetic version" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "set default" })).toBeEnabled());
});

it("retains a saved template and both drafts after a failed list refresh and switching templates", async () => {
  const user = userEvent.setup();
  const queryClient = createTestQueryClient();
  const original = sampleResumeTemplateListResponse.templates[0]!;
  const saved = { ...structuredClone(original), builtIn: false, templateId: "saved-synthetic-template", displayName: "Saved synthetic version", activeVersion: {
    ...original.activeVersion, templateId: "saved-synthetic-template", versionId: "saved-synthetic-version",
  } };
  let failRead = false;
  const read = vi.fn(async () => {
    if (failRead) throw new Error("Synthetic list failure");
    return structuredClone(sampleResumeTemplateListResponse);
  });
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: read,
    saveResumeTemplate: async () => { failRead = true; return { ok: true as const, template: saved }; },
    setDefaultResumeTemplate: async () => { throw new Error("Synthetic default failure"); },
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue(original.displayName));
  fireEvent.change(name, { target: { value: saved.displayName } });
  await user.click(screen.getByRole("button", { name: "save default" }));
  await screen.findByText(/default change was not confirmed/i);
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
  expect(name).toHaveValue(saved.displayName);
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: original.displayName }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Template" })).toHaveTextContent(original.displayName));
  fireEvent.change(name, { target: { value: "Original unsaved draft" } });
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: saved.displayName }));
  await waitFor(() => expect(name).toHaveValue(saved.displayName));
  fireEvent.change(name, { target: { value: "Saved template unsaved draft" } });
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: original.displayName }));
  await waitFor(() => expect(name).toHaveValue("Original unsaved draft"));
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: saved.displayName }));
  await waitFor(() => expect(name).toHaveValue("Saved template unsaved draft"));
});

it("keeps acknowledged template choices tenant-scoped even when template IDs collide", async () => {
  const user = userEvent.setup();
  const queryClient = createTestQueryClient();
  const original = sampleResumeTemplateListResponse.templates[0]!;
  const savedA = { ...structuredClone(original), builtIn: false, templateId: "shared-synthetic-id", displayName: "Tenant A saved version", activeVersion: {
    ...original.activeVersion, templateId: "shared-synthetic-id", versionId: "tenant-a-version",
  } };
  const templateB = { ...structuredClone(savedA), displayName: "Tenant B same ID", activeVersion: {
    ...savedA.activeVersion, versionId: "tenant-b-version",
  } };
  let failRead = false;
  const tenantA = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => { if (failRead) throw new Error("Synthetic list failure"); return structuredClone(sampleResumeTemplateListResponse); },
    saveResumeTemplate: async () => { failRead = true; return { ok: true as const, template: savedA }; },
    setDefaultResumeTemplate: async () => { throw new Error("Synthetic default failure"); },
  } });
  const tenantB = { ...tenantA, session: new FakeSessionPort({ tenantId: "synthetic-tenant-b" as TenantId, userId: null }), api: {
    ...tenantA.api, resumeTemplates: async () => ({ ...structuredClone(sampleResumeTemplateListResponse), templates: [structuredClone(original), templateB] }),
  } };
  const mount = (ports: typeof tenantA) => <PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>;
  const view = render(mount(tenantA));
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue(original.displayName));
  fireEvent.change(name, { target: { value: savedA.displayName } });
  await user.click(screen.getByRole("button", { name: "save default" }));
  await screen.findByText(/default change was not confirmed/i);
  view.rerender(mount(tenantB));
  await waitFor(() => expect(name).toHaveValue(original.displayName));
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  expect(screen.queryByRole("option", { name: savedA.displayName })).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option", { name: templateB.displayName }));
  await waitFor(() => expect(name).toHaveValue(templateB.displayName));
  fireEvent.change(name, { target: { value: "Tenant B draft" } });
  view.rerender(mount(tenantA));
  await waitFor(() => expect(name).toHaveValue(savedA.displayName));
  view.rerender(mount(tenantB));
  await waitFor(() => expect(name).toHaveValue("Tenant B draft"));
});

it("blocks a stale retry until a successful read and a deliberate review of the newer template", async () => {
  const queryClient = createTestQueryClient();
  const original = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!), builtIn: false };
  let canonical = { ...structuredClone(sampleResumeTemplateListResponse), templates: [original] };
  let failRead = false;
  const read = vi.fn(async () => {
    if (failRead) throw new Error("Synthetic read failure");
    return structuredClone(canonical);
  });
  const save = vi.fn(async (_body: ResumeTemplateVersionSaveRequest): Promise<ResumeTemplateVersionSaveResponse> => {
    if (save.mock.calls.length === 1) throw new JobCtrlApiError(409, "Conflict", "The template changed.");
    return { ok: true, template: canonical.templates[0]! };
  });
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: { resumeTemplates: read, saveResumeTemplate: save } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue(original.displayName));
  fireEvent.change(name, { target: { value: "Retained synthetic draft" } });
  failRead = true;
  fireEvent.click(screen.getByRole("button", { name: "save version" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  await screen.findByRole("group", { name: "Review changed template" });
  expect(screen.getByRole("button", { name: "save version" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Keep draft and review latest version" }));
  await screen.findByText(/could not load the latest template/i);
  expect(name).toHaveValue("Retained synthetic draft");
  expect(screen.getByRole("button", { name: "save version" })).toBeDisabled();
  expect(save).toHaveBeenCalledOnce();
  failRead = false;
  canonical = { ...canonical, templates: [{ ...original, displayName: "Newer template", activeVersion: {
    ...original.activeVersion, versionId: "newer-version", versionNumber: 2,
    theme: { ...original.activeVersion.theme, fontScale: 1.2 },
  } }] };
  fireEvent.click(screen.getByRole("button", { name: "Keep draft and review latest version" }));
  await screen.findByText(/template changed again/i);
  expect(screen.getByRole("button", { name: "save version" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Keep draft and review latest version" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "save version" })).toBeEnabled());
  expect(name).toHaveValue("Retained synthetic draft");
  expect(screen.getByLabelText("Font scale")).toHaveValue(1.2);
  fireEvent.click(screen.getByRole("button", { name: "save version" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]?.[0]).toMatchObject({ templateId: original.templateId, expectedVersionId: "newer-version", displayName: "Retained synthetic draft", theme: { fontScale: 1.2 } });
});

it("keeps the saved version selectable when a newer version wins before set-default", async () => {
  const queryClient = createTestQueryClient();
  const original = { ...structuredClone(sampleResumeTemplateListResponse.templates[0]!), builtIn: false };
  const saved = { ...original, displayName: "Saved synthetic draft", activeVersion: { ...original.activeVersion, versionId: "saved-v2", versionNumber: 2 } };
  const newer = { ...original, displayName: "Newer synthetic version", activeVersion: { ...original.activeVersion, versionId: "newer-v3", versionNumber: 3 } };
  let canonical = { ...structuredClone(sampleResumeTemplateListResponse), templates: [original] };
  const save = vi.fn(async (_body: ResumeTemplateVersionSaveRequest): Promise<ResumeTemplateVersionSaveResponse> => {
    canonical = { ...canonical, templates: [saved] };
    return { ok: true, template: saved };
  });
  const setDefault = vi.fn(async (body: { templateId: string; versionId?: string; expectedActiveVersionId?: string }) => {
    if (setDefault.mock.calls.length === 1) {
      canonical = { ...canonical, templates: [newer] };
      throw new JobCtrlApiError(409, "Conflict", "The template changed.");
    }
    expect(body).toEqual({ templateId: original.templateId, versionId: "saved-v2", expectedActiveVersionId: "newer-v3" });
    return { ok: true as const, defaultTemplate: canonical.builtInDefault };
  });
  const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter(), api: {
    resumeTemplates: async () => structuredClone(canonical), saveResumeTemplate: save, setDefaultResumeTemplate: setDefault,
  } });
  render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
    <EventStreamProvider><ResumeTemplatePanel profileHtmlPreviewUrl={null} /></EventStreamProvider>
  </QueryClientProvider></TenantProvider></PortsProvider>);
  const name = await screen.findByLabelText("Name");
  await waitFor(() => expect(name).toHaveValue(original.displayName));
  fireEvent.change(name, { target: { value: "Saved synthetic draft" } });
  fireEvent.click(screen.getByRole("button", { name: "save default" }));
  await screen.findByText(/default change was not confirmed/i);
  expect(name).toHaveValue("Saved synthetic draft");
  const review = await screen.findByRole("group", { name: "Review changed template" });
  expect(review).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(/current version is 3/i)).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Keep draft and review latest version" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Set saved version 2 as default" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Set saved version 2 as default" }));
  await waitFor(() => expect(setDefault).toHaveBeenCalledTimes(2));
});
