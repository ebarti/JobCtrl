import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DemoConsentClient } from "./DemoConsentClient.js";
import { DemoConsentGate } from "./DemoConsentGate.js";

const KEY = "g".repeat(32);

describe("DemoConsentGate", () => {
  it("discloses the hard gate and retries a failed acceptance without entering", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(json({ choice: "granted", version: "v2" }));
    const onGranted = vi.fn();
    render(
      <DemoConsentGate
        client={new DemoConsentClient({ fetcher: fetcher as typeof fetch, createOperationKey: () => KEY })}
        initialChoice="unknown"
        onDeclined={vi.fn()}
        onGranted={onGranted}
      />,
    );
    const user = userEvent.setup();

    expect(screen.getByText(/demo can only be used after accepting analytics cookies/i)).toBeVisible();
    expect(screen.getByText(/coarse demo measurement and Google Analytics/i)).toBeVisible();
    expect(screen.getByText(/data controller: eloi barti, acting as an individual/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "me@eloibarti.com" })).toHaveAttribute(
      "href",
      "mailto:me@eloibarti.com",
    );
    expect(screen.getByRole("link", { name: "demo data notice" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/data-and-safety#public-demo",
    );
    expect(screen.getByRole("link", { name: "security boundary" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/security#public-demo-boundary",
    );
    const acceptButton = screen.getByRole("button", { name: "Accept cookies and enter demo" });
    expect(acceptButton).toHaveAttribute("data-slot", "button");
    await user.click(acceptButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/i);
    expect(onGranted).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Accept cookies and enter demo" }));
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
  });

  it("reopens after denial and leaves even when anonymous measurement fails", async () => {
    const onDeclined = vi.fn();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject(new TypeError("offline")));
    render(
      <DemoConsentGate
        client={new DemoConsentClient({ fetcher: fetcher as typeof fetch, createOperationKey: () => KEY })}
        initialChoice="denied"
        onDeclined={onDeclined}
        onGranted={vi.fn()}
      />,
    );
    const user = userEvent.setup();

    expect(screen.getByText(/previously declined/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Decline and return to jobctrl.dev" }));
    await waitFor(() => expect(onDeclined).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      choice: "denied",
      operationKey: KEY,
    });
  });

  it("recovers the accept controls when the consent service never settles", async () => {
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => undefined),
    );
    render(
      <DemoConsentGate
        client={new DemoConsentClient({ fetcher: fetcher as typeof fetch, requestTimeoutMs: 5 })}
        initialChoice="unknown"
        onDeclined={vi.fn()}
        onGranted={vi.fn()}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Accept cookies and enter demo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/i);
    expect(screen.getByRole("button", { name: "Accept cookies and enter demo" })).toBeEnabled();
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
