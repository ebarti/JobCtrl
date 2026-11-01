import { fireEvent, waitFor } from "@testing-library/react";
import { JobCtrlApiClient } from "@jobctrl/api-client";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../../demo/ports.js";
import { acknowledgeOutreachRevision, makeOutreachDraft, makeOutreachThreadDetail, makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { createTestQueryClient, renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ReviseDraftForm } from "./revise-draft-form.js";

function revisedThread(text: string) {
  return acknowledgeOutreachRevision(makeOutreachThreadResponse(makeOutreachThreadDetail({ drafts: [
    makeOutreachDraft({ draftId: "saved-draft", threadId: "thread-1", generation: 2, bodyText: text }),
  ] })), "saved-draft");
}

it.each([
  { label: "JSON null", body: null },
  { label: "missing thread", body: { ok: true } },
  { label: "null thread", body: { ok: true, thread: null } },
  { label: "wrong thread", body: { ok: true, thread: { threadId: "other-thread", drafts: [] } } },
  { label: "missing draft", body: { ok: true, thread: { threadId: "thread-1", drafts: [] } } },
  { label: "unrelated draft", body: { ok: true, thread: { threadId: "thread-1", drafts: [{ draftId: "old", threadId: "thread-1", generation: 1, bodyText: "Old draft" }] } } },
  { label: "a matching draft without publication identity", body: makeOutreachThreadResponse(makeOutreachThreadDetail({ drafts: [
    makeOutreachDraft({ draftId: "old", generation: 1, status: "superseded", bodyText: "Submitted synthetic A" }),
  ] })) },
  { label: "a publication missing from the readback", body: {
    ...revisedThread("Submitted synthetic A"),
    publication: { threadId: "thread-1", draftId: "not-in-readback", generation: 2 },
  } },
  { label: "a different published draft despite a matching historical draft", body: {
    ok: true,
    publication: { threadId: "thread-1", draftId: "current", generation: 2 },
    thread: makeOutreachThreadDetail({ drafts: [
      makeOutreachDraft({ draftId: "old", generation: 1, status: "superseded", bodyText: "Submitted synthetic A" }),
      makeOutreachDraft({ draftId: "current", generation: 2, status: "candidate", bodyText: "A different current draft" }),
    ] }),
  } },
  { label: "a mismatched publication generation", body: {
    ...revisedThread("Submitted synthetic A"),
    publication: { threadId: "thread-1", draftId: "saved-draft", generation: 3 },
  } },
  { label: "a publication for another thread", body: {
    ...revisedThread("Submitted synthetic A"),
    publication: { threadId: "other-thread", draftId: "saved-draft", generation: 2 },
  } },
])("retains submitted and newer edits when a success response is $label", async ({ body }) => {
  const requests: string[] = [];
  let finish: (response: Response) => void = () => {};
  const onRevised = vi.fn();
  server.use(http.post("*/v1/outreach/threads/:threadId/drafts", async ({ request }) => {
    const text = ((await request.json()) as { editedBodyText: string }).editedBodyText;
    requests.push(text);
    if (requests.length === 1) return new Promise<Response>((resolve) => { finish = resolve; });
    return HttpResponse.json(revisedThread(text));
  }));
  const view = renderWithProviders(<ReviseDraftForm threadId="thread-1" contactId="contact-1" initialBodyText="Original" onRevised={onRevised} />);
  const input = view.getByRole("textbox", { name: "Edit message" });
  const submit = view.getByRole("button", { name: "Revise draft" });
  fireEvent.change(input, { target: { value: "Submitted synthetic A" } });
  fireEvent.click(submit);
  await waitFor(() => expect(requests).toEqual(["Submitted synthetic A"]));
  fireEvent.change(input, { target: { value: "Newer synthetic B" } });
  finish(HttpResponse.json(body));
  const unconfirmed = await view.findByRole("group", { name: "Unconfirmed revision" });
  expect(unconfirmed).toHaveTextContent("Submitted synthetic A");
  expect(input).toHaveValue("Newer synthetic B");
  expect(submit).toBeDisabled();
  expect(onRevised).not.toHaveBeenCalled();
  expect(requests).toEqual(["Submitted synthetic A"]);
  fireEvent.click(view.getByRole("checkbox", { name: /I checked the current thread/ }));
  fireEvent.click(submit);
  await waitFor(() => expect(onRevised).toHaveBeenCalledTimes(1));
  expect(requests).toEqual(["Submitted synthetic A", "Newer synthetic B"]);
});

it("retains both edits and requires review after a server error may follow a commit", async () => {
  const requests: string[] = [];
  let finish: (response: Response) => void = () => {};
  const onRevised = vi.fn();
  server.use(http.post("*/v1/outreach/threads/:threadId/drafts", async ({ request }) => {
    const text = ((await request.json()) as { editedBodyText: string }).editedBodyText;
    requests.push(text);
    if (requests.length === 1) return new Promise<Response>((resolve) => { finish = resolve; });
    return HttpResponse.json(revisedThread(text));
  }));
  const view = renderWithProviders(<ReviseDraftForm threadId="thread-1" contactId="contact-1" initialBodyText="Original" onRevised={onRevised} />);
  const input = view.getByRole("textbox", { name: "Edit message" });
  const submit = view.getByRole("button", { name: "Revise draft" });
  fireEvent.change(input, { target: { value: "Submitted synthetic A" } });
  fireEvent.click(submit);
  await waitFor(() => expect(requests).toEqual(["Submitted synthetic A"]));
  fireEvent.change(input, { target: { value: "Newer synthetic B" } });
  finish(HttpResponse.json({ error: "db_write_failed", message: "Synthetic post-commit failure" }, { status: 500 }));
  const unconfirmed = await view.findByRole("group", { name: "Unconfirmed revision" });
  expect(unconfirmed).toHaveTextContent("Submitted synthetic A");
  expect(input).toHaveValue("Newer synthetic B");
  expect(submit).toBeDisabled();
  expect(onRevised).not.toHaveBeenCalled();
  expect(requests).toEqual(["Submitted synthetic A"]);
  fireEvent.click(view.getByRole("checkbox", { name: /I checked the current thread/ }));
  fireEvent.click(submit);
  await waitFor(() => expect(onRevised).toHaveBeenCalledTimes(1));
  expect(requests).toEqual(["Submitted synthetic A", "Newer synthetic B"]);
});

describe("<ReviseDraftForm>", () => {
  it("fails closed in the public demo before processing a message revision", () => {
    const reviseOutreachDraft = vi.fn();
    const ports = buildTestPorts({ api: { reviseOutreachDraft } });
    ports.featureFlags = new DemoFeatureFlagAdapter();
    const view = renderWithProviders(
      <ReviseDraftForm
        threadId="thread-1"
        contactId="contact-1"
        initialBodyText="Synthetic draft"
      />,
      { ports },
    );

    const textarea = view.getByRole("textbox", { name: "Edit message" });
    const submit = view.getByRole("button", { name: "Revise draft" });
    expect(textarea).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription(
      /Draft revision is available in the local app.*does not process message edits/i,
    );
    fireEvent.submit(view.container.querySelector("form")!);
    expect(reviseOutreachDraft).not.toHaveBeenCalled();
  });

  it("settles a delayed server failure without an unhandled rejection and requires review before retry", async () => {
    let settleFailure: (response: Response) => void = () => {};
    const onRevised = vi.fn();
    const onUnhandledRejection = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    server.use(
      http.post("*/v1/outreach/threads/:threadId/drafts", () =>
        new Promise<Response>((resolve) => {
          settleFailure = resolve;
        }),
      ),
    );

    try {
      const view = renderWithProviders(
        <ReviseDraftForm
          threadId="thread-1"
          contactId="contact-1"
          initialBodyText="Hi Dana,\n\nOriginal message.\n\nBest,\nJordan"
          onRevised={onRevised}
        />,
      );
      const textarea = view.getByRole("textbox", { name: "Edit message" });
      const submit = view.getByRole("button", { name: "Revise draft" });
      const editedBodyText = "Hi Dana,\n\nEdited message to retry.\n\nBest,\nJordan";

      fireEvent.change(textarea, { target: { value: editedBodyText } });
      fireEvent.click(submit);
      await waitFor(() => expect(submit).toHaveTextContent("Revising…"));

      settleFailure(
        HttpResponse.json({ message: "Revision service is temporarily unavailable." }, { status: 500 }),
      );

      const unconfirmed = await view.findByRole("group", { name: "Unconfirmed revision" });
      expect(unconfirmed.querySelector("pre")?.textContent).toBe(editedBodyText);
      expect(textarea).toHaveValue(editedBodyText);
      expect(submit).toBeDisabled();
      expect(onRevised).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onUnhandledRejection).not.toHaveBeenCalled();

      server.use(
        http.post("*/v1/outreach/threads/:threadId/drafts", () =>
          HttpResponse.json(revisedThread(editedBodyText)),
        ),
      );
      fireEvent.click(view.getByRole("checkbox", { name: /I checked the current thread/ }));
      fireEvent.click(submit);
      await waitFor(() => expect(onRevised).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    }
  });
});

it("retains unpublished results and edits after conflict and requires deliberate reconciliation before retry", async () => {
  const { makeOutreachPublicationConflict } = await import("../../../test/fixtures/outreach.js");
  let calls = 0;
  server.use(http.post("*/v1/outreach/threads/:threadId/drafts", () => {
    calls += 1;
    return HttpResponse.json(makeOutreachPublicationConflict(), { status: 409 });
  }));
  const onRevised = vi.fn();
  const view = renderWithProviders(<ReviseDraftForm threadId="thread-1" contactId="contact-1" initialBodyText="Original" onRevised={onRevised} />);
  fireEvent.change(view.getByRole("textbox", { name: "Edit message" }), { target: { value: "My retained message" } });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(view.getByRole("group", { name: "Unpublished revision" })).toBeInTheDocument());
  expect(view.getByRole("textbox")).toHaveValue("My retained message");
  expect(view.getByRole("button", { name: "Revise draft" })).toBeDisabled();
  expect(view.getByText(/synthetic-claim-review/)).toBeInTheDocument();
  expect(onRevised).not.toHaveBeenCalled();
  expect(calls).toBe(1);
  fireEvent.click(view.getByRole("checkbox", { name: /I compared the current thread/ }));
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(calls).toBe(2));
  await waitFor(() => expect(view.getByRole("button", { name: "Revise draft" })).toBeDisabled());
});

it("closes after success when the unchanged input was trimmed for the request", async () => {
  const onRevised = vi.fn();
  let finish: (response: Response) => void = () => {};
  let submitted = "";
  server.use(http.post("*/v1/outreach/threads/:threadId/drafts", async ({ request }) => {
    submitted = ((await request.json()) as { editedBodyText: string }).editedBodyText;
    return new Promise<Response>((resolve) => { finish = resolve; });
  }));
  const view = renderWithProviders(<ReviseDraftForm threadId="thread-1" contactId="contact-1" initialBodyText="Original" onRevised={onRevised} />);
  fireEvent.change(view.getByRole("textbox", { name: "Edit message" }), { target: { value: "  Unchanged synthetic edit  " } });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(submitted).toBe("Unchanged synthetic edit"));
  finish(HttpResponse.json(revisedThread("Unchanged synthetic edit")));
  await waitFor(() => expect(onRevised).toHaveBeenCalledTimes(1));
  expect(view.queryByText(/newer edits remain here/i)).not.toBeInTheDocument();
});

it("retains submitted and newer edits after unconfirmed responses, with no automatic replay", async () => {
  const bodies: string[] = [];
  let releaseLateResponse = () => {};
  const client = new JobCtrlApiClient("http://synthetic.invalid", 250);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    bodies.push((JSON.parse(String(init?.body)) as { editedBodyText: string }).editedBodyText);
    if (bodies.length > 2) return Response.json(revisedThread(bodies.at(-1)!));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"thread":'));
        if (bodies.length === 1) {
          // A noncooperative body can complete late; it must not confirm a
          // request which has already settled as unconfirmed.
          releaseLateResponse = () => {
            controller.enqueue(new TextEncoder().encode("null}"));
            controller.close();
          };
        } else {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        }
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  });
  const ports = buildTestPorts({ api: { reviseOutreachDraft: client.reviseOutreachDraft.bind(client) } });
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({ mutations: { retry: 2, retryDelay: 0 } });
  const onRevised = vi.fn();
  try {
    const view = renderWithProviders(
      <ReviseDraftForm threadId="thread-1" contactId="contact-1" initialBodyText="Synthetic original" onRevised={onRevised} />,
      { ports, queryClient },
    );
    const input = view.getByRole("textbox", { name: "Edit message" });
    const submit = view.getByRole("button", { name: "Revise draft" });
    fireEvent.change(input, { target: { value: "Synthetic submitted A" } });
    fireEvent.click(submit);
    await waitFor(() => expect(bodies).toEqual(["Synthetic submitted A"]));
    fireEvent.change(input, { target: { value: "Synthetic newer B" } });

    const first = await view.findByRole("group", { name: "Unconfirmed revision" });
    expect(first).toHaveTextContent("Synthetic submitted A");
    expect(first).toHaveTextContent("may have been saved");
    expect(first).toHaveTextContent("may still complete later");
    expect(input).toHaveValue("Synthetic newer B");
    await waitFor(() => expect(submit).toHaveTextContent("Revise draft"));
    expect(submit).toBeDisabled();
    expect(onRevised).not.toHaveBeenCalled();
    expect(bodies).toEqual(["Synthetic submitted A"]);
    releaseLateResponse();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onRevised).not.toHaveBeenCalled();
    expect(first).toHaveTextContent("Synthetic submitted A");

    fireEvent.click(view.getByRole("checkbox", { name: /I checked the current thread/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(bodies).toEqual(["Synthetic submitted A", "Synthetic newer B"]));
    fireEvent.change(input, { target: { value: "Synthetic latest C" } });
    await waitFor(() => expect(first).toHaveTextContent("Synthetic newer B"));
    expect(first).toHaveTextContent("Synthetic submitted A");
    expect(input).toHaveValue("Synthetic latest C");
    expect(submit).toBeDisabled();
    expect(bodies).toEqual(["Synthetic submitted A", "Synthetic newer B"]);

    fireEvent.click(view.getByRole("checkbox", { name: /I checked the current thread/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(onRevised).toHaveBeenCalledTimes(1));
    expect(bodies).toEqual(["Synthetic submitted A", "Synthetic newer B", "Synthetic latest C"]);
  } finally {
    fetchSpy.mockRestore();
  }
});

it("retains both edits when the connection drops before the acknowledgement", async () => {
  let disconnect!: (error: Error) => void;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((_resolve, reject) => {
    disconnect = reject;
  }));
  const client = new JobCtrlApiClient("http://synthetic.invalid", 1_000);
  const ports = buildTestPorts({ api: { reviseOutreachDraft: client.reviseOutreachDraft.bind(client) } });
  const onRevised = vi.fn();
  try {
    const view = renderWithProviders(
      <ReviseDraftForm threadId="thread-1" contactId="contact-1" initialBodyText="Synthetic original" onRevised={onRevised} />,
      { ports },
    );
    const input = view.getByRole("textbox", { name: "Edit message" });
    fireEvent.change(input, { target: { value: "Synthetic submitted A" } });
    fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "Synthetic newer B" } });
    disconnect(new TypeError("Synthetic connection lost"));
    const unconfirmed = await view.findByRole("group", { name: "Unconfirmed revision" });
    expect(unconfirmed).toHaveTextContent("Synthetic submitted A");
    expect(unconfirmed).toHaveTextContent("may have been saved");
    expect(input).toHaveValue("Synthetic newer B");
    expect(view.getByRole("button", { name: "Revise draft" })).toBeDisabled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(onRevised).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});
