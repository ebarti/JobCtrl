import { SearchPreferencesResultSchema } from "../../operations/types.js";
import { useSearchPreferences } from "../hooks/useSearchPreferences.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../shared/ui/card.js";
export function SearchPreferencesPanel({
  profileVersion,
}: {
  profileVersion: number | undefined;
}) {
  const { query, mutation } = useSearchPreferences(profileVersion);
  const envelope = query.data?.determination;
  const result = envelope
    ? SearchPreferencesResultSchema.parse(envelope.result)
    : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirm interpreted search preferences</CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          Review how the model understood your saved targets, locations and
          exclusions. Discovery uses this interpretation after you confirm it.
          Changing your profile or criteria requires a fresh confirmation.
        </p>
        {query.isError ? <p role="status">{query.error.message}</p> : null}
        {mutation.isError ? (
          <p role="status">{mutation.error.message}</p>
        ) : null}
        <p>Status: {query.data?.status.replaceAll("_", " ") ?? "Loading"}</p>
        {result ? (
          <>
            <p>{result.rationale}</p>
            <ul>
              {result.roles.map((role, index) => (
                <li key={index}>
                  {role.title}: {role.track}, {role.seniority_floor},{" "}
                  {role.occupation_family}. {role.rationale}
                </li>
              ))}
              {result.places.map((place, index) => (
                <li key={"place" + index}>
                  {place.locality ?? place.country_code ?? place.region}:{" "}
                  {place.rationale}
                </li>
              ))}
              {result.work_models.map((work, index) => (
                <li key={"work" + index}>
                  {work.value}: {work.rationale}
                </li>
              ))}
              {result.conditions.map((condition, index) => (
                <li key={"condition" + index}>
                  {condition.force}: {condition.description}.{" "}
                  {condition.rationale}
                </li>
              ))}
            </ul>
            <details>
              <summary>Sources and determination</summary>
              <pre>{JSON.stringify(envelope, null, 2)}</pre>
            </details>
          </>
        ) : null}
        <Button
          disabled={profileVersion === undefined || mutation.isPending}
          onClick={() => mutation.mutate("prepare")}
        >
          Interpret saved preferences
        </Button>
        {query.data?.status === "pending_confirmation" ? (
          <Button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("confirm")}
          >
            Confirm this interpretation
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
