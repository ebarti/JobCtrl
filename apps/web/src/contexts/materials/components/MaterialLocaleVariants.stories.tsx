import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { LocaleHistory, LocaleVariant } from "../hooks/useGenerateMaterialsMutation.js";
import { MaterialLocalePanel } from "./MaterialLocaleVariants.js";

export function sampleLocaleVariant(accepted = false): LocaleVariant {
  return {
    contract: "material-locale-v1", tenantId: "local", jobId: "90000000-0000-4000-8000-000000000039", entityId: "synthetic-source-binding",
    authorityStatus: "recorded",
    source: { artifactId: "source-resume", generation: 1, kind: "tailored_resume", sha256: "a".repeat(64), text: "Synthetic Name · Historical Title · 2020\nDelivered 25%" },
    sourceLocale: "en", targetLocale: "es", profileVersion: 1, facts: [{ source_id: "fact", text: "Delivered 25%" }], protectedValues: ["Historical Title"],
    revisionId: "90000000-0000-4000-8000-000000000040", version: 1, createdAt: "2026-10-09T10:00:00Z", accepted,
    reviews: [], acceptanceHistory: [], exports: [], translationId: "a".repeat(64), verificationId: "b".repeat(64),
    provider: "synthetic", model: "structural-model", promptVersion: "material-locale-translation-v1", schemaVersion: "1",
    lines: [{ line_id: "source:1", text: "Delivered 25%", source: { source_id: "source:1", quote: "Delivered 25%", exact_values: ["25"] }, fact_ids: ["fact"] }], findings: [], verificationVerdict: "pass",
    text: "Synthetic Name · Historical Title · 2020\nDelivered 25%", textSha256: "c".repeat(64),
    verification: [{ line_id: "source:1", verdict: "pass", original: { source_id: "source:1", quote: "Delivered 25%", exact_values: [] }, translated: { source_id: "translated:source:1", quote: "Delivered 25%", exact_values: [] }, reason: "Explicit synthetic verdict" }],
  };
}
export function sampleLocaleHistory(accepted = false): LocaleHistory {
  return { supportedLocales: ["en", "es", "fr"], sources: [{ artifactId: "source-resume", generation: 1, kind: "tailored_resume" }], profileVersion: 1, variants: [sampleLocaleVariant(accepted)] };
}
const meta = { title: "Contexts/Materials/MaterialLocaleVariants", component: MaterialLocalePanel, includeStories: ["ReviewPending", "Accepted", "UnresolvedCredential", "NoSource"], args: { history: sampleLocaleHistory(), pending: false, onRequest: fn(), onExport: fn() } } satisfies Meta<typeof MaterialLocalePanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReviewPending: Story = { play: async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("button", { name: "Accept locale revision" })).toBeDisabled();
  await userEvent.click(canvas.getByRole("button", { name: "Approve terminology" }));
  await expect(args.onRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "review", dimension: "terminology", expectedVersion: 1 }));
} };
export const Accepted: Story = { args: { history: sampleLocaleHistory(true) }, play: async ({ canvasElement, args }) => {
  await userEvent.click(within(canvasElement).getByRole("button", { name: "Export DOCX" }));
  await expect(args.onExport).toHaveBeenCalledWith(expect.objectContaining({ operation: "export", format: "docx" }));
} };
export const UnresolvedCredential: Story = { args: { history: { ...sampleLocaleHistory(), variants: [{ ...sampleLocaleVariant(), verificationVerdict: "fail", findings: [{ kind: "ambiguous_credential", line_id: "source:1", source: { source_id: "source:1", quote: "Delivered 25%", exact_values: [] }, detail: "Credential equivalence is unresolved; preserve original." }] }] } } };
export const NoSource: Story = { args: { history: { supportedLocales: ["en", "es"], sources: [], profileVersion: null, variants: [] } } };
