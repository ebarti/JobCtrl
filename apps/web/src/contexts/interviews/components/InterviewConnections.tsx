import { Link } from "@tanstack/react-router";

import { Button } from "../../../shared/ui/button.js";

export interface InterviewConnection {
  readonly id: string;
  readonly label: string;
  readonly kind: "source" | "editorial" | "evidence";
  readonly questionId?: string;
  readonly href?: string;
  readonly evidenceEntryId?: string;
  readonly jobId?: string;
}

export interface InterviewConnectionsProps {
  readonly questionTitle: string;
  readonly connections: readonly InterviewConnection[];
  readonly onSelectQuestion: (questionId: string) => void;
}

const KIND_LABEL = { source: "Author/source attribution", editorial: "Editorially related question", evidence: "Personal evidence overlay" } as const;

// Connections are native links/buttons in normal reading order. The linework
// expresses the same edge kinds visually; it never owns actions or facts.
export function InterviewConnections({ questionTitle, connections, onSelectQuestion }: InterviewConnectionsProps) {
  return (
    <section aria-label="Question connections" className="interview-connections">
      <h3 data-typography="component-title">Connections</h3>
      <p className="muted">Solid: author/source attribution. Dashed: editorial relationships. Dotted: personal evidence for the selected job.</p>
      <div className="interview-connections__graph">
        <div className="interview-connections__origin" data-typography="strong-body">{questionTitle}</div>
        <ul className="interview-connections__nodes">
          {connections.map((connection) => (
            <li key={connection.id} data-edge-kind={connection.kind}>
              <span className="interview-connections__edge" aria-hidden="true" />
              <span>
                <span className="muted" data-typography="metadata">{KIND_LABEL[connection.kind]}</span>
                {connection.questionId ? (
                  <Button type="button" variant="link" className="h-auto whitespace-normal text-left" onClick={() => onSelectQuestion(connection.questionId!)}>{connection.label}</Button>
                ) : connection.evidenceEntryId ? (
                  <Link to="/evidence-map" search={{ q: "", entry: connection.evidenceEntryId, job: connection.jobId ?? "" }}>{connection.label}</Link>
                ) : connection.href ? (
                  <a href={connection.href} target="_blank" rel="noreferrer">{connection.label}</a>
                ) : <span data-typography="body">{connection.label}</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {!connections.length ? <p className="muted">No recorded connections for this question.</p> : null}
    </section>
  );
}
