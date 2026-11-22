import { expect, type ApplicationStack, type ExternalCall } from "../harness/fixtures.js";
import { citeSources, modelSources, typedExtraction } from "./requirements-data.js";

export const COMMON_DEMAND = "Maintain durable workflow recovery.";
export type CohortPosting = { job_key: string; url: string; title: string; company: string; description: string; location: string; unsupported?: boolean; demand?: string; foreignExtractionSource?: boolean };
export const posting = (index: number): CohortPosting => ({ job_key: `cohort-source-${index}`,
  url: `https://www.indeed.com/viewjob?jk=cohort-source-${index}`, title: `Synthetic Cohort Source ${index} Engineer`,
  company: "Synthetic Cohort Company", description: `${COMMON_DEMAND}\nDocument the distinct synthetic handover ${index}.`, location: "Madrid" });

/** Answer only the declared external boundaries for this authored cohort. The
 * exact source values identify a fixture posting; no semantic decision is
 * inferred from its prose. Each model choice is supplied explicitly below. */
export function respondProducer(call: ExternalCall, postings: CohortPosting[]) {
  if (call.path === "/posting-page") {
    const row = postings.find((item) => item.url === call.body["url"]);
    expect(row, "The page request belongs to this declared cohort").toBeTruthy();
    expect(call.body).toEqual({ url: row!.url });
    call.respond({ finalUrl: row!.url,
      html: `<html><body><h1>${row!.title}</h1><p>${row!.company}</p><p>${row!.description}</p><a href="${row!.url}/apply">Apply</a></body></html>`,
      jsonLd: [{ "@context": "https://schema.org", "@type": "JobPosting", url: row!.url, title: row!.title,
        description: row!.description, hiringOrganization: { "@type": "Organization", name: row!.company }, jobLocationType: "TELECOMMUTE" }],
      statusCode: 200, evidenceComplete: true, visibilityVerified: true });
    return;
  }
  expect(call.method).toBe("POST");
  expect(call.path).toBe("/model");
  expect(call.body["lane"]).toBeTruthy();
  expect(call.body["prompt_version"]).toBeTruthy();
  const sources = modelSources(call);
  const rows = postings.filter((row) => sources.some((source) => source.text === row.title || source.text === row.description || source.text.includes(row.title)));
  expect(rows, "Every producer request identifies exactly one declared posting").toHaveLength(1);
  const row = rows[0]!;
  switch (call.body["operation"]) {
    case "page_interpretation": {
      const field = (value: string) => ({ value, citations: citeSources(call, ["rendered_page"]), rationale: "Explicit interpretation of this authored current page." });
      call.reply({ availability: field("active"), page_kind: field("posting"), access_state: field("clear"), apply_control: field("available") });
      break;
    }
    case "posting_extraction": {
      const inventory = (call.body["context"] as { line_inventory: { source_id: string; lines: { line_id: string }[] }[] }).line_inventory.find((item) => item.source_id === "posting:0:description")!;
      expect(inventory).toBeTruthy();
      const copied = (id: string, value: string) => ({ value, citations: citeSources(call, [id]), rationale: "Copy the exact current captured field." });
      call.reply({ title: copied("posting:0:title", row.title), employer: copied("posting:0:employer", row.company),
        description: { source_id: inventory.source_id, first_line_id: inventory.lines[0]!.line_id, last_line_id: inventory.lines.at(-1)!.line_id,
          rationale: "Select this complete authored description.", value: null, citations: [] },
        location: copied("posting:0:location", "Remote"), salary: { value: "", citations: [], rationale: "No salary was authored." },
        application_url: copied("link:0:url", `${row.url}/apply`), source_origins: [] });
      break;
    }
    case "description_quality":
      call.reply({ confidence: "high", citations: citeSources(call, ["description"]), rationale: "This authored source describes one complete role." });
      break;
    case "jobs.role_analysis": {
      const source = sources[0]!;
      const statement = { text: source.text, citations: citeSources(call, [source.source_id]), uncertainty: "Only this current authored posting is considered." };
      call.reply({ role_framing: statement, inferred_seniority: { value: "unknown", citations: citeSources(call, [source.source_id]),
        rationale: "The supplied source does not establish a level." }, ideal_candidate_narrative: statement, keywords: [] });
      break;
    }
    case "requirements.extract": {
      const selection = row.unsupported
        ? typedExtraction(call, { classification: "non_english", status: "unsupported_language" })
        : typedExtraction(call, { requirements: [{ localId: "r1", text: row.demand ?? COMMON_DEMAND }] });
      if (row.foreignExtractionSource) selection.quotes[0]!.source_id = "foreign-unowned-source";
      call.reply(selection);
      break;
    }
    default:
      throw new Error(`Unexpected producer operation: ${String(call.body["operation"])}`);
  }
}

export async function untilNormalization(app: ApplicationStack, postings: CohortPosting[], { proveOverlap = false } = {}) {
  const observed: ExternalCall[] = [];
  let firstPage = false;
  let waitingPage: ExternalCall | undefined;
  let waitingRole: ExternalCall | undefined;
  let secondPageReleased = false;
  let overlapped = false;
  for (let count = 0; count < postings.length * 6 + 1; count++) {
    const call = await app.external.next();
    observed.push(call);
    if (call.path === "/model" && call.body["operation"] === "requirements.match_catalog") {
      expect(observed.filter((entry) => entry.path === "/posting-page")).toHaveLength(postings.length);
      for (const operation of ["page_interpretation", "posting_extraction", "description_quality", "jobs.role_analysis", "requirements.extract"])
        expect(observed.filter((entry) => entry.body?.["operation"] === operation), operation).toHaveLength(postings.length);
      expect(observed.some((entry) => entry.body?.["operation"] === "fit.qualification-batch")).toBe(false);
      if (proveOverlap) expect(overlapped, "Distinct real model lanes were simultaneously active").toBe(true);
      return call;
    }
    if (proveOverlap && !overlapped && call.path === "/posting-page") {
      if (!firstPage) {
        firstPage = true;
        respondProducer(call, postings);
      } else {
        expect(waitingPage).toBeUndefined();
        waitingPage = call;
        if (waitingRole) { respondProducer(waitingPage, postings); secondPageReleased = true; }
      }
      continue;
    }
    if (proveOverlap && !overlapped && call.body?.["operation"] === "jobs.role_analysis" && !waitingRole) {
      waitingRole = call;
      expect(call.body["lane"]).toBe("analysis");
      if (waitingPage) { respondProducer(waitingPage, postings); secondPageReleased = true; }
      continue;
    }
    if (proveOverlap && !overlapped && waitingRole && secondPageReleased && call.path === "/model" && call.body["lane"] === "enrichment") {
      expect(waitingRole.closed).not.toBe(true);
      expect(call.closed).not.toBe(true);
      overlapped = true;
      respondProducer(waitingRole, postings);
    }
    respondProducer(call, postings);
  }
  throw new Error("The declared cohort never reached complete normalization.");
}
