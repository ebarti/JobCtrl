import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  MaterialLocaleMutation,
  MaterialLocaleState,
} from "../hooks/useResumeTemplateMaterialMutations.js";
import { useMaterialLocaleVariantMutation } from "../hooks/useResumeTemplateMaterialMutations.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { invalidationRouter } from "../../operations/invalidation-router.js";
import { eventByType } from "../../../test/fixtures/events.js";
import { makeJobDetail } from "../../../test/fixtures/projections.js";
import {
  buildProviderHarness,
  renderHookWithProviders,
} from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { MaterialLocaleVariants } from "./MaterialLocaleVariants.js";
import { localeStoryState } from "./MaterialLocaleVariants.stories.js";

const jobId = "90000000-0000-4000-8000-000000000055";
function setup(
  state = localeStoryState(),
  mutate = vi.fn(
    async (
      _job: string,
      _body: MaterialLocaleMutation,
    ): Promise<MaterialLocaleState> => state,
  ),
  demo = false,
) {
  const detail = { ...makeJobDetail(), localeVariants: state };
  const ports = buildTestPorts({
    api: {
      job: vi.fn(async () => detail),
      mutateMaterialLocaleVariants: mutate,
    },
  });
  const harness = buildProviderHarness({
    ports: {
      ...ports,
      session: {
        getSession: () => ports.session.getSession(),
        newRequestId: () => "90000000-0000-4000-8000-000000000104",
      },
      featureFlags: {
        get: <T,>(key: string, fallback: T) =>
          (key === "demoMode" ? demo : fallback) as T,
      },
    },
  });
  harness.queryClient.setQueryData(
    jobsKeys.detail(LOCAL_TENANT, jobId),
    detail,
  );
  return {
    ...harness,
    mutate,
    ...render(<MaterialLocaleVariants jobId={jobId} />, {
      wrapper: harness.Wrapper,
    }),
  };
}

describe("reviewed locale variants", () => {
  it("keeps the last loaded accepted preview and explains unavailable recorded authority", async () => {
    const fixture = setup(localeStoryState("accepted"));
    const unavailable = {
      ...makeJobDetail(),
      localeVariantsError: "locale_history_unavailable" as const,
    };
    fixture.ports.api.job = vi.fn(async () => unavailable);
    await act(async () => {
      await fixture.queryClient.invalidateQueries({
        queryKey: jobsKeys.detail(LOCAL_TENANT, jobId),
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "recorded authority could not be loaded",
    );
    expect(screen.getByText(/Status: accepted/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Generate locale variant" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeDisabled();
    expect(
      screen.queryByText("No recorded locale variants."),
    ).not.toBeInTheDocument();
  });

  it("shows original, literal source joins, unresolved credentials and separate review boundaries", async () => {
    setup();
    await userEvent.click(screen.getByText("Original accepted material"));
    expect(screen.getAllByText(/Historical title/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/No credential equivalence asserted/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Accept terminology" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Accept formatting" }),
    ).toBeEnabled();
    await userEvent.click(screen.getByText("Source and translation authority"));
    expect(
      screen.getByText(/Source artifact owned-source/),
    ).toBeInTheDocument();
  });

  it("preserves the entered locale draft and accepted preview when generation fails", async () => {
    const mutate = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    setup(localeStoryState("accepted"), mutate);
    await userEvent.type(
      screen.getByRole("textbox", { name: "Source locale" }),
      "en",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Target locale" }),
      "fr",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate locale variant" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "provider unavailable",
    );
    expect(screen.getByRole("textbox", { name: "Target locale" })).toHaveValue(
      "fr",
    );
    expect(screen.getByText(/Status: accepted/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export DOCX" })).toBeEnabled();
  });

  it("dispatches independent reviews and each accepted export through the Materials hook", async () => {
    const state = localeStoryState();
    const fixture = setup(state);
    await userEvent.click(
      screen.getByRole("button", { name: "Accept terminology" }),
    );
    await waitFor(() =>
      expect(fixture.mutate).toHaveBeenCalledWith(
        jobId,
        expect.objectContaining({
          operation: "review",
          review_kind: "terminology",
          expected_variant_revision: 1,
        }),
      ),
    );
    fixture.unmount();
    const accepted = setup(localeStoryState("accepted"));
    for (const format of ["TEXT", "HTML", "PDF", "DOCX"]) {
      await userEvent.click(
        screen.getByRole("button", { name: `Export ${format}` }),
      );
      await waitFor(() =>
        expect(accepted.mutate).toHaveBeenCalledWith(
          jobId,
          expect.objectContaining({
            operation: "export",
            export_format: format.toLowerCase(),
            expected_variant_revision: 3,
          }),
        ),
      );
    }
  });

  it("makes demo generation unavailable and prevents accepting failed semantic gates", () => {
    const failed = localeStoryState();
    failed.variants[0]!.gate_passed = false;
    const fixture = setup(failed);
    expect(
      screen.getByRole("button", { name: "Accept terminology" }),
    ).toBeDisabled();
    fixture.unmount();
    const demo = setup(localeStoryState(), undefined, true);
    expect(screen.getByRole("status")).toHaveTextContent(
      "unavailable in the offline demo",
    );
    expect(
      screen.getByRole("button", { name: "Generate locale variant" }),
    ).toBeDisabled();
    expect(demo.mutate).not.toHaveBeenCalled();
  });

  it("keeps stale accepted history visible while blocking new review and export", () => {
    const state = localeStoryState("accepted");
    state.variants[0]!.stale_reasons = ["profile changed"];
    setup(state);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Inputs changed: profile changed",
    );
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeDisabled();
    expect(screen.getByText(/Status: accepted/)).toBeInTheDocument();
  });

  it("reloads locale source fences after an existing Materials source-change event", async () => {
    const fixture = setup(localeStoryState("accepted"));
    const updated = {
      ...makeJobDetail(),
      localeVariants: localeStoryState("accepted"),
    };
    updated.localeVariants.variants[0]!.stale_reasons = [
      "accepted source changed",
    ];
    fixture.ports.api.job = vi.fn(async () => updated);
    await act(async () => {
      invalidationRouter.handle(
        {
          ...eventByType.ResumeApproved,
          payload: { ...eventByType.ResumeApproved.payload, jobId },
        },
        fixture.queryClient,
      );
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "accepted source changed",
      ),
    );
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeDisabled();
    expect(screen.getByText(/Status: accepted/)).toBeInTheDocument();
  });
});

describe("locale mutation reconciliation", () => {
  it("preserves canonical profile staleness on a reload at the same locale revision", async () => {
    let resolve!: (state: MaterialLocaleState) => void;
    const mutate = vi.fn(
      () =>
        new Promise<MaterialLocaleState>((yes) => {
          resolve = yes;
        }),
    );
    const harness = renderHookWithProviders(
      () => useMaterialLocaleVariantMutation(),
      {
        ports: buildTestPorts({
          api: { mutateMaterialLocaleVariants: mutate },
        }),
      },
    );
    const key = jobsKeys.detail(LOCAL_TENANT, jobId);
    const initial = { ...makeJobDetail(), localeVariants: localeStoryState() };
    harness.queryClient.setQueryData(key, initial);
    await act(async () => {
      harness.result.current.mutate({
        jobId,
        body: {
          operation: "review",
          variant_id: initial.localeVariants.variants[0]!.variant_id,
          expected_revision: 1,
          expected_variant_revision: 1,
          review_kind: "terminology",
          decision: "accepted",
        },
      });
    });
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    const canonical = {
      ...makeJobDetail(),
      localeVariants: localeStoryState("accepted"),
    };
    canonical.localeVariants.variants[0]!.stale_reasons = ["profile changed"];
    harness.queryClient.setQueryData(key, canonical);
    await act(async () => {
      resolve(localeStoryState("accepted"));
    });
    await waitFor(() => expect(harness.result.current.isPending).toBe(false));
    expect(harness.queryClient.getQueryData(key)).toEqual(canonical);
  });

  it.each(["success", "failure"] as const)(
    "preserves a newer reload during delayed %s",
    async (outcome) => {
      let resolve!: (state: MaterialLocaleState) => void;
      let reject!: (error: Error) => void;
      const mutate = vi.fn(
        () =>
          new Promise<MaterialLocaleState>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const harness = renderHookWithProviders(
        () => useMaterialLocaleVariantMutation(),
        {
          ports: buildTestPorts({
            api: { mutateMaterialLocaleVariants: mutate },
          }),
        },
      );
      const key = jobsKeys.detail(LOCAL_TENANT, jobId);
      const initial = {
        ...makeJobDetail(),
        localeVariants: localeStoryState(),
      };
      harness.queryClient.setQueryData(key, initial);
      const body: MaterialLocaleMutation = {
        operation: "review",
        variant_id: initial.localeVariants!.variants[0]!.variant_id,
        expected_revision: 1,
        expected_variant_revision: 1,
        review_kind: "terminology",
        decision: "accepted",
      };
      await act(async () => {
        harness.result.current.mutate({ jobId, body });
      });
      await waitFor(() => expect(mutate).toHaveBeenCalled());
      expect(
        harness.queryClient.getQueryData<typeof initial>(key)?.localeVariants
          ?.variants[0]?.terminology_review,
      ).toBe("accepted");
      const newer = {
        ...makeJobDetail(),
        localeVariants: { ...localeStoryState("accepted"), revision: 10 },
      };
      harness.queryClient.setQueryData(key, newer);
      await act(async () => {
        if (outcome === "success") resolve(localeStoryState("accepted"));
        else reject(new Error("offline"));
      });
      await waitFor(() => expect(harness.result.current.isPending).toBe(false));
      expect(harness.queryClient.getQueryData(key)).toEqual(newer);
    },
  );

  it("rolls back only its own optimistic review, retaining accepted bytes and artifacts", async () => {
    const mutate = vi.fn(async () => {
      throw new Error("failure");
    });
    const harness = renderHookWithProviders(
      () => useMaterialLocaleVariantMutation(),
      {
        ports: buildTestPorts({
          api: { mutateMaterialLocaleVariants: mutate },
        }),
      },
    );
    const key = jobsKeys.detail(LOCAL_TENANT, jobId);
    const initial = { ...makeJobDetail(), localeVariants: localeStoryState() };
    harness.queryClient.setQueryData(key, initial);
    await act(async () => {
      await expect(
        harness.result.current.mutateAsync({
          jobId,
          body: {
            operation: "review",
            variant_id: initial.localeVariants!.variants[0]!.variant_id,
            expected_revision: 1,
            expected_variant_revision: 1,
            review_kind: "formatting",
            decision: "accepted",
          },
        }),
      ).rejects.toThrow();
    });
    const current = harness.queryClient.getQueryData<typeof initial>(key)!;
    expect(current.localeVariants).toEqual(initial.localeVariants);
    expect(current.artifacts).toEqual(initial.artifacts);
  });
});
