import type { InterviewCatalog, InterviewQuestionCard } from "../../operations/types.js";

import { MarkdownDocument } from "../../../shared/ui/MarkdownDocument.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";

export function InterviewQuestionDetail({ question, catalog }: { readonly question: InterviewQuestionCard; readonly catalog: InterviewCatalog }) {
  const sources = catalog.sources.filter((source) => question.sources.includes(source.id) || source.questionIds.includes(question.id));
  return (
    <article className="interview-question-detail" aria-labelledby="interview-question-title">
      <header>
        <p className="muted" data-typography="metadata">{question.id} · {question.topic} · {question.defaultAnswerFormat}</p>
        <h2 id="interview-question-title" data-typography="section-title">{question.title}</h2>
        <StatusBadge tone="warn">Research draft</StatusBadge>
        <p className="muted">Criteria guide preparation; they are not validated grading or a readiness score.</p>
      </header>
      {[
        ["Question variants", question.variants], ["What the question explores", question.intent],
        ["Answer guidance", question.answer], ["Responsibility and role adaptations", question.adaptation],
        ["Acceptable alternatives", question.alternatives], ["Follow-up probes", question.probes],
        ["Failure patterns", question.failures], ["Attribution and limits", question.provenance],
      ].map(([title, text]) => text ? <section key={title} className="section"><h3 data-typography="component-title">{title}</h3><MarkdownDocument text={text} /></section> : null)}
      <section className="section" aria-label="Draft answer criteria">
        <h3 data-typography="component-title">Draft answer criteria</h3>
        <p>These dimensions are independent prompts for reflection. Do not total them into a score.</p>
        <dl className="grid gap-4">
          {question.rubric.map((criterion) => <div key={criterion.dimension}><dt data-typography="strong-body">{criterion.dimension}</dt><dd className="m-0"><p><strong>Needs more detail:</strong> {criterion.weak}</p><p><strong>Stronger reasoning:</strong> {criterion.strong}</p></dd></div>)}
        </dl>
      </section>
      {question.examples.length ? <section className="section"><h3 data-typography="component-title">Synthetic worked examples</h3>{question.examples.map((example) => <details key={example.title}><summary>{example.title}</summary><MarkdownDocument text={example.body} /></details>)}</section> : null}
      <section className="section" aria-label="Source attribution">
        <h3 data-typography="component-title">Sources and reading limits</h3>
        <p className="muted">Attribution: {question.attributionKind.replaceAll("_", " ")}. Public research provides guidance, never evidence of your experience.</p>
        <ul className="grid gap-4">{sources.map((source) => <li key={source.id}>
          <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
          <p>{catalog.authors.find((author) => author.id === source.authorId)?.name ?? source.authorId}</p>
          <p><strong>Reading coverage:</strong> {source.readingCoverage}</p><p>{source.note}</p>
        </li>)}</ul>
      </section>
      <details className="section"><summary>Catalog and question versions</summary><dl>
        {[ ["Catalog revision", catalog.catalogRevision], ["Catalog digest", catalog.catalogDigest], ["Card revision", question.cardRevision], ["Card digest", question.cardDigest], ["Rubric revision", question.rubricRevision], ["Rubric digest", question.rubricDigest], ["Authored reference", question.sourceRef] ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="break-all"><code>{value}</code></dd></div>)}
      </dl></details>
    </article>
  );
}
