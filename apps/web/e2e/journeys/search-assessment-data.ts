import {
  expect,
  modelCall,
  type ApplicationStack,
  type ExternalCall,
} from "../harness/fixtures.js";
import type { Library } from "./core-data.js";
import { qualificationBatchDecision } from "./qualification-data.js";
import { catalogMatching, citeSources, modelSources, typedExtraction } from "./requirements-data.js";

type SearchPosting = {
  url: string;
  title: string;
  company: string;
  description: string;
};

/** Current journey choices bound to the actual request's sources and IDs.
 * These external responses never replace a JobCtrl action or infer meaning. */
export async function servePostingAssessment(
  app: ApplicationStack,
  library: Library,
  posting: SearchPosting,
  {
    kind = "matched",
    beforeFirstModel,
    beforeQualification,
    pageRequest,
    invalidEvidence = false,
  }: {
    kind?: "matched" | "missing";
    beforeFirstModel?: () => Promise<void>;
    beforeQualification?: (call: ExternalCall) => Promise<void>;
    pageRequest?: ExternalCall;
    invalidEvidence?: boolean;
  } = {},
) {
  const page = pageRequest ?? await app.external.next();
  expect(page.path).toBe("/posting-page");
  expect(page.body).toEqual({ url: posting.url });
  const structured = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    url: posting.url,
    title: posting.title,
    description: posting.description,
    hiringOrganization: { "@type": "Organization", name: posting.company },
    jobLocationType: "TELECOMMUTE",
  };
  page.respond({
    finalUrl: posting.url,
    html: `<html><body><h1>${posting.title}</h1><p>${posting.company}</p><p>${posting.description}</p><a href="${posting.url}/apply">Apply</a></body></html>`,
    jsonLd: [structured],
    statusCode: 200,
    evidenceComplete: true,
    visibilityVerified: true,
  });

  const interpretation = await modelCall(app, "page_interpretation");
  await beforeFirstModel?.();
  const field = (value: string) => ({ value, citations: citeSources(interpretation, ["rendered_page"]), rationale: "Explicit interpretation of this authored current page." });
  interpretation.reply({ availability: field("active"), page_kind: field("posting"), access_state: field("clear"), apply_control: field("available") });

  const extraction = await modelCall(app, "posting_extraction");
  const inventory = (extraction.body["context"] as {
    line_inventory: { source_id: string; lines: { line_id: string }[] }[];
  }).line_inventory.find((row) => row.source_id === "posting:0:description")!;
  expect(inventory).toBeTruthy();
  const copied = (id: string, value: string) => ({ value, citations: citeSources(extraction, [id]), rationale: "Copy the exact current captured field." });
  extraction.reply({
    title: copied("posting:0:title", posting.title),
    employer: copied("posting:0:employer", posting.company),
    description: { source_id: inventory.source_id, first_line_id: inventory.lines[0]!.line_id, last_line_id: inventory.lines.at(-1)!.line_id, rationale: "Select this complete authored description.", value: null, citations: [] },
    location: copied("posting:0:location", "Remote"),
    salary: { value: "", citations: [], rationale: "No salary was authored." },
    application_url: copied("link:0:url", `${posting.url}/apply`),
    source_origins: [],
  });
  const quality = await modelCall(app, "description_quality");
  quality.reply({ confidence: "high", citations: citeSources(quality, ["description"]), rationale: "This authored source describes one complete role." });
  return serveSavedAssessment(app, library, { kind, invalidEvidence, ...(beforeQualification ? { beforeQualification } : {}) });
}

export async function serveSavedAssessment(
  app: ApplicationStack,
  library: Library,
  { kind = "matched", invalidEvidence = false, beforeQualification, requirementId, qualificationExpected = true }: {
    kind?: "matched" | "missing";
    invalidEvidence?: boolean;
    beforeQualification?: (call: ExternalCall) => Promise<void>;
    requirementId?: string;
    qualificationExpected?: boolean;
  } = {},
) {
  const analysis = await modelCall(app, "jobs.role_analysis");
  const posting = modelSources(analysis)[0]!;
  const statement = { text: posting.text, citations: citeSources(analysis, [posting.source_id]), uncertainty: "Only this current authored posting is considered." };
  analysis.reply({ role_framing: statement, inferred_seniority: { value: "unknown", citations: citeSources(analysis, [posting.source_id]), rationale: "The supplied source does not establish a level." }, ideal_candidate_narrative: statement, keywords: [] });

  const extraction = await modelCall(app, "requirements.extract");
  const source = modelSources(extraction)[0]!;
  extraction.reply(typedExtraction(extraction, { requirements: [{ localId: "capability", text: source.text }] }));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, { capability: requirementId
    ? { verdict: "equivalent", requirementId }
    : { verdict: "new" } }));
  if (!qualificationExpected) return;

  const qualification = await modelCall(app, "fit.qualification-batch");
  await beforeQualification?.(qualification);
  if (qualification.closed) return;
  const achievement = library.roles[0]!.achievements[0]!;
  const choice = qualificationBatchDecision(qualification, () => kind === "matched"
    ? { achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] }
    : { kind: "missing" });
  if (invalidEvidence) choice.requirements[0]!.evidence = [{ source_id: "foreign-unowned-evidence", quote: "A source that was never supplied." }];
  qualification.reply(choice);
}
