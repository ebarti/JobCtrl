import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useApplicationOutcomesQuery } from "../outcomes.js";
import { OutcomeSuggestionsPanel } from "./ApplicationOutcomes.js";

/** Independent application-owned dashboard panel; a failed read does not hide other panels. */
export function OutcomeSuggestionsDashboard() {
  const query = useApplicationOutcomesQuery();
  const suggestions = (query.data?.suggestions ?? []).filter((suggestion) => suggestion.status === "pending");
  return (
    <section className="card col-span-full" aria-label="Outcome suggestions">
      <CardHeader title="Outcome suggestions" meta={query.data ? `${suggestions.length} pending` : "loading"} />
      {query.error ? <div role="alert" className="banner inline">Outcome suggestions could not be loaded: {query.error.message}</div> : null}
      {query.isFetching && !query.data ? <Empty title="Loading outcome suggestions." /> : null}
      {query.data ? <OutcomeSuggestionsPanel suggestions={suggestions} interpretationStatus={query.data.interpretationStatus} /> : null}
    </section>
  );
}
