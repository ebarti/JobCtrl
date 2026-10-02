import { INTERVIEW_ANSWER_FORMATS, INTERVIEW_ROLE_LENSES } from "../../contexts/operations/types.js";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";

import { InterviewQuestionDetail } from "../../contexts/materials/components/InterviewQuestionDetail.js";
import { InterviewQuestionConnections } from "../../contexts/materials/components/InterviewQuestionConnections.js";
import { InterviewJobPreparation } from "../../contexts/materials/components/InterviewJobPreparation.js";
import { useInterviewCatalogQuery, useInterviewQuestionQuery } from "../../contexts/operations/hooks/useInterviewQueries.js";
import type { InterviewsSearch } from "../../routes/-interviews.search.js";
import { Button, buttonVariants } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { Input } from "../../shared/ui/input.js";
import { MarkdownDocument } from "../../shared/ui/MarkdownDocument.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/select.js";

function Filter({ label, value, choices, onChange }: { readonly label: string; readonly value: string; readonly choices: readonly { value: string; label: string }[]; readonly onChange: (value: string) => void }) {
  return <div className="grid gap-1"><span data-typography="label">{label}</span><Select value={value} onValueChange={(next) => onChange(next ?? "")}><SelectTrigger aria-label={label} className="w-full"><SelectValue>{choices.find((choice) => choice.value === value)?.label ?? `All ${label.toLowerCase()}`}</SelectValue></SelectTrigger><SelectContent><SelectItem value="">All {label.toLowerCase()}</SelectItem>{choices.map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}</SelectContent></Select></div>;
}

export function InterviewsView() {
  const search = useSearch({ from: "/interviews" });
  const navigate = useNavigate({ from: "/interviews" });
  const query = useInterviewCatalogQuery();
  const catalog = query.data?.catalog;
  const selectedQuery = useInterviewQuestionQuery(catalog && !catalog.retiredQuestions.some((question) => question.id === search.card) ? search.card : "");
  const normalized = search.q.trim().toLowerCase();
  const questions = useMemo(() => (catalog?.questions ?? []).filter((question) =>
    (!search.topic || question.topic === search.topic || catalog?.topics.find((topic) => topic.id === search.topic)?.questionIds.includes(question.id)) &&
    (!search.role || question.roleLenses.some((role) => role === search.role)) &&
    (!search.source || question.sources.includes(search.source) || catalog?.sources.find((source) => source.id === search.source)?.questionIds.includes(question.id)) &&
    (!search.format || question.answerFormats.some((format) => format === search.format)) &&
    (!normalized || [question.id, question.title, question.intent, question.answer, question.adaptation, ...question.responsibilityTags, ...question.competencyTags].join(" ").toLowerCase().includes(normalized)),
  ), [catalog, search.topic, search.role, search.source, search.format, normalized]);
  const selected = search.card ? selectedQuery.data?.question ?? catalog?.questions.find((question) => question.id === search.card) ?? null : questions[0] ?? null;
  const retired = catalog?.retiredQuestions.find((question) => question.id === search.card);
  const unavailableQuestionId = !selected && search.card.length <= 12 && search.card.trim() && (retired || selectedQuery.error) ? search.card : undefined;
  const setSearch = (next: Partial<InterviewsSearch>) => { void navigate({ search: (previous: InterviewsSearch) => ({ ...previous, ...next }) }); };
  const selectQuestion = (card: string) => setSearch({ card });
  return (
    <>
      <PageHead eyebrow="Library" title="Interviews" subtitle={catalog ? `${questions.length} of ${query.data?.total ?? catalog.questions.length} research questions · catalog ${catalog.catalogRevision}` : "Question guidance and grounded preparation before an interview."}
        actions={search.job ? <Link className={buttonVariants({ variant: "outline", size: "sm" })} to="/interviews" search={{ ...search, job: "" }}>Browse without job</Link> : <Link className={buttonVariants({ variant: "outline", size: "sm" })} to="/jobs">Choose a job to prepare</Link>} />
      <section className="card full interview-library" aria-label="Interview library">
        <p className="muted">Browse without a job or provider. Criteria are research drafts; no readiness score or validated grading is offered.</p>
        {query.error ? <p role="alert">Could not load the public interview catalog: {query.error.message}</p> : null}
        <div className="interview-library__filters">
          <label className="grid gap-1"><span data-typography="label">Search questions</span><Input value={search.q} placeholder="Question, responsibility or competency" onChange={(event) => setSearch({ q: event.target.value, card: "" })} /></label>
          <Filter label="Topics" value={search.topic} choices={(catalog?.topics ?? []).map((topic) => ({ value: topic.id, label: topic.name }))} onChange={(topic) => setSearch({ topic, card: "" })} />
          <Filter label="Roles" value={search.role} choices={INTERVIEW_ROLE_LENSES.map((role) => ({ value: role, label: role.replaceAll("_", " ") }))} onChange={(role) => setSearch({ role, card: "" })} />
          <Filter label="Answer formats" value={search.format} choices={INTERVIEW_ANSWER_FORMATS.map((format) => ({ value: format, label: format }))} onChange={(format) => setSearch({ format, card: "" })} />
          <Filter label="Sources" value={search.source} choices={(catalog?.sources ?? []).map((source) => ({ value: source.id, label: source.title }))} onChange={(source) => setSearch({ source, card: "" })} />
        </div>
        <div className="flex flex-wrap gap-2 py-3" role="group" aria-label="Library display mode">
          <Button type="button" variant={search.mode === "list" ? "default" : "outline"} aria-pressed={search.mode === "list"} onClick={() => setSearch({ mode: "list" })}>List</Button>
          <Button type="button" variant={search.mode === "graph" ? "default" : "outline"} aria-pressed={search.mode === "graph"} onClick={() => setSearch({ mode: "graph" })}>Graph</Button>
          <Button type="button" variant="ghost" onClick={() => setSearch({ q: "", topic: "", role: "", format: "", source: "", card: "" })}>Clear filters</Button>
        </div>
        <div className="interview-library__workspace">
          <nav aria-label="Interview questions" className="interview-library__list">
            {query.isPending ? <Empty title="Loading interview questions." /> : !questions.length ? <Empty title="No questions match these filters." /> : <ul>{questions.map((question) => <li key={question.id}><Link to="/interviews" search={{ ...search, card: question.id }} aria-current={selected?.id === question.id ? "page" : undefined} className="interview-library__question"><span data-typography="metadata">{question.id} · {question.defaultAnswerFormat}</span><strong data-typography="strong-body">{question.title}</strong></Link></li>)}</ul>}
          </nav>
          <div className="interview-library__detail">
            {retired ? <section role="status"><h2>{retired.id} is retired</h2><p>{retired.reason}</p><p>This identifier has no replacement and cannot be selected for generation.</p></section> : selected && catalog ? <>
              {search.mode === "graph" ? <InterviewQuestionConnections catalog={catalog} question={selected} jobId={search.job || undefined} onSelectQuestion={selectQuestion} /> : null}
              <InterviewQuestionDetail key={selected.id} question={selected} catalog={catalog} />
            </> : search.card && selectedQuery.error ? <Empty title="Question unavailable. This identifier cannot be selected for generation." /> : <Empty title="Select a question to inspect its guidance." />}
          </div>
        </div>
        {catalog ? <details className="section"><summary>Catalog source ledger, reading coverage and maturity</summary>{Object.entries(catalog.guidance).map(([section, text]) => <section key={section}><h3>{section.replaceAll("_", " ")}</h3><MarkdownDocument text={text} /></section>)}<p>Reviewed {catalog.reviewedAt}; {catalog.sources.length} sources; {catalog.authors.length} author groups.</p></details> : null}
      </section>
      {search.job && catalog ? <InterviewJobPreparation key={search.job} jobId={search.job} catalog={catalog} question={selected} unavailableQuestionId={unavailableQuestionId} /> : null}
    </>
  );
}
