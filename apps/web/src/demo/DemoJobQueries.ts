import { JobCtrlApiError } from "@jobctrl/api-client";
import { z } from "zod";

import type { HttpRequestOptions } from "../shared/ports/HttpPort.js";
import { stableDemoStringify } from "./digest.js";

type Data = Record<string, unknown>;
type Scalar = string | number | null;
export interface DemoJobQueryRow {
  job: Data; fit: Data | null; preparation: Data | null; compensation: Data | null;
  application: Data | null; resume: Data | null;
}
const fields = ["title", "company", "location", "source", "job_state", "fit_score", "current_stage", "current_state", "discovered_at", "scored_at", "compensation_min_eur", "compensation_max_eur", "compensation_posted", "compensation_market", "compensation_confidence", "compensation_warnings", "apply_status", "resume_template"] as const;
const owners: Readonly<Record<string, string>> = { fit_score: "fit", scored_at: "fit", current_stage: "preparation", current_state: "preparation", compensation_min_eur: "compensation", compensation_max_eur: "compensation", compensation_posted: "compensation", compensation_market: "compensation", compensation_confidence: "compensation", compensation_warnings: "compensation", apply_status: "applications", resume_template: "resumes" };
const column = z.object({ operator: z.enum(["contains", "does_not_contain"]).default("contains"), text: z.string().max(1000).default(""), selectedValues: z.array(z.string()).max(200).default([]) }).strict();
const querySchema = z.object({
  q: z.string().max(1000).default(""), job_state: z.string().default("active"), source: z.string().default(""), company: z.string().default(""),
  min_fit_score: z.coerce.number().int().min(1).max(10).optional(), max_fit_score: z.coerce.number().int().min(1).max(10).optional(),
  fit_state: z.enum(["all", "current", "stale", "unassessed"]).default("all"), normalized_score_keyword: z.string().default(""),
  stage: z.string().default(""), state: z.string().default(""), apply_status: z.string().default(""), resume_template: z.string().default(""),
  discovered_since: z.string().optional(), scored_since: z.string().optional(),
  posted_min_eur: z.coerce.number().min(0).optional(), posted_max_eur: z.coerce.number().min(0).optional(), market_min_eur: z.coerce.number().min(0).optional(), market_max_eur: z.coerce.number().min(0).optional(),
  posted_known: z.enum(["all", "known", "unknown"]).default("all"), market_known: z.enum(["all", "known", "unknown"]).default("all"),
  compensation_confidence: z.string().default(""), compensation_warnings: z.enum(["all", "present", "none"]).default("all"),
  column_filters: z.record(z.string(), column).default({}), sort: z.enum(fields).default("discovered_at"), direction: z.enum(["asc", "desc"]).default("desc"),
  offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50), query_revision: z.string().optional(),
}).strict();
type Query = z.infer<typeof querySchema>;
const data = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const string = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
const instant = (value: unknown): number | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const choices = (value: string): string[] => [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
// Literal user-authored predicates only; no relevance or equivalence judgment.
const literal = (value: unknown): string => String(value ?? "").normalize("NFKC").toUpperCase().toLowerCase().replace(/\u03c2/gu, "\u03c3");
const textCompare = (left: string, right: string): number => {
  const a = Array.from(left, (character) => character.codePointAt(0)!); const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return Math.sign(a.length - b.length);
};

function scalars(row: DemoJobQueryRow) {
  const { job, fit, preparation, compensation, application, resume } = row;
  const state = job.hidden === true ? "hidden" : job.deleted === true ? "deleted" : ["closed", "expired", "removed", "location_incompatible"].includes(String(job.active_state)) ? "closed" : "active";
  const score = data(fit?.score); const summary = data(compensation?.summary); const audit = data(compensation?.audit);
  const posted = data(summary.posted); const market = data(summary.market);
  const postedCurrent = data(audit.posted).sourceCurrent === true && posted.recordStatus === "recorded";
  const marketCurrent = data(audit.market).sourceCurrent === true && market.recordStatus === "recorded";
  const postedRange = postedCurrent ? data(posted.range) : {}; const marketRange = marketCurrent ? data(market.range) : {};
  const pMin = postedRange.currency === "EUR" ? numeric(postedRange.annualizedMinimumAmount) : null;
  const pMax = postedRange.currency === "EUR" ? numeric(postedRange.annualizedMaximumAmount) : null;
  const mMin = marketRange.currency === "EUR" && marketRange.period === "year" ? numeric(marketRange.minimumAmount) : null;
  const mMax = marketRange.currency === "EUR" && marketRange.period === "year" ? numeric(marketRange.maximumAmount) : null;
  const warnings = [postedCurrent ? posted.warningCount : undefined, marketCurrent ? market.warningCount : undefined].filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value));
  let status = preparation;
  if (application?.stage !== null && application?.stage !== undefined && instant(application.updated_at) !== null && (instant(preparation?.updated_at) === null || instant(application.updated_at)! >= instant(preparation?.updated_at)!)) status = application;
  const template = data(resume?.template); const effective = data(data(resume?.resume_template).effective);
  const values: Record<string, Scalar> = {
    title: string(job.title), company: string(job.company), location: string(job.location), source: string(job.source_id), job_state: state,
    fit_score: numeric(score.score), current_stage: string(status?.stage), current_state: string(status?.state),
    discovered_at: string(job.created_at), scored_at: string(score.created_at), compensation_min_eur: pMin, compensation_max_eur: pMax,
    compensation_posted: pMin, compensation_market: mMin, compensation_confidence: marketCurrent ? string(market.confidenceBand) : null,
    compensation_warnings: warnings.length ? warnings.reduce((sum, value) => sum + value, 0) : null,
    apply_status: string(application?.apply_status), resume_template: string(template.name) ?? string(template.templateName) ?? string(template.template_name) ?? string(effective.templateName),
  };
  return { values, extra: { market_min: mMin, market_max: mMax, confidence_score: marketCurrent ? numeric(market.confidenceScore) : null,
    fit_current: fit?.current === true, keywords: Array.isArray(fit?.normalized_keywords) ? fit.normalized_keywords : [], url: string(job.url) ?? "" } };
}
type Candidate = ReturnType<typeof scalars> & { row: DemoJobQueryRow; id: string; revisions: Data };
function matches(query: Query, candidate: Candidate, columns = true): boolean {
  const { values, extra } = candidate; const states = choices(query.job_state);
  if (!states.includes("all") && !states.includes(String(values.job_state))) return false;
  if (query.q && !literal([...Object.values(values).filter((value) => value !== null), extra.url].join(" ")).includes(literal(query.q))) return false;
  if (["source", "company"].some((field) => query[field as "source"] && !literal(values[field]).includes(literal(query[field as "source"])))) return false;
  for (const [field, value] of [["current_stage", query.stage], ["current_state", query.state], ["apply_status", query.apply_status], ["resume_template", query.resume_template]]) {
    if (value && value !== "all" && !choices(value).includes(String(values[field!]))) return false;
  }
  const score = numeric(values.fit_score);
  if (query.min_fit_score !== undefined && (score === null || score < query.min_fit_score) || query.max_fit_score !== undefined && (score === null || score > query.max_fit_score)) return false;
  if (query.fit_state === "unassessed" && score !== null || query.fit_state === "current" && !extra.fit_current || query.fit_state === "stale" && (score === null || extra.fit_current)) return false;
  if (query.normalized_score_keyword && !extra.keywords.includes(query.normalized_score_keyword)) return false;
  const dates = [[values.discovered_at, query.discovered_since], [values.scored_at, query.scored_since]];
  if (dates.some(([, cutoff]) => cutoff !== undefined) && !dates.some(([value, cutoff]) => cutoff !== undefined && instant(value) !== null && instant(value)! >= instant(cutoff)!)) return false;
  const ranges: readonly (readonly [Scalar | undefined, number | undefined, number | undefined])[] = [[values.compensation_min_eur, query.posted_min_eur, undefined], [values.compensation_max_eur, undefined, query.posted_max_eur], [extra.market_min, query.market_min_eur, undefined], [extra.market_max, undefined, query.market_max_eur]];
  for (const [value, minimum, maximum] of ranges) {
    if (minimum !== undefined && (typeof value !== "number" || value < minimum) || maximum !== undefined && (typeof value !== "number" || value > maximum)) return false;
  }
  for (const [known, low, high] of [[query.posted_known, values.compensation_min_eur, values.compensation_max_eur], [query.market_known, extra.market_min, extra.market_max]]) {
    const present = low !== null || high !== null;
    if (known === "known" && !present || known === "unknown" && present) return false;
  }
  if (query.compensation_confidence && !choices(query.compensation_confidence).includes(String(values.compensation_confidence))) return false;
  if (query.compensation_warnings === "present" && (typeof values.compensation_warnings !== "number" || values.compensation_warnings <= 0) || query.compensation_warnings === "none" && values.compensation_warnings !== 0) return false;
  if (columns) for (const [field, filter] of Object.entries(query.column_filters)) {
    const value = values[field] === null ? "" : String(values[field]);
    if (filter.selectedValues.length && !filter.selectedValues.includes(value)) return false;
    if (filter.text.trim() && literal(value).includes(literal(filter.text.trim())) !== (filter.operator === "contains")) return false;
  }
  return true;
}

export async function evaluateDemoJobQuery(rows: DemoJobQueryRow[], raw: HttpRequestOptions["query"]) {
  const input = Object.fromEntries(Object.entries(raw ?? {}).filter(([, value]) => value !== undefined && value !== null));
  if (typeof input.column_filters === "string") { try { input.column_filters = JSON.parse(input.column_filters); } catch { throw invalid(); } }
  const parsed = querySchema.safeParse(input); if (!parsed.success) throw invalid(); const query = parsed.data;
  if (!choices(query.job_state).length || choices(query.job_state).some((state) => !["active", "closed", "hidden", "deleted", "all"].includes(state)) || Object.keys(query.column_filters).some((field) => !fields.includes(field as typeof fields[number])) || choices(query.compensation_confidence).some((value) => !["none", "low", "medium", "high"].includes(value)) || [query.discovered_since, query.scored_since].some((value) => value !== undefined && instant(value) === null) || query.min_fit_score !== undefined && query.max_fit_score !== undefined && query.min_fit_score > query.max_fit_score) throw invalid();
  const modules = Object.fromEntries(["fit", "preparation", "compensation", "applications", "resumes"].map((owner) => [owner, { enabled: true, available: true }]));
  const candidates: Candidate[] = await Promise.all(rows.map(async (row) => ({ row, id: String(row.job.job_id), ...scalars(row),
    revisions: { jobs: { revision: row.job.revision, state_revision: row.job.state_revision, source_hash: row.job.source_hash },
      ...Object.fromEntries(await Promise.all(["fit", "preparation", "compensation", "application", "resume"].map(async (field) => [field, await digest(row[field as "fit"])]))) } })));
  const { offset: _offset, limit: _limit, query_revision: _revision, ...identity } = query;
  const revision = await digest({ query: identity, modules, rows: candidates.map(({ id, values, extra, revisions }) => ({ id, values, extra, revisions })).sort((a, b) => textCompare(a.id, b.id)) });
  if (query.query_revision && query.query_revision !== revision) throw new JobCtrlApiError(409, "Conflict", "The Jobs query sources changed. Refresh the list before continuing.");
  const base = candidates.filter((candidate) => matches(query, candidate, false));
  const facets = Object.fromEntries(fields.map((field) => { const values = [...new Set(base.map((candidate) => candidate.values[field] === null ? "" : String(candidate.values[field])))].sort(textCompare); return [field, { values: values.slice(0, 200), complete: values.length <= 200 }]; }));
  const value = (candidate: Candidate): Scalar => {
    const raw = candidate.values[query.sort] ?? null;
    if (["discovered_at", "scored_at"].includes(query.sort)) return instant(raw);
    if (query.sort === "compensation_confidence") return candidate.extra.confidence_score ?? ({ none: 0, low: 1, medium: 2, high: 3 } as Record<string, number>)[String(raw)] ?? null;
    return typeof raw === "string" ? literal(raw) : raw;
  };
  const sorted = base.filter((candidate) => matches(query, candidate)).sort((left, right) => {
    const a = value(left); const b = value(right);
    const comparison = a === null || b === null ? a === b ? 0 : a === null ? 1 : -1 :
      (typeof a === "string" && typeof b === "string" ? textCompare(a, b) : a > b ? 1 : a < b ? -1 : 0) * (query.direction === "asc" ? 1 : -1);
    return comparison || textCompare(left.id, right.id);
  });
  return { rows: sorted.slice(query.offset, query.offset + query.limit).map((candidate) => ({ ...candidate.row, scalars: candidate.values, revisions: candidate.revisions })),
    total: sorted.length, offset: query.offset, limit: query.limit, query_revision: revision, modules,
    capabilities: { sortable_fields: [...fields], filterable_fields: [...fields] }, facets };
}
function invalid() { return new JobCtrlApiError(422, "Invalid Query", "The Jobs query contains invalid literal filters, sorting or pagination."); }
async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableDemoStringify(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
