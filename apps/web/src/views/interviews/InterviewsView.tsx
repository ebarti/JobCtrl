import { PageHead } from "../../shared/ui/page-head.js";

export function InterviewsView() {
  return (
    <>
      <PageHead
        eyebrow="Library"
        title="Interviews"
        subtitle="Question guidance and grounded preparation before an interview."
      />
      <section className="card full" aria-label="Interview library">
        <p>Browse research questions, then select a job to prepare from your saved evidence.</p>
        <p className="muted">Research criteria are drafts. They do not establish a readiness score or validated assessment.</p>
      </section>
    </>
  );
}
