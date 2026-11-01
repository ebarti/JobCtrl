import { http, HttpResponse } from "msw";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { discoveryKeys } from "../../contexts/discovery/queryKeys.js";
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../test/msw/server.js";
import { renderWithProviders } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { DemoFeatureFlagAdapter } from "../../demo/ports.js";
import { ImportJobUrlDialog } from "./ImportJobUrlDialog.js";

describe("ImportJobUrlDialog", () => {
  it("imports a public posting and hands the canonical job to the Jobs page", async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    server.use(
      http.post("*/v1/jobs/import-url", () =>
        HttpResponse.json({
          ok: true,
          status: "imported",
          jobKey: "7bf7e789-8a2f-45e4-8c41-00e71525d05c",
          importedAt: "2026-08-13T15:00:00Z",
          alreadyExisted: false,
        }),
      ),
    );
    renderWithProviders(<ImportJobUrlDialog onImported={onImported} />);

    await user.click(screen.getByRole("button", { name: "Import job" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a job posting" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Job posting URL" }),
      "https://example.com/jobs/42",
    );
    await user.click(within(dialog).getByRole("button", { name: "Import job" }));

    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith("7bf7e789-8a2f-45e4-8c41-00e71525d05c"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("explains when the page was routed to Manual Capture", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/v1/jobs/import-url", () =>
        HttpResponse.json({
          ok: true,
          status: "manual_capture_required",
          itemId: "manual:abc",
          reason: "login_required",
        }),
      ),
    );
    renderWithProviders(<ImportJobUrlDialog onImported={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Import job" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a job posting" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Job posting URL" }),
      "https://example.com/jobs/protected",
    );
    await user.click(within(dialog).getByRole("button", { name: "Import job" }));

    expect(
      await within(dialog).findByText(/could not read that page automatically/i),
    ).toBeVisible();
    expect(within(dialog).getByRole("link", { name: "Open Manual Capture" })).toHaveAttribute(
      "href",
      "/discovery",
    );
  });

  it("keeps malformed URLs client-side", async () => {
    const user = userEvent.setup();
    let requests = 0;
    server.use(
      http.post("*/v1/jobs/import-url", () => {
        requests += 1;
        return HttpResponse.json({ ok: false }, { status: 500 });
      }),
    );
    renderWithProviders(<ImportJobUrlDialog onImported={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Import job" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a job posting" });
    await user.type(within(dialog).getByRole("textbox", { name: "Job posting URL" }), "nope");
    await user.click(within(dialog).getByRole("button", { name: "Import job" }));

    expect(await within(dialog).findByText(/valid http\(s\) URL/i)).toBeVisible();
    expect(requests).toBe(0);
  });

  it("keeps credential-bearing URLs out of worker history", async () => {
    const user = userEvent.setup();
    let requests = 0;
    server.use(
      http.post("*/v1/jobs/import-url", () => {
        requests += 1;
        return HttpResponse.json({ ok: false }, { status: 500 });
      }),
    );
    renderWithProviders(<ImportJobUrlDialog onImported={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Import job" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a job posting" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Job posting URL" }),
      "https://user:password@example.com/jobs/42",
    );
    await user.click(within(dialog).getByRole("button", { name: "Import job" }));

    expect(await within(dialog).findByText(/must not contain embedded credentials/i)).toBeVisible();
    expect(requests).toBe(0);
  });

  it("keeps the unavailable explanation and install action reachable", async () => {
    const user = userEvent.setup();
    const ports = buildTestPorts();
    ports.featureFlags = new DemoFeatureFlagAdapter();
    renderWithProviders(<ImportJobUrlDialog onImported={vi.fn()} />, { ports });

    const trigger = screen.getByRole("button", { name: "Import job" });
    expect(trigger).toBeEnabled();
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Import a job posting" });
    expect(within(dialog).getByText(/requires the local worker/i)).toBeVisible();
    expect(within(dialog).getByRole("link", { name: "Install JobCtrl" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Import job" })).toBeDisabled();
  });
});


describe("acknowledged import progress", () => {
  const execution = { workflowId: "job-url-import-owned", executionId: "11111111-1111-4111-8111-111111111111" };
  const secondExecution = { workflowId: "job-url-import-second", executionId: "33333333-3333-4333-8333-333333333333" };
  const imported = { ok: true, status: "imported", jobKey: "22222222-2222-4222-8222-222222222222", importedAt: "2026-10-24T12:00:00Z", alreadyExisted: false };
  async function submit() {
    const user = userEvent.setup();
    const onImported = vi.fn();
    const harness = renderWithProviders(<ImportJobUrlDialog onImported={onImported} />);
    await user.click(screen.getByRole("button", { name: "Import job" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a job posting" });
    await user.type(within(dialog).getByRole("textbox", { name: "Job posting URL" }), "https://example.test/jobs/42");
    await user.click(within(dialog).getByRole("button", { name: "Import job" }));
    return { ...harness, onImported, dialog };
  }

  it("starts another import in the same dialog and tracks both without interrupting the user", async () => {
    let complete = false;
    const starts: string[] = [];
    server.use(
      http.post("*/v1/jobs/import-url", async ({ request }) => {
        const body = await request.json() as { url: string; awaitResult: boolean };
        expect(body.awaitResult).toBe(false);
        starts.push(body.url);
        return HttpResponse.json({ ok: true, status: "started", ...(starts.length === 1 ? execution : secondExecution) }, { status: 202 });
      }),
      http.get("*/v1/jobs/import-url/:workflowId/:executionId", ({ params }) => HttpResponse.json(
        complete && params.executionId === execution.executionId
          ? imported
          : { ok: true, status: "pending", ...(params.executionId === execution.executionId ? execution : secondExecution) },
      )),
    );
    const { queryClient, dialog, onImported } = await submit();
    expect(await within(dialog).findByText(/Import accepted and running/)).toBeVisible();
    const user = userEvent.setup();
    const input = within(dialog).getByRole("textbox", { name: "Job posting URL" });
    expect(input).toHaveValue("");
    expect(input).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Import job" })).toBeEnabled();
    expect(within(dialog).getByRole("link", { name: "View import run" })).toHaveAttribute("href", `/runs/${execution.workflowId}`);
    await user.type(input, "https://example.test/jobs/43");
    await user.click(within(dialog).getByRole("button", { name: "Import job" }));
    await waitFor(() => expect(within(dialog).getAllByRole("link", { name: "View import run" })).toHaveLength(2));
    expect(starts).toEqual(["https://example.test/jobs/42", "https://example.test/jobs/43"]);
    expect(input).toHaveValue("");
    await user.type(input, "https://example.test/jobs/draft");
    complete = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: discoveryKeys.jobUrlImportStatus(LOCAL_TENANT, execution.workflowId, execution.executionId) }); });
    const openJob = await within(dialog).findByRole("button", { name: "View job" });
    expect(onImported).not.toHaveBeenCalled();
    expect(dialog).toBeVisible();
    expect(input).toHaveValue("https://example.test/jobs/draft");
    expect(within(dialog).getByText(/Import accepted and running/)).toBeVisible();
    await user.click(openJob);
    expect(onImported).toHaveBeenCalledExactlyOnceWith(imported.jobKey);
  });

  it("shows a canceled execution as terminal and permits a new explicit import", async () => {
    server.use(
      http.post("*/v1/jobs/import-url", () => HttpResponse.json({ ok: true, status: "started", ...execution }, { status: 202 })),
      http.get("*/v1/jobs/import-url/:workflowId/:executionId", () => HttpResponse.json({ ok: true, status: "canceled", message: "This import was canceled.", ...execution })),
    );
    const { dialog, onImported } = await submit();
    expect(await within(dialog).findByText(/This import was canceled/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Import job" })).toBeEnabled();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("retains an acknowledged import when status reads fail, then recovers without another POST", async () => {
    let unavailable = true;
    let starts = 0;
    server.use(
      http.post("*/v1/jobs/import-url", () => { starts += 1; return HttpResponse.json({ ok: true, status: "started", ...execution }, { status: 202 }); }),
      http.get("*/v1/jobs/import-url/:workflowId/:executionId", () => unavailable
        ? HttpResponse.json({ ok: false, message: "Status unavailable" }, { status: 503 }) : HttpResponse.json(imported)),
    );
    const { queryClient, dialog, onImported } = await submit();
    expect(await within(dialog).findByText(/Progress is temporarily unavailable/, {}, { timeout: 6_000 })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Import job" })).toBeEnabled();
    unavailable = false;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: discoveryKeys.jobUrlImportStatus(LOCAL_TENANT, execution.workflowId, execution.executionId) }); });
    expect(await within(dialog).findByRole("button", { name: "View job" })).toBeEnabled();
    expect(onImported).not.toHaveBeenCalled();
    expect(starts).toBe(1);
  });

  it("keeps an accepted run visible and the form available after closing and reopening", async () => {
    server.use(
      http.post("*/v1/jobs/import-url", () => HttpResponse.json({ ok: true, status: "started", ...execution }, { status: 202 })),
      http.get("*/v1/jobs/import-url/:workflowId/:executionId", () => HttpResponse.json({ ok: true, status: "pending", ...execution })),
    );
    const { dialog } = await submit();
    expect(await within(dialog).findByText(/Import accepted and running/)).toBeVisible();
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Import job" }));
    const reopened = await screen.findByRole("dialog", { name: "Import a job posting" });
    expect(within(reopened).getByRole("textbox", { name: "Job posting URL" })).toHaveValue("");
    expect(within(reopened).getByRole("button", { name: "Import job" })).toBeEnabled();
    expect(within(reopened).getByRole("link", { name: "View import run" })).toHaveAttribute("href", `/runs/${execution.workflowId}`);
  });
});
