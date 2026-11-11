import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { Button } from "../../shared/ui/button.js";
import { advancedFiltersSchema, advancedValues, criteriaFromAdvanced, type GridCriteria } from "./jobGridState.js";

export function AdvancedJobFilters({ criteria, onApply }: { criteria: GridCriteria; onApply: (next: GridCriteria) => void }) {
  const [message, setMessage] = useState("");
  const form = useForm({ defaultValues: advancedValues(criteria), onSubmit: ({ value }) => {
    const parsed = advancedFiltersSchema.safeParse(value);
    if (!parsed.success) { setMessage(parsed.error.issues[0]?.message ?? "Review the filters."); return; }
    setMessage(""); onApply(criteriaFromAdvanced(parsed.data, criteria));
  } });
  const numeric = [
    ["minFitScore", "Minimum person fit (1–10)"], ["maxFitScore", "Maximum person fit (1–10)"],
    ["postedMinEur", "Posted annual minimum at least (€)"], ["postedMaxEur", "Posted annual maximum at most (€)"],
    ["marketMinEur", "Market annual minimum at least (€)"], ["marketMaxEur", "Market annual maximum at most (€)"],
  ] as const;
  return <form aria-label="Job filters" className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
    <form.Field name="jobState">{(field) => <label>Job state<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}>
      {field.state.value.includes(",") ? <option value={field.state.value}>{field.state.value}</option> : null}
      <option value="active">Active</option><option value="closed">Closed</option><option value="hidden">Hidden</option><option value="deleted">Deleted</option><option value="all">All</option>
    </select></label>}</form.Field>
    <form.Field name="fitState">{(field) => <label>Fit assessment<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value as typeof field.state.value)}>
      <option value="all">All</option><option value="current">Current</option><option value="stale">Stale</option><option value="unassessed">Not assessed</option>
    </select></label>}</form.Field>
    {numeric.map(([name, label]) => <form.Field key={name} name={name}>{(field) => <label>{label}<input type="number" min={name.includes("FitScore") ? "1" : "0"} max={name.includes("FitScore") ? "10" : undefined} step={name.includes("FitScore") ? "1" : "any"} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>)}
    {([ ["discoveredSince", "Discovered since"], ["scoredSince", "Scored since"] ] as const).map(([name, label]) => <form.Field key={name} name={name}>{(field) => <label>{label}<input type="date" value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>)}
    <p>When both dates are set, a job matching either date is included.</p>
    {([ ["postedKnown", "Posted pay"], ["marketKnown", "Market pay"] ] as const).map(([name, label]) => <form.Field key={name} name={name}>{(field) => <label>{label}<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value as typeof field.state.value)}><option value="all">All</option><option value="known">Known</option><option value="unknown">Unknown</option></select></label>}</form.Field>)}
    <form.Field name="compensationConfidence">{(field) => <label>Market reliability<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}>
      {field.state.value.includes(",") ? <option value={field.state.value}>{field.state.value}</option> : null}
      <option value="">All</option><option value="none">Not assessed</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
    </select></label>}</form.Field>
    <form.Field name="compensationWarnings">{(field) => <label>Compensation warnings<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value as typeof field.state.value)}><option value="all">All</option><option value="present">Present</option><option value="none">None</option></select></label>}</form.Field>
    {message ? <p role="alert">{message}</p> : null}
    <Button type="submit" variant="outline">Apply filters</Button>
  </form>;
}
