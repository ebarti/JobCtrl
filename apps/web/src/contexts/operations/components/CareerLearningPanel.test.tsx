import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import {
  careerJobId,
  careerLearningFixture,
} from "../../../test/fixtures/career-learning.js";
import { makeJobsPage, sampleJob } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CareerLearningPanel } from "./CareerLearningPanel.js";

it("keeps the cohort, capability, aspirations and chosen activity distinct after a failed refresh", async () => {
  const user = userEvent.setup();
  const state = careerLearningFixture();
  state.cohorts[0]!.staleReasons = ["profile_changed"];
  state.milestones[0]!.staleReasons = ["profile_changed"];
  state.milestones[0]!.status = "completed";
  state.milestones[0]!.completionEvidence = "Owned completion report";
  const write = vi.fn(async () => {
    throw new Error("provider_error");
  });
  const view = renderWithProviders(<CareerLearningPanel />, {
    withRouter: true,
    ports: buildTestPorts({
      api: {
        careerLearning: async () => state,
        writeCareerLearning: write,
        jobs: async () => makeJobsPage([{ ...sampleJob, jobKey: careerJobId }]),
      },
    }),
  });
  await user.click(
    await screen.findByText("Selected-job demand and learning milestones"),
  );
  const cohort = await screen.findByRole("article", {
    name: "Comparison Owned cohort",
  });
  expect(within(cohort).getByText("Partial evidence")).toBeVisible();
  expect(within(cohort).getByText(/Explore a future role/)).toBeVisible();
  expect(within(cohort).getByText(/Profile changed/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Milestone chosen" }),
  ).toBeDisabled();
  await user.click(within(cohort).getByText("Posting source spans (1)"));
  expect(within(cohort).getByText("Saved posting requirement.")).toBeVisible();
  await user.click(
    within(cohort).getByText("Confirmed candidate evidence (1)"),
  );
  expect(within(cohort).getByText("Saved confirmed exercise.")).toBeVisible();
  expect(
    screen.getByRole("article", {
      name: "Milestone Document an incident exercise",
    }),
  ).toHaveTextContent("Completed");
  await user.click(
    screen.getByRole("button", { name: "Review and refresh this cohort" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Review selected cohort" }),
  );
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith({
      action: "preview",
      jobIds: [careerJobId],
    }),
  );
  expect(await screen.findByText("Change was not saved")).toBeVisible();
  expect(
    screen.getByRole("article", { name: "Comparison Owned cohort" }),
  ).toHaveTextContent("Partial evidence");
  expect(
    screen.getByLabelText(
      "Your aspirations (separate from demonstrated capability)",
    ),
  ).toHaveValue("Explore a future role");
  expect(await axe(view.container)).toHaveNoViolations();
});

it("requires cohort review before a model comparison and binds the reviewed fingerprint", async () => {
  const user = userEvent.setup();
  const state = careerLearningFixture();
  state.milestones = [];
  const preview = {
    ...state.cohorts[0]!.snapshot,
    fingerprint: "b".repeat(64),
  };
  const write = vi.fn(async () => ({ ...state, preview }));
  renderWithProviders(<CareerLearningPanel />, {
    withRouter: true,
    ports: buildTestPorts({
      api: {
        careerLearning: async () => state,
        writeCareerLearning: write,
        jobs: async () => makeJobsPage([{ ...sampleJob, jobKey: careerJobId }]),
      },
    }),
  });
  await user.click(
    await screen.findByText("Selected-job demand and learning milestones"),
  );
  await screen.findByRole("article", { name: "Comparison Owned cohort" });
  expect(
    screen.getByRole("button", { name: "Compare reviewed postings" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("checkbox"));
  await user.click(
    screen.getByRole("button", { name: "Review selected cohort" }),
  );
  expect(
    await screen.findByText("Review selected cohort before model comparison"),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Compare reviewed postings" }),
  );
  await waitFor(() =>
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "compare",
        expectedSnapshotFingerprint: "b".repeat(64),
        jobIds: [careerJobId],
      }),
    ),
  );
});
