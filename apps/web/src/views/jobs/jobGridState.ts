import { z } from "zod";
import type { SavedTableView, SavedTableViewUrlFilters } from "@jobctrl/contracts";
import type { DataGridFilterState, DataGridSortState } from "../../shared/ui/filterable-data-grid.js";
import type { JobGridQuery } from "../../contexts/jobs/index.js";

export interface GridCriteria {
  q: string; jobState: string; fitState: "all" | "current" | "stale" | "unassessed";
  minFitScore?: number; maxFitScore?: number; discoveredSince?: string; scoredSince?: string;
  postedMinEur?: number; postedMaxEur?: number; marketMinEur?: number; marketMaxEur?: number;
  postedKnown: "all" | "known" | "unknown"; marketKnown: "all" | "known" | "unknown";
  compensationConfidence: string; compensationWarnings: "all" | "present" | "none";
}
export const defaultCriteria: GridCriteria = { q: "", jobState: "active", fitState: "all", postedKnown: "all", marketKnown: "all", compensationConfidence: "", compensationWarnings: "all" };
export function criteriaFromQuery(query: JobGridQuery): GridCriteria {
  return { q: query.q, jobState: query.job_state, fitState: query.fit_state ?? "all", postedKnown: query.posted_known ?? "all",
    marketKnown: query.market_known ?? "all", compensationConfidence: query.compensation_confidence ?? "", compensationWarnings: query.compensation_warnings ?? "all",
    ...(query.min_fit_score !== undefined ? { minFitScore: query.min_fit_score } : {}), ...(query.max_fit_score !== undefined ? { maxFitScore: query.max_fit_score } : {}),
    ...(query.discovered_since ? { discoveredSince: query.discovered_since } : {}), ...(query.scored_since ? { scoredSince: query.scored_since } : {}),
    ...(query.posted_min_eur !== undefined ? { postedMinEur: query.posted_min_eur } : {}), ...(query.posted_max_eur !== undefined ? { postedMaxEur: query.posted_max_eur } : {}),
    ...(query.market_min_eur !== undefined ? { marketMinEur: query.market_min_eur } : {}), ...(query.market_max_eur !== undefined ? { marketMaxEur: query.market_max_eur } : {}) };
}
const score = z.string().refine((value) => value === "" || (Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 10), "Enter a score from 1 to 10.");
const amount = z.string().refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e12), "Enter a nonnegative amount.");
const stateSet = z.string().refine((value) => value === "all" || (value.length > 0 && value.split(",").every((item) => ["active", "closed", "hidden", "deleted"].includes(item))), "Choose valid job states.");
const confidenceSet = z.string().refine((value) => value === "" || value.split(",").every((item) => ["none", "low", "medium", "high"].includes(item)), "Choose valid reliability values.");
export const advancedFiltersSchema = z.object({
  jobState: stateSet, fitState: z.enum(["all", "current", "stale", "unassessed"]),
  minFitScore: score, maxFitScore: score, discoveredSince: z.string(), scoredSince: z.string(),
  postedMinEur: amount, postedMaxEur: amount, marketMinEur: amount, marketMaxEur: amount,
  postedKnown: z.enum(["all", "known", "unknown"]), marketKnown: z.enum(["all", "known", "unknown"]),
  compensationConfidence: confidenceSet, compensationWarnings: z.enum(["all", "present", "none"]),
}).superRefine((value, context) => {
  for (const [low, high] of [["minFitScore", "maxFitScore"], ["postedMinEur", "postedMaxEur"], ["marketMinEur", "marketMaxEur"]] as const) {
    if (value[low] && value[high] && Number(value[low]) > Number(value[high])) context.addIssue({ code: "custom", path: [high], message: "Minimum must not exceed maximum." });
  }
});
export type AdvancedFilterValues = z.input<typeof advancedFiltersSchema>;
export function advancedValues(criteria: GridCriteria): AdvancedFilterValues {
  const string = (value: number | undefined) => value === undefined ? "" : String(value);
  return { jobState: criteria.jobState,
    fitState: criteria.fitState, minFitScore: string(criteria.minFitScore), maxFitScore: string(criteria.maxFitScore),
    discoveredSince: criteria.discoveredSince?.slice(0, 10) ?? "", scoredSince: criteria.scoredSince?.slice(0, 10) ?? "",
    postedMinEur: string(criteria.postedMinEur), postedMaxEur: string(criteria.postedMaxEur), marketMinEur: string(criteria.marketMinEur), marketMaxEur: string(criteria.marketMaxEur),
    postedKnown: criteria.postedKnown, marketKnown: criteria.marketKnown,
    compensationConfidence: criteria.compensationConfidence,
    compensationWarnings: criteria.compensationWarnings };
}
export function criteriaFromAdvanced(value: AdvancedFilterValues, previous: GridCriteria): GridCriteria {
  const numeric = (entry: string) => entry === "" ? undefined : Number(entry);
  const optional = (key: string, val: number | string | undefined) => val === undefined || val === "" ? {} : { [key]: val };
  const date = (entry: string, saved: string | undefined) => saved && entry === saved.slice(0, 10) ? saved : entry;
  return { q: previous.q, jobState: value.jobState, fitState: value.fitState, postedKnown: value.postedKnown, marketKnown: value.marketKnown,
    compensationConfidence: value.compensationConfidence, compensationWarnings: value.compensationWarnings,
    ...optional("minFitScore", numeric(value.minFitScore)), ...optional("maxFitScore", numeric(value.maxFitScore)),
    ...optional("discoveredSince", date(value.discoveredSince, previous.discoveredSince)), ...optional("scoredSince", date(value.scoredSince, previous.scoredSince)),
    ...optional("postedMinEur", numeric(value.postedMinEur)), ...optional("postedMaxEur", numeric(value.postedMaxEur)),
    ...optional("marketMinEur", numeric(value.marketMinEur)), ...optional("marketMaxEur", numeric(value.marketMaxEur)) };
}
export function restoreView(view: SavedTableView | undefined): { criteria: GridCriteria; filters: DataGridFilterState; sort: DataGridSortState; pageSize: number } {
  const saved = view?.urlFilters ?? {};
  const grid = saved.jobGrid ?? {};
  const filters: DataGridFilterState = { ...(view?.gridFilters ?? {}) };
  return { criteria: { ...defaultCriteria, q: saved.q ?? "", jobState: grid.jobState ?? "active",
    fitState: grid.fitState ?? "all", postedKnown: grid.postedKnown ?? "all", marketKnown: grid.marketKnown ?? "all",
    compensationConfidence: grid.compensationConfidence ?? "", compensationWarnings: grid.compensationWarnings ?? "all",
    ...(saved.minFitScore !== undefined ? { minFitScore: saved.minFitScore } : {}), ...(saved.maxFitScore !== undefined ? { maxFitScore: saved.maxFitScore } : {}),
    ...(saved.discoveredSince ? { discoveredSince: saved.discoveredSince } : {}), ...(saved.scoredSince ? { scoredSince: saved.scoredSince } : {}),
    ...(grid.postedMinEur !== undefined ? { postedMinEur: grid.postedMinEur } : {}), ...(grid.postedMaxEur !== undefined ? { postedMaxEur: grid.postedMaxEur } : {}),
    ...(grid.marketMinEur !== undefined ? { marketMinEur: grid.marketMinEur } : {}), ...(grid.marketMaxEur !== undefined ? { marketMaxEur: grid.marketMaxEur } : {}) },
    filters, sort: view?.sort ?? { columnId: "discovered_at", direction: "desc" }, pageSize: saved.pageSize ?? 50 };
}
export function savedFilters(criteria: GridCriteria, pageSize: number): SavedTableViewUrlFilters {
  return { q: criteria.q, pageSize,
    ...(criteria.minFitScore !== undefined ? { minFitScore: criteria.minFitScore } : {}), ...(criteria.maxFitScore !== undefined ? { maxFitScore: criteria.maxFitScore } : {}),
    ...(criteria.discoveredSince ? { discoveredSince: criteria.discoveredSince } : {}), ...(criteria.scoredSince ? { scoredSince: criteria.scoredSince } : {}),
    jobGrid: { jobState: criteria.jobState, fitState: criteria.fitState, postedKnown: criteria.postedKnown, marketKnown: criteria.marketKnown,
      compensationConfidence: criteria.compensationConfidence, compensationWarnings: criteria.compensationWarnings,
      ...(criteria.postedMinEur !== undefined ? { postedMinEur: criteria.postedMinEur } : {}), ...(criteria.postedMaxEur !== undefined ? { postedMaxEur: criteria.postedMaxEur } : {}),
      ...(criteria.marketMinEur !== undefined ? { marketMinEur: criteria.marketMinEur } : {}), ...(criteria.marketMaxEur !== undefined ? { marketMaxEur: criteria.marketMaxEur } : {}) } };
}
