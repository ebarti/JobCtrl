import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
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
