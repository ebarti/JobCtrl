import { test, expect } from "@playwright/test";

test("Runs view: lists workflow runs and exposes a Temporal Web UI deep-link per row", async ({
  page,
}) => {
  await page.goto("/runs");

  // The seed inserts one apply_run_projections row (`qa-run-1` for the
  // GitLab platform-director job). The view normalizes the legacy
  // `finished` status to the canonical WorkflowRunStatus `succeeded`.
  const card = page.getByRole("heading", { name: /Workflow runs/i });
  await expect(card).toBeVisible({ timeout: 30_000 });

  const link = page.getByRole("link", {
    name: /Open workflow qa-run-1 in Temporal Web UI/i,
  });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(link).toHaveAttribute(
    "href",
    "http://127.0.0.1:8233/namespaces/default/workflows/qa-run-1",
  );
  await expect(link).toHaveAttribute("target", "_blank");
  const rel = await link.getAttribute("rel");
  expect(rel ?? "").toContain("noopener");

  // The job title hydrated from the seed must appear in the row.
  await expect(page.getByText(/Director of Platform Engineering/i)).toBeVisible();
});
