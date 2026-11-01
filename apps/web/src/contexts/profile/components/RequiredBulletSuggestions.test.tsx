import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../../demo/ports.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { RequiredBulletSuggestions } from "./RequiredBulletSuggestions.js";

const response = {
  ok: true as const,
  profileVersion: 3,
  suggestions: [{
    id: "source:0:grammar",
    kind: "grammar" as const,
    originalText: "  Saved   bullet  ",
    proposedText: "Saved bullet",
    canApply: true,
    guidance: "Collapse whitespace only.",
    source: {
      sourceId: "profile:v3:experience[0]:bullet[0]",
      identityKind: "snapshot_bullet" as const,
      excerpt: "  Saved   bullet  ",
      fieldPath: "profile.resume.experience_entries[0].bullets[0]",
      experienceId: "exp-1",
      experienceTitle: "Engineer",
      experienceCompany: "Example",
      bulletIndex: 0,
      requiredBulletIndex: 0,
    },
  }],
  strategy: "model_v1" as const,
  modelUsed: true as const,
  truncated: false,
};

describe("RequiredBulletSuggestions", () => {
  it("does not report a clean inspection when the saved source budget is exceeded", async () => {
    const user = userEvent.setup();
    const requiredBulletSuggestions = vi.fn(async () => ({
      ...response,
      suggestions: [],
      truncated: true,
    }));
    renderWithProviders(
      <RequiredBulletSuggestions isDraftClean profileVersion={3} resetToken={0} onAccept={vi.fn()} />,
      { ports: buildTestPorts({ api: { requiredBulletSuggestions } }) },
    );

    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    expect(await screen.findByText(/Inspection is incomplete: saved Required sources exceed/i)).toBeInTheDocument();
    expect(screen.queryByText(/No deterministic coaching suggestions were found/i)).not.toBeInTheDocument();
  });

  it("warns that a nonempty truncated inspection may omit overlong sources", async () => {
    const user = userEvent.setup();
    const requiredBulletSuggestions = vi.fn(async () => ({ ...response, truncated: true }));
    renderWithProviders(
      <RequiredBulletSuggestions isDraftClean profileVersion={3} resetToken={0} onAccept={vi.fn()} />,
      { ports: buildTestPorts({ api: { requiredBulletSuggestions } }) },
    );

    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    expect(await screen.findByText("Proposed text: “Saved bullet”")).toBeInTheDocument();
    expect(screen.getByText(/Inspection is incomplete\. These suggestions cover only part/i))
      .toHaveTextContent(/other sources may exceed a safe limit or the response cap/);
    expect(screen.getByText(/Inspection is incomplete\. These suggestions cover only part/i))
      .toHaveTextContent(/edit omitted bullets manually/);
    expect(screen.queryByText(/Showing the first 12/i)).not.toBeInTheDocument();
  });

  it.each([
    { suggestions: [], truncated: false, status: "No coaching findings were returned." },
    { suggestions: [], truncated: true, status: /Inspection is incomplete: saved Required/ },
    { suggestions: response.suggestions, truncated: true, status: /Inspection is incomplete\. These suggestions/ },
  ])("replaces the previous review status after a complete refresh ($truncated)", async (previous) => {
    const user = userEvent.setup();
    const requiredBulletSuggestions = vi.fn()
      .mockResolvedValueOnce({ ...response, suggestions: previous.suggestions, truncated: previous.truncated })
      .mockResolvedValueOnce(response);
    renderWithProviders(
      <RequiredBulletSuggestions isDraftClean profileVersion={3} resetToken={0} onAccept={vi.fn()} />,
      { ports: buildTestPorts({ api: { requiredBulletSuggestions } }) },
    );
    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    expect(await screen.findByText(previous.status)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    await waitFor(() => expect(screen.queryByText(previous.status)).not.toBeInTheDocument());
    expect(screen.getByText("Collapse whitespace only.")).toBeInTheDocument();
  });

  it("disables coaching in the demo and provides the supported local installation path", async () => {
    const user = userEvent.setup();
    const requiredBulletSuggestions = vi.fn();
    const ports = buildTestPorts({ api: { requiredBulletSuggestions } });
    ports.featureFlags = new DemoFeatureFlagAdapter();
    renderWithProviders(
      <RequiredBulletSuggestions isDraftClean profileVersion={3} resetToken={0} onAccept={vi.fn()} />,
      { ports },
    );
    const inspect = screen.getByRole("button", { name: "Inspect Required bullets" });
    expect(inspect).toBeDisabled();
    await user.click(inspect);
    expect(requiredBulletSuggestions).not.toHaveBeenCalled();
    expect(screen.getByText(/available in the local JobCtrl app with a configured LLM provider/)).toBeInTheDocument();
    expect(screen.getByText(/edit the synthetic profile manually/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Install JobCtrl" })).toHaveAttribute("href", "https://jobctrl.dev/user/getting-started");
    expect(screen.queryByText(/Your configured provider receives/)).not.toBeInTheDocument();
  });

  it("rejects an individual replacement without mutating the saved profile", async () => {
    const user = userEvent.setup();
    const requiredBulletSuggestions = vi.fn(async () => response);
    const onAccept = vi.fn(async () => true);
    renderWithProviders(
      <RequiredBulletSuggestions
        isDraftClean
        profileVersion={3}
        resetToken={0}
        onAccept={onAccept}
      />,
      { ports: buildTestPorts({ api: { requiredBulletSuggestions } }) },
    );

    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    expect(await screen.findByText("Proposed text: “Saved bullet”")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(screen.queryByText("Proposed text: “Saved bullet”")).not.toBeInTheDocument();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("drops a delayed generation response after the local draft changes", async () => {
    const user = userEvent.setup();
    let resolveGeneration!: (value: typeof response) => void;
    const requiredBulletSuggestions = vi.fn(() => new Promise<typeof response>((resolve) => {
      resolveGeneration = resolve;
    }));
    const onAccept = vi.fn(async () => true);
    const view = renderWithProviders(
      <RequiredBulletSuggestions
        isDraftClean
        profileVersion={3}
        resetToken={0}
        onAccept={onAccept}
      />,
      { ports: buildTestPorts({ api: { requiredBulletSuggestions } }) },
    );

    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    view.rerender(
      <RequiredBulletSuggestions
        isDraftClean={false}
        profileVersion={3}
        resetToken={0}
        onAccept={onAccept}
      />,
    );
    await act(async () => resolveGeneration(response));

    await waitFor(() => expect(screen.queryByText("Proposed text: “Saved bullet”")).not.toBeInTheDocument());
    expect(screen.getByText(/Save or discard local edits/i)).toBeInTheDocument();
  });

  it("drops a delayed response from an older saved version", async () => {
    const user = userEvent.setup();
    let resolveGeneration!: (value: typeof response) => void;
    const requiredBulletSuggestions = vi.fn(() => new Promise<typeof response>((resolve) => {
      resolveGeneration = resolve;
    }));
    const onAccept = vi.fn(async () => true);
    const view = renderWithProviders(
      <RequiredBulletSuggestions isDraftClean profileVersion={3} resetToken={0} onAccept={onAccept} />,
      { ports: buildTestPorts({ api: { requiredBulletSuggestions } }) },
    );

    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    view.rerender(
      <RequiredBulletSuggestions isDraftClean profileVersion={4} resetToken={1} onAccept={onAccept} />,
    );
    await act(async () => resolveGeneration(response));

    expect(screen.queryByText("Proposed text: “Saved bullet”")).not.toBeInTheDocument();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("preserves the last reviewed findings when a model refresh fails", async () => {
    const user = userEvent.setup();
    const requiredBulletSuggestions = vi.fn()
      .mockResolvedValueOnce({ ...response, truncated: true })
      .mockRejectedValueOnce(new Error("The coaching provider is unavailable"));
    renderWithProviders(
      <RequiredBulletSuggestions isDraftClean profileVersion={3} resetToken={0} onAccept={vi.fn()} />,
      { ports: buildTestPorts({ api: { requiredBulletSuggestions } }) },
    );
    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    expect(await screen.findByText("Collapse whitespace only.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    expect(await screen.findByText("The coaching provider is unavailable")).toBeInTheDocument();
    expect(screen.getByText("Collapse whitespace only.")).toBeInTheDocument();
    expect(screen.getByText(/Inspection is incomplete\. These suggestions/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
  });

  it("keeps the manual path open after a failed inspection and allows retry", async () => {
    const user = userEvent.setup();
    const requiredBulletSuggestions = vi.fn()
      .mockRejectedValueOnce(new Error("Synthetic inspection failure"))
      .mockResolvedValueOnce(response);
    const onAccept = vi.fn(async () => true);
    renderWithProviders(
      <RequiredBulletSuggestions isDraftClean profileVersion={3} resetToken={0} onAccept={onAccept} />,
      { ports: buildTestPorts({ api: { requiredBulletSuggestions } }) },
    );

    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    expect(await screen.findByText("Synthetic inspection failure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect Required bullets" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    expect(await screen.findByText("Proposed text: “Saved bullet”")).toBeInTheDocument();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("keeps an individually reviewed suggestion after its save fails", async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn(async () => false);
    renderWithProviders(
      <RequiredBulletSuggestions isDraftClean profileVersion={3} resetToken={0} onAccept={onAccept} />,
      { ports: buildTestPorts({ api: { requiredBulletSuggestions: vi.fn(async () => response) } }) },
    );

    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    await user.click(await screen.findByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalledWith(response.suggestions[0], 3);
    expect(screen.getByText("Proposed text: “Saved bullet”")).toBeInTheDocument();
  });

  it("keeps the reviewed item when an in-flight accept temporarily dirties the form and then fails", async () => {
    const user = userEvent.setup();
    let failAccept!: (value: boolean) => void;
    const onAccept = vi.fn(() => new Promise<boolean>((resolve) => { failAccept = resolve; }));
    const ports = buildTestPorts({ api: { requiredBulletSuggestions: vi.fn(async () => response) } });
    const view = renderWithProviders(
      <RequiredBulletSuggestions isDraftClean profileVersion={3} resetToken={0} onAccept={onAccept} />,
      { ports },
    );

    await user.click(screen.getByRole("button", { name: "Inspect Required bullets" }));
    await user.click(await screen.findByRole("button", { name: "Accept" }));
    view.rerender(
      <RequiredBulletSuggestions isDraftClean={false} profileVersion={3} resetToken={1} onAccept={onAccept} />,
    );
    expect(screen.getByText("Proposed text: “Saved bullet”")).toBeInTheDocument();
    await act(async () => failAccept(false));
    view.rerender(
      <RequiredBulletSuggestions isDraftClean={false} profileVersion={3} resetToken={2} onAccept={onAccept} />,
    );
    expect(screen.getByText("Proposed text: “Saved bullet”")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    view.rerender(
      <RequiredBulletSuggestions isDraftClean profileVersion={3} resetToken={3} onAccept={onAccept} />,
    );
    expect(screen.getByText("Proposed text: “Saved bullet”")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });
});
