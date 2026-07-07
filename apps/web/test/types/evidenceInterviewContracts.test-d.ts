import type {
  EvidenceMapEntry,
  EvidenceUsageRef,
  InterviewPrep,
  InterviewPrepItem,
  InterviewPrepStatus,
} from "@jobctrl/contracts";
import { expectTypeOf, test } from "vitest";

test("evidence-map contracts are exported with camelCase read-model fields", () => {
  expectTypeOf<EvidenceUsageRef>().toMatchTypeOf<{
    kind: "resume_bullet" | "requirement_fit" | "skill_coverage";
    jobKey: string;
    artifactId: string | null;
    bulletId: string | null;
    requirementId: string | null;
  }>();

  expectTypeOf<EvidenceMapEntry>().toMatchTypeOf<{
    entryId: string;
    kind: "achievement_evidence" | "skill";
    evidenceId: string | null;
    skillId: string | null;
    resumeUsages: EvidenceUsageRef[];
    requirementUsages: EvidenceUsageRef[];
  }>();
});

test("interview-prep contracts expose generated prep only, never live session state", () => {
  expectTypeOf<InterviewPrepItem>().toMatchTypeOf<{
    kind: "theme" | "star_draft" | "gap_drill" | "company_note";
    evidenceIds: string[];
    requirementIds: string[];
    generatedText: string;
  }>();

  expectTypeOf<InterviewPrep>().toMatchTypeOf<{
    jobKey: string;
    generation: number;
    status: InterviewPrepStatus;
    items: InterviewPrepItem[];
  }>();

  expectTypeOf<InterviewPrepStatus>().not.toEqualTypeOf<"live" | "in_session">();
});
