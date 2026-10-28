import { QueryClientProvider } from "@tanstack/react-query";
import type { ResumeTemplateVersionSaveRequest, ResumeTemplateVersionSaveResponse } from "@jobctrl/contracts";
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

it("finishes a pending save default for its original tenant after switching sessions", async () => {
  const queryClient = createTestQueryClient();
  let resolveSave!: (value: ResumeTemplateVersionSaveResponse) => void;
  const save = vi.fn(() => new Promise<ResumeTemplateVersionSaveResponse>((resolve) => { resolveSave = resolve; }));
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
  await waitFor(() => expect(defaultA).toHaveBeenCalledWith({ templateId: "tenant-a-saved", versionId: "tenant-a-version" }));
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
