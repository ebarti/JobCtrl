import { useState } from "react";
import { useDiscoveryTriageQuery } from "../hooks/useDiscoveryTriageQuery.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "../../../shared/ui/card.js";
export function DiscoveryTriagePanel() {
  const [offset, setOffset] = useState(0);
  const query = useDiscoveryTriageQuery(offset);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Listing decisions</CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          Every listing waits for a model decision before admission. Pending and
          uncertain listings remain here; adjust confirmed targets and retry
          Discovery when more evidence is available.
        </p>
        {query.isPending ? (
          <p>Loading listing decisions…</p>
        ) : query.isError ? (
          <p role="status">
            Listing decisions are unavailable. {query.error.message}
          </p>
        ) : query.data.rows.length === 0 ? (
          <p>No listing decisions recorded.</p>
        ) : (
          <ul>
            {query.data.rows.map((row) => (
              <li key={row.rowId}>
                <a href={row.url} target="_blank" rel="noreferrer">
                  {row.title || "Untitled listing"}
                </a>{" "}
                — {row.company} · {row.location}
                <p>
                  {row.status.replaceAll("_", " ")}
                  {row.reasonCode
                    ? ": " + row.reasonCode.replaceAll("_", " ")
                    : ""}
                  {row.failureCode
                    ? " · " + row.failureCode.replaceAll("_", " ")
                    : ""}
                </p>
                {row.rationale ? <p>{row.rationale}</p> : null}
                {row.determination ? (
                  <details>
                    <summary>Decision sources</summary>
                    <p>
                      {row.determination.provider} · {row.determination.model} ·{" "}
                      {row.determination.prompt_version}
                    </p>
                    {row.citations.map((citation, index) => (
                      <p key={index}>
                        <strong>{citation.source_id}</strong>: {citation.quote}
                      </p>
                    ))}
                    <p>Input: {row.determination.input_fingerprint}</p>
                    <p>Targets: {row.targetFingerprint}</p>
                    {row.preferencesDetermination ? (
                      <details>
                        <summary>Confirmed preference sources</summary>
                        <pre>
                          {JSON.stringify(
                            row.preferencesDetermination,
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    ) : null}
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div>
          <Button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </Button>
          <Button
            type="button"
            disabled={!query.data || offset + 50 >= query.data.total}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
