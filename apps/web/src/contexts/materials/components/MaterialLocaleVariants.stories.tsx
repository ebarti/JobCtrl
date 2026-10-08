import type { Meta, StoryObj } from "@storybook/react-vite";
import type { MaterialLocaleState } from "../hooks/useResumeTemplateMaterialMutations.js";
import { MaterialLocaleVariants } from "./MaterialLocaleVariants.js";

// Generated structural source mappings, not recorded model-output replay.
export function localeStoryState(
  status: "candidate" | "accepted" | "refused" = "candidate",
): MaterialLocaleState {
  const text = "Synthetic Person\nHistorical title\nLiteral achievement 42";
  const id = "90000000-0000-4000-8000-000000000103";
  const hash = "a".repeat(64);
  const lines = text
    .split("\n")
    .map((line, index) => ({
      line_id: `source:${index}`,
      text: line,
      source: { source_id: `source:${index}`, quote: line, exact_values: [] },
    }));
  return {
    revision: status === "accepted" ? 3 : 1,
    failures: [],
    variants: [
      {
        variant_id: id,
        semantic_entity_id: `material-locale:${hash}`,
        request_id: "90000000-0000-4000-8000-000000000104",
        tenant_id: "local",
        job_id: "90000000-0000-4000-8000-000000000055",
        kind: "resume",
        source_locale: "en",
        target_locale: "es",
        artifact_id: "owned-source",
        source_status: "approved",
        source_created_at: "2026-10-08T00:00:00Z",
        artifact_type: "tailored_resume",
        generation: 1,
        sha256: hash,
        verification_id: hash,
        text,
        profile_version: 1,
        profile_json: "{}",
        profile_sha256: hash,
        locale_generation: 1,
        revision: status === "accepted" ? 3 : 1,
        created_at: "2026-10-08T00:00:00Z",
        status,
        gate_passed: status !== "refused",
        terminology_review: status === "accepted" ? "accepted" : "pending",
        formatting_review: status === "accepted" ? "accepted" : "pending",
        reviews: [],
        exports: [],
        lines: status === "refused" ? [] : lines,
        concerns: [
          {
            kind:
              status === "refused"
                ? "unsupported_locale"
                : "ambiguous_credential",
            source: lines[1]!.source,
            explanation:
              "Original wording retained. No credential equivalence asserted.",
          },
        ],
        determinations: [
          "material_locale_translation",
          "material_locale_terminology",
          "claim_verification",
          "artifact_quality",
        ].map((kind, index) => ({
          determination_id: String(index + 1).repeat(64),
          tenant_id: "local",
          entity_id: `material-locale:${hash}`,
          kind,
          schema_version: "1",
          prompt_version: "structural-story",
          provider: "structural",
          model: "structural",
          lane: "tailoring",
          input_fingerprint: String(index + 1).repeat(64),
          created_at: "2026-10-08T00:00:00Z",
          result: {},
        })),
        ...(status === "accepted"
          ? {
              accepted_at: "2026-10-08T00:00:00Z",
              accepted_revision: 3,
              document_sha256: hash,
            }
          : {}),
      },
    ],
  };
}
const meta = {
  title: "Contexts/Materials/MaterialLocaleVariants",
  component: MaterialLocaleVariants,
  excludeStories: ["localeStoryState"],
} satisfies Meta<typeof MaterialLocaleVariants>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Candidate: Story = {
  args: {
    jobId: "90000000-0000-4000-8000-000000000055",
    state: localeStoryState(),
  },
};
export const AcceptedHistory: Story = {
  args: { ...Candidate.args, state: localeStoryState("accepted") },
};
export const UnsupportedLocale: Story = {
  args: { ...Candidate.args, state: localeStoryState("refused") },
};
export const StaleInput: Story = {
  args: {
    ...Candidate.args,
    state: {
      ...localeStoryState("accepted"),
      variants: localeStoryState("accepted").variants.map((variant) => ({
        ...variant,
        stale_reasons: ["profile changed"],
      })),
    },
  },
};
