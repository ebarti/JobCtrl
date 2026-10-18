import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  CareerLearningCommandSchema,
  type CareerCohort,
  type CareerLearningCommand,
  type CareerLearningResponse,
  type CareerMilestone,
  type DeterminationCitation,
} from "@jobctrl/contracts";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../../shared/ui/alert.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  useCareerLearningMutation,
  useCareerLearningQuery,
} from "../hooks/useCareerLearning.js";
import { useJobsListQuery } from "../hooks/useJobsListQuery.js";

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const capabilityLabels = {
  demonstrated: "Supported by confirmed evidence",
  partial: "Partial evidence",
  not_evidenced: "No confirmed evidence in this comparison",
  uncertain: "Uncertain",
} as const;
const staleLabels: Record<string, string> = {
  profile_changed: "Profile changed",
  postings_changed: "Posting sources changed",
  cohort_changed: "Cohort revised",
  job_not_found: "A selected job is no longer available",
};
const statusLabels = {
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  abandoned: "Abandoned",
} as const;

function StaleNotice({ reasons }: { readonly reasons: readonly string[] }) {
  return reasons.length ? (
    <Alert>
      <AlertTitle>Historical comparison — review required</AlertTitle>
      <AlertDescription>
        {reasons.map((reason) => staleLabels[reason] ?? reason).join(" · ")}.
        The saved sources and chosen milestones are retained. Refresh the
        comparison before choosing another proposal.
      </AlertDescription>
    </Alert>
  ) : null;
}

function Citation({
  cite,
  cohort,
  candidate = false,
}: {
  readonly cite: DeterminationCitation;
  readonly cohort: CareerCohort | CareerMilestone["origin"];
  readonly candidate?: boolean;
}) {
  const job = cohort.snapshot.jobs.find(
    (posting) => posting.sourceId === cite.source_id,
  );
  return (
    <li className="grid gap-1">
      {candidate ? (
        <Link
          to="/evidence-map"
          search={{ q: "", job: "", entry: cite.source_id }}
        >
          Achievement {cite.source_id}, confirmed in saved Profile{" "}
          {cohort.snapshot.profileVersion ?? "not saved"}
        </Link>
      ) : job ? (
        <Link to="/jobs" search={{ job: job.jobId }}>
          {job.title} · {job.company}
        </Link>
      ) : (
        <span>No recorded source</span>
      )}
      <blockquote className="m-0 border-l pl-3">{cite.quote}</blockquote>
    </li>
  );
}

function CohortDetails({
  cohort,
  milestones,
  pending,
  act,
  revise,
}: {
  readonly cohort: CareerCohort;
  readonly milestones: readonly CareerMilestone[];
  readonly pending: boolean;
  readonly act: (command: CareerLearningCommand) => void;
  readonly revise: (cohort: CareerCohort) => void;
}) {
  const snapshot = cohort.snapshot;
  return (
    <article
      className="grid gap-4 border p-4"
      aria-label={`Comparison ${cohort.title}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 data-typography="component-title">{cohort.title}</h3>
        <Badge variant="outline">
          Selected as of {cohort.asOf} · revision {cohort.revision}
        </Badge>
      </div>
      <p>
        {snapshot.cohortSize} selected job identities · {snapshot.analyzedCount}{" "}
        distinct postings with descriptions analyzed ·{" "}
        {snapshot.missingDescriptions.length} missing descriptions
      </p>
      <p>
        {snapshot.duplicateSelections.reduce(
          (total, duplicate) => total + duplicate.count - 1,
          0,
        )}{" "}
        repeated selections · {snapshot.duplicateIdentities.length} groups
        sharing recorded application URLs. Exact duplicates count once; other
        duplicates may remain.
      </p>
      <details>
        <summary>Selected postings and duplicate identities</summary>
        <ul className="grid gap-2">
          {snapshot.jobs.map((job) => (
            <li key={job.jobId}>
              <Link to="/jobs" search={{ job: job.jobId }}>
                {job.title} · {job.company}
              </Link>
              {snapshot.missingDescriptions.includes(job.jobId)
                ? " — description missing"
                : ""}
              {snapshot.duplicateIdentities.some((group) =>
                group.includes(job.jobId),
              )
                ? " — shared application identity"
                : ""}
            </li>
          ))}
        </ul>
        {snapshot.duplicateIdentities.map((group) => (
          <p key={group.join(",")}>Duplicate job IDs: {group.join(", ")}</p>
        ))}
      </details>
      <StaleNotice reasons={cohort.staleReasons} />
      {cohort.lastAttempt?.failureCode ? (
        <Alert variant="destructive">
          <AlertTitle>Refresh failed</AlertTitle>
          <AlertDescription>
            {cohort.lastAttempt.failureCode}. This accepted comparison is
            preserved.
          </AlertDescription>
        </Alert>
      ) : null}
      <p>
        {snapshot.confirmedEvidenceCount} confirmed achievement sources compared
        · {snapshot.excludedEvidenceCount} unconfirmed, weak or ambiguous
        evidence records excluded. Profile version{" "}
        {snapshot.profileVersion ?? "not saved"}.
      </p>
      <p>
        <strong>User aspirations:</strong>{" "}
        {cohort.aspirations || "None recorded for this cohort."} Aspirations do
        not establish capability.
      </p>
      <Alert>
        <AlertTitle>Selected-posting observations</AlertTitle>
        <AlertDescription>
          {cohort.comparison.uncertainty} Counts describe this saved cohort.
          They do not estimate the wider market or your readiness.
        </AlertDescription>
      </Alert>
      {cohort.comparison.demands.map((demand) => (
        <section
          key={demand.demand_id}
          className="grid gap-3 border-t pt-3"
          aria-label={`Demand for ${demand.skill}`}
        >
          <h4 data-typography="component-title">{demand.skill}</h4>
          <p>
            {new Set(demand.mentions.map((mention) => mention.source_id)).size}{" "}
            of {snapshot.analyzedCount} analyzed postings mention this demand.
          </p>
          <Badge variant="outline">{capabilityLabels[demand.capability]}</Badge>
          <p>{demand.rationale}</p>
          <p>Uncertainty: {demand.uncertainty}</p>
          <details>
            <summary>Posting source spans ({demand.mentions.length})</summary>
            <ul className="grid gap-3">
              {demand.mentions.map((cite, index) => (
                <Citation key={index} cite={cite} cohort={cohort} />
              ))}
            </ul>
          </details>
          <details>
            <summary>
              Confirmed candidate evidence ({demand.evidence.length})
            </summary>
            {demand.evidence.length ? (
              <ul className="grid gap-3">
                {demand.evidence.map((cite, index) => (
                  <Citation key={index} cite={cite} cohort={cohort} candidate />
                ))}
              </ul>
            ) : (
              <p>
                No confirmed achievement is linked. This does not establish
                inability.
              </p>
            )}
          </details>
        </section>
      ))}
      <section className="grid gap-3" aria-label="Proposed milestones">
        <h4 data-typography="component-title">
          Choose a learning or evidence-building milestone
        </h4>
        <p>
          Each proposal needs your selection. Completing it records activity and
          your evidence statement; profile evidence still requires its own
          review.
        </p>
        {cohort.comparison.proposals.length ? (
          cohort.comparison.proposals.map((proposal) => {
            const chosen = milestones.some(
              (milestone) =>
                milestone.cohortId === cohort.cohortId &&
                milestone.cohortRevision === cohort.revision &&
                milestone.determinationId === cohort.determinationId &&
                milestone.proposal.proposal_id === proposal.proposal_id,
            );
            return (
              <article
                className="grid gap-2 border p-3"
                key={proposal.proposal_id}
              >
                <h5>{proposal.title}</h5>
                <p>
                  {proposal.kind === "learning"
                    ? "Learning"
                    : "Evidence building"}{" "}
                  ·{" "}
                  {
                    cohort.comparison.demands.find(
                      (demand) => demand.demand_id === proposal.demand_id,
                    )?.skill
                  }
                </p>
                <p>{proposal.action}</p>
                <p>Completion criterion: {proposal.completion_criterion}</p>
                <p>{proposal.rationale}</p>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={
                    chosen ? "Milestone chosen" : `Choose ${proposal.title}`
                  }
                  disabled={
                    pending || chosen || Boolean(cohort.staleReasons.length)
                  }
                  onClick={() =>
                    act({
                      action: "choose",
                      cohortId: cohort.cohortId,
                      expectedRevision: cohort.revision,
                      determinationId: cohort.determinationId,
                      proposalId: proposal.proposal_id,
                    })
                  }
                >
                  {chosen ? "Milestone chosen" : "Choose milestone"}
                </Button>
              </article>
            );
          })
        ) : (
          <p>No milestone proposals were returned for this cohort.</p>
        )}
      </section>
      <details>
        <summary>Comparison provenance</summary>
        <dl className="grid gap-1">
          <dt>Compared at</dt>
          <dd>{cohort.comparedAt}</dd>
          <dt>Model</dt>
          <dd>
            {cohort.determination.provider} / {cohort.determination.model}
          </dd>
          <dt>Prompt and schema</dt>
          <dd>
            {cohort.determination.prompt_version} /{" "}
            {cohort.determination.schema_version}
          </dd>
          <dt>Determination and input fingerprint</dt>
          <dd className="break-all">{cohort.determinationId}</dd>
        </dl>
      </details>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() => revise(cohort)}
      >
        Review and refresh this cohort
      </Button>
    </article>
  );
}

function MilestoneEditor({
  milestone,
  act,
  pending,
}: {
  readonly milestone: CareerMilestone;
  readonly act: (command: CareerLearningCommand) => void;
  readonly pending: boolean;
}) {
  const id = useId();
  const form = useForm({
    defaultValues: {
      status: milestone.status,
      completionEvidence: milestone.completionEvidence,
    },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = CareerLearningCommandSchema.safeParse({
          action: "update",
          milestoneId: milestone.milestoneId,
          expectedRevision: milestone.revision,
          ...value,
        });
        return parsed.success ? undefined : parsed.error.issues[0]?.message;
      },
    },
    onSubmit: ({ value }) =>
      act({
        action: "update",
        milestoneId: milestone.milestoneId,
        expectedRevision: milestone.revision,
        ...value,
      }),
  });
  return (
    <article
      className="grid gap-3 border p-4"
      aria-label={`Milestone ${milestone.proposal.title}`}
    >
      <h4>{milestone.proposal.title}</h4>
      <p>{milestone.proposal.action}</p>
      <p>Completion criterion: {milestone.proposal.completion_criterion}</p>
      <Badge variant="outline">{statusLabels[milestone.status]}</Badge>
      <p>
        Chosen {milestone.selectedAt} from {milestone.origin.title} ·{" "}
        {milestone.origin.asOf} · cohort revision {milestone.cohortRevision} ·
        Profile {milestone.origin.snapshot.profileVersion ?? "not saved"}
      </p>
      <StaleNotice reasons={milestone.staleReasons} />
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="status">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-status`}>
                  Milestone status
                </FieldLabel>
                <Select
                  items={Object.entries(statusLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  value={field.state.value}
                  onValueChange={(value) => {
                    if (value && value in statusLabels)
                      field.handleChange(value as CareerMilestone["status"]);
                  }}
                >
                  <SelectTrigger
                    id={`${id}-status`}
                    aria-label="Milestone status"
                  >
                    <SelectValue>{statusLabels[field.state.value]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {Object.entries(statusLabels).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
          <form.Field name="completionEvidence">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-evidence`}>
                  Completion evidence or artifact reference
                </FieldLabel>
                <Textarea
                  id={`${id}-evidence`}
                  value={field.state.value}
                  maxLength={4000}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                />
                <p>
                  Your statement is retained as milestone activity, separate
                  from confirmed capability.
                </p>
              </Field>
            )}
          </form.Field>
        </FieldGroup>
        <form.Subscribe selector={(state) => state.errors}>
          {(errors) =>
            errors.length ? <p role="alert">{errors.join(" ")}</p> : null
          }
        </form.Subscribe>
        <Button type="submit" variant="outline" disabled={pending}>
          Save milestone activity
        </Button>
      </form>
      <details>
        <summary>Retained origin and activity history</summary>
        <p className="break-all">Determination: {milestone.determinationId}</p>
        <p>{milestone.proposal.rationale}</p>
        {milestone.origin.comparison.demands
          .filter((demand) => demand.demand_id === milestone.proposal.demand_id)
          .map((demand) => (
            <div key={demand.demand_id}>
              <p>
                {demand.skill} — {capabilityLabels[demand.capability]}
              </p>
              <ul className="grid gap-2">
                {demand.mentions.map((cite, index) => (
                  <Citation key={index} cite={cite} cohort={milestone.origin} />
                ))}
              </ul>
              <ul className="grid gap-2">
                {demand.evidence.map((cite, index) => (
                  <Citation
                    key={index}
                    cite={cite}
                    cohort={milestone.origin}
                    candidate
                  />
                ))}
              </ul>
            </div>
          ))}
        <ol>
          {milestone.history.map((entry) => (
            <li key={entry.revision}>
              Revision {entry.revision} · {entry.updatedAt} ·{" "}
              {statusLabels[entry.status]} ·{" "}
              {entry.completionEvidence || "No completion evidence recorded"}
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}

function CareerLearningWorkspace() {
  const query = useCareerLearningQuery();
  const mutation = useCareerLearningMutation();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<CareerCohort | null>(null);
  const [preview, setPreview] =
    useState<CareerLearningResponse["preview"]>(null);
  const jobs = useJobsListQuery({ stages: [], q: search, page, pageSize: 20 });
  const id = useId();
  const form = useForm({
    defaultValues: {
      title: "Selected jobs",
      asOf: today(),
      aspirations: "",
      jobIds: [] as string[],
    },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = CareerLearningCommandSchema.safeParse({
          action: "compare",
          expectedRevision: editing?.revision ?? 0,
          ...value,
        });
        return parsed.success ? undefined : parsed.error.issues[0]?.message;
      },
    },
    onSubmit: async ({ value }) => {
      if (!preview) return;
      const parsed = CareerLearningCommandSchema.safeParse({
        action: "compare",
        cohortId: editing?.cohortId ?? null,
        expectedRevision: editing?.revision ?? 0,
        expectedSnapshotFingerprint: preview.fingerprint,
        ...value,
      });
      if (parsed.success) {
        try {
          await mutation.mutateAsync(parsed.data);
          setEditing(null);
        } catch {
          /* Keep the selected cohort and accepted comparison. */
        }
      }
    },
  });
  function revise(cohort: CareerCohort) {
    setEditing(cohort);
    setPreview(null);
    form.setFieldValue("title", cohort.title);
    form.setFieldValue("asOf", cohort.asOf);
    form.setFieldValue("aspirations", cohort.aspirations);
    form.setFieldValue("jobIds", cohort.jobIds);
  }
  if (!query.availability.available)
    return (
      <p>
        {query.availability.reason} Install JobCtrl locally and configure a
        provider to compare selected postings.
      </p>
    );
  const act = (command: CareerLearningCommand) => mutation.mutate(command);
  return (
    <div className="grid min-w-0 gap-5 pt-4 break-words">
      <h2>Review a selected-job cohort</h2>
      <p>
        Choose up to 30 jobs and a selection date. The model compares only their
        saved descriptions with confirmed Career Evidence Map achievements.
        Proposals require your selection. Activity never produces a readiness
        score.
      </p>
      {query.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load saved comparisons</AlertTitle>
          <AlertDescription>
            {query.error.message}
            <Button
              type="button"
              variant="link"
              onClick={() => void query.refetch()}
            >
              Retry saved comparisons
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {mutation.error ? (
        <Alert variant="destructive">
          <AlertTitle>Change was not saved</AlertTitle>
          <AlertDescription>
            {mutation.error.message}. Your draft and previous accepted
            comparison are preserved.
          </AlertDescription>
        </Alert>
      ) : null}
      {query.data?.truncated ? (
        <p role="status">
          Showing the latest 20 cohorts and 100 milestones. Older records remain
          retained in your local workspace.
        </p>
      ) : null}
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <h3>
          {editing
            ? `Refresh ${editing.title} from revision ${editing.revision}`
            : "Create a dated cohort"}
        </h3>
        <FieldGroup>
          {(
            [
              ["title", "Cohort name"],
              ["asOf", "Selection date"],
              [
                "aspirations",
                "Your aspirations (separate from demonstrated capability)",
              ],
            ] as const
          ).map(([name, label]) => (
            <form.Field name={name} key={name}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={`${id}-${name}`}>{label}</FieldLabel>
                  <Input
                    id={`${id}-${name}`}
                    type={name === "asOf" ? "date" : "text"}
                    value={field.state.value}
                    maxLength={
                      name === "title"
                        ? 160
                        : name === "aspirations"
                          ? 2000
                          : undefined
                    }
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            </form.Field>
          ))}
          <Field>
            <FieldLabel htmlFor={`${id}-search`}>
              Find jobs to select
            </FieldLabel>
            <Input
              id={`${id}-search`}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </Field>
          <form.Field name="jobIds">
            {(field) => (
              <FieldSet>
                <FieldLegend>
                  Explicit job selection ({field.state.value.length}/30)
                </FieldLegend>
                {jobs.isPending ? <p>Loading jobs…</p> : null}
                {jobs.error ? (
                  <p role="alert">Could not load jobs: {jobs.error.message}</p>
                ) : null}
                <FieldGroup>
                  {jobs.data?.items.map((job) => (
                    <Field orientation="horizontal" key={job.jobKey}>
                      <Checkbox
                        id={`${id}-${job.jobKey}`}
                        checked={field.state.value.includes(job.jobKey)}
                        disabled={
                          mutation.isPending ||
                          (field.state.value.length >= 30 &&
                            !field.state.value.includes(job.jobKey))
                        }
                        onCheckedChange={(checked) => {
                          setPreview(null);
                          field.handleChange(
                            checked
                              ? [...field.state.value, job.jobKey]
                              : field.state.value.filter(
                                  (key) => key !== job.jobKey,
                                ),
                          );
                        }}
                      />
                      <FieldLabel htmlFor={`${id}-${job.jobKey}`}>
                        {job.title} · {job.company}
                      </FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
                {field.state.value.length ? (
                  <details>
                    <summary>
                      Review selected job IDs or remove unavailable selections
                    </summary>
                    <ul>
                      {field.state.value.map((jobId) => (
                        <li
                          className="flex flex-wrap items-center gap-2"
                          key={jobId}
                        >
                          <code className="break-all">{jobId}</code>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove ${jobId}`}
                            disabled={mutation.isPending}
                            onClick={() => {
                              setPreview(null);
                              field.handleChange(
                                field.state.value.filter((id) => id !== jobId),
                              );
                            }}
                          >
                            Remove selection
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </FieldSet>
            )}
          </form.Field>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous jobs
            </Button>
            <span>
              Page {page} of {jobs.data?.pagination.pages ?? 1}
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={!jobs.data || page >= jobs.data.pagination.pages}
              onClick={() => setPage((value) => value + 1)}
            >
              Next jobs
            </Button>
          </div>
        </FieldGroup>
        <form.Subscribe selector={(state) => state.errors}>
          {(errors) =>
            errors.length ? <p role="alert">{errors.join(" ")}</p> : null
          }
        </form.Subscribe>
        {preview ? (
          <Alert>
            <AlertTitle>
              Review selected cohort before model comparison
            </AlertTitle>
            <AlertDescription>
              {preview.cohortSize} selected job identities ·{" "}
              {preview.analyzedCount} distinct postings with descriptions ·{" "}
              {preview.missingDescriptions.length} missing descriptions ·{" "}
              {preview.duplicateIdentities.length} duplicate identity groups ·{" "}
              {preview.confirmedEvidenceCount} confirmed achievement sources.
              Only these saved sources will be sent to your configured provider.
              Other duplicates may remain.
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => {
              const parsed = CareerLearningCommandSchema.safeParse({
                action: "preview",
                jobIds: form.getFieldValue("jobIds"),
              });
              if (parsed.success)
                void mutation
                  .mutateAsync(parsed.data)
                  .then((response) => setPreview(response.preview))
                  .catch(() => {});
            }}
          >
            Review selected cohort
          </Button>
          <Button
            type="submit"
            disabled={mutation.isPending || !preview?.analyzedCount}
          >
            {mutation.isPending ? "Saving…" : "Compare reviewed postings"}
          </Button>
          {editing ? (
            <Button
              type="button"
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => {
                setEditing(null);
                setPreview(null);
                form.reset();
              }}
            >
              Start a new cohort instead
            </Button>
          ) : null}
        </div>
      </form>
      <div className="grid gap-5" aria-label="Saved cohort comparisons">
        {query.data?.cohorts.map((cohort) => (
          <CohortDetails
            key={`${cohort.cohortId}:${cohort.revision}`}
            cohort={cohort}
            milestones={query.data.milestones}
            pending={mutation.isPending}
            act={act}
            revise={revise}
          />
        ))}
      </div>
      <section className="grid gap-4" aria-label="Chosen milestones">
        <h3>Chosen milestones</h3>
        <p>
          Learning, experience-building activity and completion statements stay
          separate from posting demand, aspirations and confirmed profile
          evidence.
        </p>
        {query.data?.milestones.length ? (
          query.data.milestones.map((milestone) => (
            <MilestoneEditor
              key={`${milestone.milestoneId}:${milestone.revision}`}
              milestone={milestone}
              act={act}
              pending={mutation.isPending}
            />
          ))
        ) : (
          <p>No milestones chosen yet.</p>
        )}
      </section>
    </div>
  );
}

export function CareerLearningPanel() {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="card full p-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Selected-job demand and learning milestones</summary>
      {open ? <CareerLearningWorkspace /> : null}
    </details>
  );
}
