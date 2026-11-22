import type { APIRequestContext } from "@playwright/test";
import {
  expect,
  json,
  modelCall,
  type ApplicationStack,
} from "../harness/fixtures.js";
import { catalogMatching, typedExtraction } from "./requirements-data.js";
import { qualificationBatchDecision } from "./qualification-data.js";

/** Authored synthetic data submitted through the public Profile action. These
 * are not persisted model outputs, labels, or an internal repository seed. */
export const baseline = {
  personal: {
    full_name: "Synthetic Candidate",
    email: "candidate@example.com",
    city: "Synthetic City",
  },
  resume: {
    executive_profile: {
      baseline_text: "Engineer who documents service ownership and recovery.",
    },
    experience_entries: [
      {
        id: "role-current",
        title: "Reliability Engineer",
        company: "Synthetic Example Company",
        date_range: "2023–2026",
        location: "Remote",
        summary: "Maintained application services.",
        bullets: [
          "Implemented a durable workflow service and documented its recovery process.",
          "Established explicit review ownership for operational changes.",
        ],
        achievement_evidence: [],
      },
      {
        id: "role-earlier",
        title: "Software Engineer",
        company: "Synthetic Earlier Company",
        date_range: "2020–2023",
        location: "Synthetic City",
        summary: "Built data tools.",
        bullets: [
          "Built a versioned data import tool with a visible recovery record.",
        ],
        achievement_evidence: [],
      },
    ],
    education_entries: [
      {
        id: "education",
        degree: "Synthetic Engineering Degree",
        institution: "Synthetic University",
        date: "2020",
      },
    ],
    skill_categories: [
      {
        id: "skills",
        label: "Engineering",
        items: ["Python", "SQLite", "Temporal"],
      },
    ],
    language_entries: [] as { id: string; language: string; proficiency: string }[],
    tailoring_rules: {},
  },
};

export type Variant = {
  variant_id: string;
  revision: number;
  achievement_id: string;
  text: string;
  status: string;
  approval_id: string | null;
  source_refs: { source_id: string; revision: number }[];
};
export type Library = {
  profileVersion: number;
  roles: {
    role_id: string;
    achievements: {
      achievement_id: string;
      baseline_variant_id: string;
      source_refs: { source_id: string; revision: number }[];
    }[];
  }[];
  variants: Variant[];
};
export type Profile = { profileVersion: number; profile: typeof baseline };
export type Posting = { job_id: string; revision: number };
export type ResumeRevision = {
  revision_id: string;
  mode: string;
  document: {
    personal: { full_name: string };
    summary: string;
    languages?: { id: string; language: string; proficiency: string }[];
    experience: {
      id: string;
      title: string;
      bullets: { text: string; id: string; variant_id: string }[];
    }[];
  };
  selected_variants: Variant[];
  mechanical: { status: string; failures: string[] };
  review: { status: string; determination_id?: string };
  renders: {
    artifact_id: string;
    pdf_path?: string;
    sha256?: string;
    layout_conflicts: unknown[];
  }[];
  render_attempts: { status: string }[];
  coverage_manifest: { status: string; requirements: unknown[] };
};
export type Resume = {
  resume_id: string;
  version: number;
  current_revision: string;
  accepted_revision_id: string | null;
  revisions: ResumeRevision[];
  acceptances: {
    acceptance_id: string;
    review_status: string;
    review_override: boolean;
    pdf: unknown;
  }[];
};
export const current = (resume: Resume) =>
  resume.revisions.find((row) => row.revision_id === resume.current_revision)!;

export async function createBaseline(
  api: APIRequestContext,
  authoredProfile: Record<string, unknown> = baseline,
) {
  const profile = await json<Profile>(api, "patch", "/v1/profile", {
    expectedProfileVersion: null,
    profile: authoredProfile,
  });
  const library = await json<Library>(api, "get", "/v1/profile/wording");
  return { profile, library };
}

export async function createPosting(api: APIRequestContext, slug = "baseline") {
  return json<Posting>(api, "post", "/v1/jobs/capture", {
    url: `https://example.com/jobs/${slug}`,
    title: "Synthetic Reliability Engineer",
    company: "Synthetic Hiring Company",
    description: "Implement and maintain durable workflow recovery.",
    location: "Remote",
  });
}

export async function getResume(api: APIRequestContext, resumeId: string) {
  return (await json<{ resume: Resume }>(api, "get", `/v1/resumes/${resumeId}`))
    .resume;
}

export async function composeBaseline(
  api: APIRequestContext,
  jobId: string,
  profileVersion: number,
) {
  return (
    await json<{ resume: Resume }>(api, "post", "/v1/resumes", {
      job_id: jobId,
      expected_profile_revision: profileVersion,
      profile_id: "default",
      mode: "baseline_copy",
    })
  ).resume;
}

export async function acceptBaseline(
  api: APIRequestContext,
  jobId: string,
  profileVersion: number,
) {
  let resume = await composeBaseline(api, jobId, profileVersion);
  resume = (
    await json<{ resume: Resume }>(
      api,
      "post",
      `/v1/resumes/${resume.resume_id}/render`,
      { expected_version: resume.version },
    )
  ).resume;
  return (
    await json<{ resume: Resume }>(
      api,
      "post",
      `/v1/resumes/${resume.resume_id}/accept`,
      { expected_version: resume.version, override_review: false },
    )
  ).resume;
}

export async function qualifyPosting(
  api: APIRequestContext,
  app: ApplicationStack,
  posting: Posting,
  library: Library,
) {
  const extracting = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: { expected_posting_revision: posting.revision, expected_revision: 0 },
  });
  const extraction = await modelCall(app, "requirements.extract");
  const source = (
    extraction.body["sources"] as { source_id: string; text: string }[]
  )[0]!;
  extraction.reply(typedExtraction(extraction, { requirements: [{
    localId: "recovery", text: source.text, definition: "Implement durable workflow recovery",
  }] }));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, { recovery: { verdict: "new" } }));
  const extracted = await extracting;
  expect(extracted.status(), await extracted.text()).toBe(200);
  const assessing = api.post(`/v1/jobs/${posting.job_id}/fit/assess`, {
    data: {
      expected_revision: 0,
      prepare_wording: false,
      prepare_coverage: false,
    },
  });
  const qualification = await modelCall(app, "fit.qualification-batch");
  const achievement = library.roles[0]!.achievements[0]!;
  const sourceId = `evidence:${achievement.source_refs[0]!.source_id}`;
  qualification.reply(qualificationBatchDecision(qualification, () => ({
    achievementIds: [achievement.achievement_id], evidenceSourceIds: [sourceId], keywords: ["durable workflows"],
  })));
  const assessed = await assessing;
  expect(assessed.status(), await assessed.text()).toBe(200);
  expect((await assessed.json()).score.score).toBe(10);
}
