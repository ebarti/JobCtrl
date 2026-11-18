import { useForm } from "@tanstack/react-form";
import { useState, type ReactNode } from "react";
import { Button } from "../../shared/ui/button.js";
import { isActiveDataGridFilter, type DataGridTextFilter } from "../../shared/ui/filterable-data-grid.js";
import { advancedFiltersSchema, advancedValues, criteriaFromAdvanced, type GridCriteria } from "./jobGridState.js";

const criterionKeys: Readonly<Record<string, readonly (keyof GridCriteria)[]>> = {
  job_state: ["jobState"], fit_score: ["fitState", "minFitScore", "maxFitScore"],
  posted_compensation: ["postedKnown"], compensation_min_eur: ["postedMinEur"], compensation_max_eur: ["postedMaxEur"],
  compensation_market: ["marketKnown", "marketMinEur", "marketMaxEur"], compensation_confidence: ["compensationConfidence"],
  compensation_warnings: ["compensationWarnings"], discovered_at: ["discoveredSince"], scored_at: ["scoredSince"],
};
export function hasJobColumnCriteria(columnId: string): boolean { return Boolean(criterionKeys[columnId]); }
export function clearJobColumnCriteria(columnId: string, criteria: GridCriteria): GridCriteria {
  const next = { ...criteria };
  for (const key of criterionKeys[columnId] ?? []) {
    if (key === "jobState") next.jobState = "all";
    else if (key === "fitState") next.fitState = "all";
    else if (key === "postedKnown") next.postedKnown = "all";
    else if (key === "marketKnown") next.marketKnown = "all";
    else if (key === "compensationConfidence") next.compensationConfidence = "";
    else if (key === "compensationWarnings") next.compensationWarnings = "all";
    else delete next[key];
  }
  return next;
}
const euro = new Intl.NumberFormat("en-US", { maximumFractionDigits: 20 });
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
export function jobColumnFilterSummary(columnId: string, criteria: GridCriteria): string {
  const amount = (value: number | undefined, relation: string) => value === undefined ? "" : `${relation} €${euro.format(value)} / year`;
  switch (columnId) {
    case "job_state": return criteria.jobState === "all" ? "" : criteria.jobState.split(",").map(capitalize).join(", ");
    case "fit_score": return [criteria.fitState === "all" ? "" : criteria.fitState === "unassessed" ? "Not assessed" : capitalize(criteria.fitState), criteria.minFitScore === undefined ? "" : `≥ ${criteria.minFitScore}/10`, criteria.maxFitScore === undefined ? "" : `≤ ${criteria.maxFitScore}/10`].filter(Boolean).join("; ");
    case "posted_compensation": return criteria.postedKnown === "all" ? "" : `${capitalize(criteria.postedKnown)} annual EUR pay`;
    case "compensation_min_eur": return amount(criteria.postedMinEur, "Minimum ≥");
    case "compensation_max_eur": return amount(criteria.postedMaxEur, "Maximum ≤");
    case "compensation_market": return [criteria.marketKnown === "all" ? "" : `${capitalize(criteria.marketKnown)} annual EUR pay`, amount(criteria.marketMinEur, "Minimum ≥"), amount(criteria.marketMaxEur, "Maximum ≤")].filter(Boolean).join("; ");
    case "compensation_confidence": return criteria.compensationConfidence.split(",").filter(Boolean).map((value) => value === "none" ? "Not assessed" : capitalize(value)).join(", ");
    case "compensation_warnings": return criteria.compensationWarnings === "all" ? "" : criteria.compensationWarnings === "present" ? "Present" : "None";
    case "discovered_at": return criteria.discoveredSince ? `Since ${criteria.discoveredSince}${criteria.scoredSince ? " (either date)" : ""}` : "";
    case "scored_at": return criteria.scoredSince ? `Since ${criteria.scoredSince}${criteria.discoveredSince ? " (either date)" : ""}` : "";
    default: return "";
  }
}

export function JobColumnFilter({ columnId, criteria, filter, literalContent, literalPredicate, unavailable, onApply, onClear, onClearLiteral }: {
  columnId: string; criteria: GridCriteria; filter: DataGridTextFilter; literalContent: ReactNode; literalPredicate: ReactNode; unavailable: string | null;
  onApply: (next: GridCriteria, literal?: DataGridTextFilter) => void; onClear: () => void; onClearLiteral: () => void;
}) {
  const [message, setMessage] = useState("");
  const confidenceFromLiteral = columnId === "compensation_confidence" && !criteria.compensationConfidence && filter.selectedValues.includes("");
  const form = useForm({ defaultValues: { ...advancedValues(criteria), ...(confidenceFromLiteral ? { compensationConfidence: filter.selectedValues.map((value) => value === "" ? "unknown" : value).join(",") } : {}) }, onSubmit: ({ value }) => {
    const confidence = value.compensationConfidence.split(",").filter(Boolean);
    const unknownConfidence = columnId === "compensation_confidence" && confidence.includes("unknown");
    const parsed = advancedFiltersSchema.safeParse({ ...value, compensationConfidence: confidence.filter((item) => item !== "unknown").join(",") });
    if (!parsed.success) { setMessage(parsed.error.issues[0]?.message ?? "Review the filters."); return; }
    setMessage("");
    // This editor owns only its column. Even retained form defaults cannot
    // overwrite criteria published from another column or a restored view.
    const candidate = criteriaFromAdvanced(parsed.data, criteria);
    const next = { ...criteria };
    for (const key of criterionKeys[columnId] ?? []) {
      delete next[key];
      if (candidate[key] !== undefined) Object.assign(next, { [key]: candidate[key] });
    }
    if (unknownConfidence) { next.compensationConfidence = ""; onApply(next, { ...filter, selectedValues: confidence.map((item) => item === "unknown" ? "" : item) }); }
    else onApply(next, confidenceFromLiteral ? { ...filter, selectedValues: [] } : undefined);
  } });
  const select = (name: "fitState" | "postedKnown" | "marketKnown" | "compensationWarnings", label: string, options: readonly (readonly [string, string])[]) => <form.Field name={name}>{(field) => <label>{label}<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value as typeof field.state.value)}>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>}</form.Field>;
  const number = (name: "minFitScore" | "maxFitScore" | "postedMinEur" | "postedMaxEur" | "marketMinEur" | "marketMaxEur", label: string) => <form.Field name={name}>{(field) => <label>{label}<input type="number" min={name.includes("FitScore") ? "1" : "0"} max={name.includes("FitScore") ? "10" : "1000000000000"} step={name.includes("FitScore") ? "1" : "any"} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>;
  const choices = (name: "jobState" | "compensationConfidence", label: string, options: readonly (readonly [string, string])[]) => <form.Field name={name}>{(field) => <fieldset className="job-column-filter__choices"><legend>{label}</legend><p>With none selected, all values are shown.</p>{options.map(([value, text]) => <label key={value}><input type="checkbox" checked={field.state.value.split(",").includes(value)} onChange={(event) => {
    const selected = new Set(field.state.value === "all" ? [] : field.state.value.split(",").filter(Boolean));
    if (event.currentTarget.checked) selected.add(value); else selected.delete(value);
    field.handleChange([...selected].join(",") || (name === "jobState" ? "all" : ""));
  }} />{text}</label>)}</fieldset>}</form.Field>;
  const known = [["all", "All"], ["known", "Known"], ["unknown", "Unknown"]] as const;
  const date = (name: "discoveredSince" | "scoredSince", label: string) => <form.Field name={name}>{(field) => <label>{label}<input type="date" value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>;
  const fields: Record<string, ReactNode> = {
    job_state: choices("jobState", "Job state", [["active", "Active"], ["closed", "Closed"], ["hidden", "Hidden"], ["deleted", "Deleted"]]),
    fit_score: <>{select("fitState", "Fit assessment", [["all", "All"], ["current", "Current"], ["stale", "Stale"], ["unassessed", "Not assessed"]])}<div className="job-column-filter__range">{number("minFitScore", "Minimum person fit (1–10)")}{number("maxFitScore", "Maximum person fit (1–10)")}</div></>,
    posted_compensation: <>{select("postedKnown", "Posted pay", known)}<p>Known means at least one current annual EUR bound is recorded. A source range in another currency or period can still be unknown here.</p></>,
    compensation_min_eur: number("postedMinEur", "Posted annual minimum at least (€)"),
    compensation_max_eur: number("postedMaxEur", "Posted annual maximum at most (€)"),
    compensation_market: <>{select("marketKnown", "Market pay", known)}<div className="job-column-filter__range">{number("marketMinEur", "Market annual minimum at least (€)")}{number("marketMaxEur", "Market annual maximum at most (€)")}</div><p>Bounds use current market evidence normalized to EUR per year.</p></>,
    compensation_confidence: choices("compensationConfidence", "Market reliability", [["none", "Not assessed"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["unknown", "Unknown (no recorded value)"]]),
    compensation_warnings: select("compensationWarnings", "Compensation warnings", [["all", "All"], ["present", "Present"], ["none", "None"]]),
    discovered_at: date("discoveredSince", "Discovered since"), scored_at: date("scoredSince", "Fit assessed since"),
  };
  const usesChoices = columnId === "job_state" || columnId === "compensation_confidence";
  const savedConstraint = (usesChoices || columnId === "posted_compensation") && isActiveDataGridFilter(filter) && !confidenceFromLiteral;
  return <div className="job-column-filter">
    {unavailable ? <p role="status">{unavailable}. These criteria remain available and can be cleared.</p> : null}
    <form aria-label={`${columnId} criteria`} onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
      {fields[columnId]}
      {columnId === "discovered_at" || columnId === "scored_at" ? <p>When both Discovered since and Fit assessed since are set, a job matching either date is included.</p> : null}
      {message ? <p role="alert">{message}</p> : null}
      <div className="job-column-filter__actions"><Button type="submit" variant="outline">Apply filters</Button><Button type="button" variant="ghost" onClick={onClear}>Clear column filter</Button></div>
    </form>
    {savedConstraint ? <section aria-label="Saved column constraint"><p>Additional saved column constraint: {filter.selectedValues.length ? filter.selectedValues.map((value) => value === "" ? "Unknown (no recorded value)" : value).join(", ") : ""}{filter.text.trim() ? ` ${filter.operator === "contains" ? "contains" : "does not contain"} “${filter.text}”` : ""}.</p><Button type="button" variant="ghost" onClick={onClearLiteral}>Remove saved column constraint</Button></section> : null}
    {usesChoices ? <details className="job-column-filter__literal"><summary>Text condition</summary><div className="data-grid-filter-condition">{literalPredicate}</div></details> : null}
    {!usesChoices && columnId !== "posted_compensation" ? <details className="job-column-filter__literal"><summary>Exact values or text</summary>{literalContent}</details> : null}
  </div>;
}
