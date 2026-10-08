import type { Meta, StoryObj } from "@storybook/react-vite";
import type { LocaleVariant } from "../hooks/useResumeTemplateMaterialMutations.js";
import { LocaleVariantCard } from "./MaterialLocaleVariants.js";

// Mechanical view state; no language labels or replayed model evaluations.
export function makeLocaleVariant(
  status: LocaleVariant["status"] = "candidate",
): LocaleVariant {
  const line = {
    line_id: "source:0",
    text: "Synthetic historical title",
    protected: ["Synthetic historical title"],
  };
  return {
    variantId: "locale:synthetic",
    revision: 1,
    status,
    eligible: true,
    createdAt: "2026-10-08T12:00:00Z",
    binding: {
      artifactId: "synthetic-source",
      jobId: "90000000-0000-4000-8000-000000000039",
      generation: 1,
      kind: "resume",
      sourceHash: "a".repeat(64),
      sourceMetadataHash: "b".repeat(64),
      sourceAcceptance: { status: "approved", artifactCreatedAt: "2026-10-08" },
      profileVersion: 1,
      profileHash: "c".repeat(64),
      sourceLocale: "en",
      targetLocale: "es",
      facts: [{ source_id: "fact", text: "Synthetic fact" }],
      lines: [line],
      identity: "locale:synthetic",
    },
    lines: [
      {
        line_id: line.line_id,
        text: line.text,
        source: { source_id: line.line_id, quote: line.text, exact_values: [] },
      },
    ],
    issues: [],
    determinations: [],
    semanticReview: {
      verdict: "pass",
      terminology: "pass",
      formatting: "pass",
      issues: [],
      rationale: "Structural UI state",
    },
    reviews: [],
    exports:
      status === "accepted"
        ? Object.fromEntries(
            ["text", "html", "pdf", "docx"].map((format) => [
              format,
              {
                path: `/synthetic/document.${format}`,
                hash: "a".repeat(64),
                documentHash: "d".repeat(64),
                lineIds: [line.line_id],
              },
            ]),
          )
        : {},
  };
}

const meta = {
  title: "Contexts/Materials/Reviewed locale variants",
  component: LocaleVariantCard,
  args: {
    jobKey: "90000000-0000-4000-8000-000000000039",
    pending: false,
    onReview: () => {},
  },
} satisfies Meta<typeof LocaleVariantCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const IndependentReview: Story = {
  args: { variant: makeLocaleVariant() },
};
export const AcceptedDownloads: Story = {
  args: { variant: makeLocaleVariant("accepted") },
};
export const CredentialWarning: Story = {
  args: {
    variant: {
      ...makeLocaleVariant(),
      issues: [
        {
          line_id: "source:0",
          kind: "ambiguous_credential",
          citation: {
            source_id: "source:0",
            quote: "Synthetic historical title",
            exact_values: [],
          },
          explanation:
            "Original designation retained; no equivalence asserted.",
        },
      ],
    },
  },
};
export const BlockedReview: Story = {
  args: {
    variant: {
      ...makeLocaleVariant(),
      eligible: false,
      semanticReview: {
        verdict: "fail",
        terminology: "fail",
        formatting: "pass",
        issues: [],
        rationale: "Structural failed state",
      },
    },
  },
};
