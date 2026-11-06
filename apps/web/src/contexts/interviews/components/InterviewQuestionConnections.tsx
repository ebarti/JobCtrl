import type {
  InterviewCatalog,
  InterviewQuestionCard,
} from "@jobctrl/contracts";

import { useAcceptedInterviewPrepQuery } from "../hooks/useInterviewQueries.js";
import { InterviewConnections, type InterviewConnection } from "./InterviewConnections.js";

interface Props { readonly catalog: InterviewCatalog; readonly question: InterviewQuestionCard; readonly jobId?: string | undefined; readonly onSelectQuestion: (questionId: string) => void }
function publicConnections(catalog: InterviewCatalog, question: InterviewQuestionCard): InterviewConnection[] {
  return [
    ...catalog.sources.filter((source) => question.sources.includes(source.id) || source.questionIds.includes(question.id)).map((source) => ({ id: `source:${source.id}`, kind: "source" as const, label: `${catalog.authors.find((author) => author.id === source.authorId)?.name ?? source.authorId}: ${source.title} — ${source.readingCoverage}`, href: source.url })),
    ...catalog.relationships.filter((edge) => edge.fromQuestionId === question.id || edge.toQuestionId === question.id).map((edge, index) => {
      const questionId = edge.fromQuestionId === question.id ? edge.toQuestionId : edge.fromQuestionId;
      return { id: `editorial:${index}`, kind: "editorial" as const, questionId, label: `${catalog.questions.find((card) => card.id === questionId)?.title ?? questionId} — ${edge.reason}` };
    }),
  ];
}
export function InterviewQuestionConnections(props: Props) {
  const connections = publicConnections(props.catalog, props.question);
  return props.jobId ? <JobConnections {...props} jobId={props.jobId} connections={connections} /> : <InterviewConnections questionTitle={props.question.title} connections={connections} onSelectQuestion={props.onSelectQuestion} />;
}
function JobConnections({ jobId, question, connections, onSelectQuestion }: Props & { jobId: string; connections: InterviewConnection[] }) {
  const detail = useAcceptedInterviewPrepQuery(jobId);
  const prep = detail.data?.prep;
  const links = prep?.items.find((item) => item.questionMetadata?.questionId === question.id)?.questionMetadata?.evidenceLinks ?? [];
  return <InterviewConnections questionTitle={question.title} connections={[
    ...connections,
    ...links.map((link, index) => {
      return { id: `evidence:${index}`, kind: "evidence" as const, label: `Saved generation ${prep?.generation ?? "unknown"}${prep?.staleReasons?.length ? " — inputs changed" : ""} · ${link.scope}: ${link.excerpt}`, evidenceEntryId: link.evidenceId, jobId };
    }),
  ]} onSelectQuestion={onSelectQuestion} />;
}
