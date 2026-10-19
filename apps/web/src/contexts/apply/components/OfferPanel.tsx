import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useId, useState } from "react";
import { useForm } from "@tanstack/react-form";
import {
  OFFER_CASH_COMPONENTS,
  OFFER_PERIODS,
  SaveOfferTermsSchema,
  RecordOfferDecisionSchema,
  type OfferReadResponse,
  type OfferTerms,
  type OfferTermsRevision,
} from "@jobctrl/contracts";
import type { JobId } from "../../operations/types.js";
import {
  useOfferQuery,
  useOfferCompensationQuery,
} from "../../operations/hooks/useOfferQuery.js";
import { useOfferMutations } from "../hooks/useOfferMutations.js";
import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { Field, FieldGroup, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import { formatDateTime } from "../../../shared/lib/formatters.js";

const CASH_LABELS = {
  base_salary: "Base salary",
  bonus: "Bonus",
  signing_bonus: "Signing bonus",
  commission: "Commission",
  other: "Other cash",
};
const label = (value: string) => value.replaceAll("_", " ");
const localTimestamp = (value: string) =>
  value ? new Date(value).toISOString() : null;
const localInput = (value: string | undefined) =>
  value
    ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";

function Choice<T extends string>({
  id,
  value,
  values,
  onChange,
}: {
  id: string;
  value: T;
  values: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value}
      items={values.map((item) => ({ value: item, label: label(item) }))}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {label(item)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function OfferTermsSummary({ terms }: { terms: OfferTerms }) {
  return (
    <div className="flex flex-col gap-3">
      {terms.cash.length ? (
        <ul>
          {terms.cash.map((cash, index) => (
            <li key={index}>
              {CASH_LABELS[cash.component]}: {cash.amount.toLocaleString()}{" "}
              {cash.currency ?? "currency unknown"} / {label(cash.period)}
              <details>
                <summary>
                  Source for {CASH_LABELS[cash.component].toLowerCase()}
                </summary>
                <SourceText source={cash.source} />
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p>Cash compensation: Unknown</p>
      )}
      <p>Equity: {terms.equity?.value ?? "Unknown"}</p>
      {terms.equity ? <SourceText source={terms.equity.source} /> : null}
      <p>Benefits: {terms.benefits?.value ?? "Unknown"}</p>
      {terms.benefits ? <SourceText source={terms.benefits.source} /> : null}
      <p>
        Decision deadline:{" "}
        {terms.decisionDeadline
          ? formatDateTime(terms.decisionDeadline.value)
          : "Unknown"}
      </p>
      {terms.decisionDeadline ? (
        <SourceText source={terms.decisionDeadline.source} />
      ) : null}
      <details>
        <summary>Offer source</summary>
        <SourceText source={terms.source} />
      </details>
    </div>
  );
}
function SourceText({ source }: { source: OfferTerms["source"] }) {
  return (
    <div className="break-words">
      <p>
        {source.reference} · Captured {formatDateTime(source.capturedAt)} · User
        confirmed
      </p>
      <blockquote className="whitespace-pre-wrap">{source.quote}</blockquote>
    </div>
  );
}

function OfferTermsForm({
  jobId,
  current,
}: {
  jobId: JobId;
  current: OfferTermsRevision | null;
}) {
  const id = useId();
  const mutation = useOfferMutations(jobId).terms;
  const [message, setMessage] = useState("");
  const existing = current?.terms;
  const form = useForm({
    defaultValues: {
      cash: existing?.cash.map((cash) => ({
        component: cash.component,
        amount: String(cash.amount),
        currency: cash.currency ?? "",
        period: cash.period,
      })) ?? [
        {
          component: "base_salary" as (typeof OFFER_CASH_COMPONENTS)[number],
          amount: "",
          currency: "",
          period: "unknown" as (typeof OFFER_PERIODS)[number],
        },
      ],
      equity: existing?.equity?.value ?? "",
      benefits: existing?.benefits?.value ?? "",
      deadline: localInput(existing?.decisionDeadline?.value),
      reference: "",
      quote: "",
      confirmed: false,
      correctionReason: "",
    },
    onSubmit: async ({ value }) => {
      setMessage("");
      const source = {
        reference: value.reference,
        quote: value.quote,
        capturedAt: new Date().toISOString(),
        userConfirmed: value.confirmed,
      };
      let deadline: string | null;
      try {
        deadline = localTimestamp(value.deadline);
      } catch {
        setMessage("Enter a valid deadline or leave it unknown.");
        return;
      }
      const parsed = SaveOfferTermsSchema.safeParse({
        expectedRevisionId: current?.revisionId ?? null,
        terms: {
          source,
          cash: value.cash
            .filter((cash) => cash.amount.trim())
            .map((cash) => ({
              ...cash,
              amount: Number(cash.amount),
              currency: cash.currency.trim().toUpperCase() || null,
              source,
            })),
          equity: value.equity.trim() ? { value: value.equity, source } : null,
          benefits: value.benefits.trim()
            ? { value: value.benefits, source }
            : null,
          decisionDeadline: deadline ? { value: deadline, source } : null,
        },
        ...(current ? { correctionReason: value.correctionReason } : {}),
      });
      if (!parsed.success) {
        setMessage(
          parsed.error.issues[0]?.message ?? "Review the offer fields.",
        );
        return;
      }
      try {
        await mutation.mutateAsync(parsed.data);
        setMessage("Offer terms recorded.");
      } catch {
        /* mutation renders the actionable server error */
      }
    },
  });
  return (
    <details>
      <summary>
        {current ? "Revise offer terms" : "Record actual offer terms"}
      </summary>
      <form
        className="flex flex-col gap-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <p>
          Leave unknown terms blank. Record actual offered amounts with their
          currency and time base. Estimates belong in compensation evidence.
          Confirm that the quoted source supports every entered term.
        </p>
        <FieldGroup>
          <form.Field name="cash" mode="array">
            {(array) => (
              <>
                {array.state.value.map((_cash, index) => (
                  <FieldGroup key={index}>
                    <form.Field name={`cash[${index}].component`}>
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor={`${id}-component-${index}`}>
                            Cash component {index + 1}
                          </FieldLabel>
                          <Choice
                            id={`${id}-component-${index}`}
                            value={field.state.value}
                            values={OFFER_CASH_COMPONENTS}
                            onChange={field.handleChange}
                          />
                        </Field>
                      )}
                    </form.Field>
                    <form.Field name={`cash[${index}].amount`}>
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor={`${id}-amount-${index}`}>
                            Amount {index + 1}
                          </FieldLabel>
                          <Input
                            id={`${id}-amount-${index}`}
                            inputMode="decimal"
                            type="number"
                            min="0"
                            step="any"
                            value={field.state.value}
                            onChange={(event) =>
                              field.handleChange(event.target.value)
                            }
                          />
                        </Field>
                      )}
                    </form.Field>
                    <form.Field name={`cash[${index}].currency`}>
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor={`${id}-currency-${index}`}>
                            Currency {index + 1} (three-letter code; blank if
                            unknown)
                          </FieldLabel>
                          <Input
                            id={`${id}-currency-${index}`}
                            maxLength={3}
                            value={field.state.value}
                            onChange={(event) =>
                              field.handleChange(event.target.value)
                            }
                          />
                        </Field>
                      )}
                    </form.Field>
                    <form.Field name={`cash[${index}].period`}>
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor={`${id}-period-${index}`}>
                            Time base {index + 1}
                          </FieldLabel>
                          <Choice
                            id={`${id}-period-${index}`}
                            value={field.state.value}
                            values={OFFER_PERIODS}
                            onChange={field.handleChange}
                          />
                        </Field>
                      )}
                    </form.Field>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => array.removeValue(index)}
                    >
                      Remove cash component {index + 1}
                    </Button>
                  </FieldGroup>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  disabled={array.state.value.length >= 20}
                  onClick={() =>
                    array.pushValue({
                      component: "bonus",
                      amount: "",
                      currency: "",
                      period: "unknown",
                    })
                  }
                >
                  Add cash component
                </Button>
              </>
            )}
          </form.Field>
          {(["equity", "benefits"] as const).map((name) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={`${id}-${name}`}>
                    {name === "equity"
                      ? "Equity terms (blank if unknown)"
                      : "Benefits (blank if unknown)"}
                  </FieldLabel>
                  <Textarea
                    id={`${id}-${name}`}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </Field>
              )}
            </form.Field>
          ))}
          <form.Field name="deadline">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-deadline`}>
                  Decision deadline (your local time; blank if unknown)
                </FieldLabel>
                <Input
                  id={`${id}-deadline`}
                  type="datetime-local"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="reference">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-reference`}>
                  Offer source reference
                </FieldLabel>
                <Input
                  id={`${id}-reference`}
                  placeholder="Offer letter or message reference"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="quote">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-quote`}>
                  Verbatim offer source quote
                </FieldLabel>
                <Textarea
                  id={`${id}-quote`}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          {current ? (
            <form.Field name="correctionReason">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={`${id}-reason`}>
                    Terms revision reason
                  </FieldLabel>
                  <Input
                    id={`${id}-reason`}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </Field>
              )}
            </form.Field>
          ) : null}
          <form.Field name="confirmed">
            {(field) => (
              <Field orientation="horizontal">
                <Checkbox
                  id={`${id}-confirmed`}
                  checked={field.state.value}
                  onCheckedChange={field.handleChange}
                />
                <FieldLabel htmlFor={`${id}-confirmed`}>
                  I confirm these are actual offered terms supported by this
                  source.
                </FieldLabel>
              </Field>
            )}
          </form.Field>
        </FieldGroup>
        {message ? <p role="status">{message}</p> : null}
        {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving terms…" : "Save confirmed offer terms"}
        </Button>
      </form>
    </details>
  );
}

function OfferDecisionForm({
  jobId,
  data,
}: {
  jobId: JobId;
  data: OfferReadResponse;
}) {
  const id = useId();
  const mutation = useOfferMutations(jobId).decision;
  const [message, setMessage] = useState("");
  const form = useForm({
    defaultValues: {
      decision: "accepted" as "accepted" | "declined",
      reference: "",
      quote: "",
      occurredAt: "",
      correctionReason: "",
      confirmed: false,
    },
    onSubmit: async ({ value }) => {
      const parsed = RecordOfferDecisionSchema.safeParse({
        expectedDecisionId: data.currentDecision?.decisionId ?? null,
        termsRevisionId: data.currentTerms?.revisionId,
        decision: value.decision,
        occurredAt: value.occurredAt
          ? localTimestamp(value.occurredAt)
          : new Date().toISOString(),
        source: {
          reference: value.reference,
          quote: value.quote,
          capturedAt: new Date().toISOString(),
          userConfirmed: value.confirmed,
        },
        ...(data.currentDecision
          ? { correctionReason: value.correctionReason }
          : {}),
      });
      if (!parsed.success) {
        setMessage(parsed.error.issues[0]?.message ?? "Review your decision.");
        return;
      }
      try {
        await mutation.mutateAsync(parsed.data);
        setMessage("Offer decision recorded. No message was sent.");
      } catch {
        /* preserve form for retry */
      }
    },
  });
  return (
    <details>
      <summary>
        {data.currentDecision
          ? "Correct offer decision"
          : "Record offer decision"}
      </summary>
      <form
        className="flex flex-col gap-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="decision">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-decision`}>
                  Offer decision
                </FieldLabel>
                <Choice
                  id={`${id}-decision`}
                  value={field.state.value}
                  values={["accepted", "declined"] as const}
                  onChange={field.handleChange}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="occurredAt">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-occurred`}>
                  Decision occurred at (local time; blank for now)
                </FieldLabel>
                <Input
                  id={`${id}-occurred`}
                  type="datetime-local"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="reference">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-reference`}>
                  Decision source reference
                </FieldLabel>
                <Input
                  id={`${id}-reference`}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="quote">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-quote`}>
                  Decision evidence or your attestation
                </FieldLabel>
                <Textarea
                  id={`${id}-quote`}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          {data.currentDecision ? (
            <form.Field name="correctionReason">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={`${id}-reason`}>
                    Decision correction reason
                  </FieldLabel>
                  <Input
                    id={`${id}-reason`}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </Field>
              )}
            </form.Field>
          ) : null}
          <form.Field name="confirmed">
            {(field) => (
              <Field orientation="horizontal">
                <Checkbox
                  id={`${id}-confirmed`}
                  checked={field.state.value}
                  onCheckedChange={field.handleChange}
                />
                <FieldLabel htmlFor={`${id}-confirmed`}>
                  I attest to this offer decision on the current terms.
                </FieldLabel>
              </Field>
            )}
          </form.Field>
        </FieldGroup>
        {message ? <p role="status">{message}</p> : null}
        {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Recording decision…" : "Save offer decision"}
        </Button>
      </form>
    </details>
  );
}

function OfferComparison({ jobId }: { jobId: JobId }) {
  const query = useOfferCompensationQuery(jobId);
  const posted = query.data?.posted;
  const market = query.data?.market;
  const fact = posted?.recordStatus === "recorded" ? posted.fact : null;
  const estimate = market?.recordStatus === "recorded" ? market.estimate : null;
  return (
    <details>
      <summary>Compare with existing compensation evidence</summary>
      <p>
        Actual terms above remain separate from posting evidence and market
        estimates. Amounts are shown in their recorded currency, component and
        time base; no conversion, equity valuation or total is inferred.
      </p>
      {query.error ? (
        <p role="alert">
          Compensation evidence could not be read: {query.error.message}
        </p>
      ) : null}
      <p>
        Posting evidence:{" "}
        {fact?.parseState === "parsed_range"
          ? `${fact.minimumAmount ?? "Unknown"}–${fact.maximumAmount ?? "Unknown"} ${fact.currency ?? "currency unknown"} / ${fact.period} (${label(fact.component)})`
          : (fact?.parseState ?? posted?.recordStatus ?? "Loading")}
      </p>
      {fact ? (
        <p className="whitespace-pre-wrap">
          Source: {fact.sourceText ?? "Unknown"}
        </p>
      ) : null}
      <p>
        Market estimate:{" "}
        {estimate?.estimateState === "estimated_range"
          ? `${estimate.minimumAmount}–${estimate.maximumAmount} ${estimate.currency} / ${estimate.period} (${label(estimate.component)})`
          : (estimate?.estimateState ?? market?.recordStatus ?? "Loading")}
      </p>
      {estimate ? (
        <>
          <p>
            Estimated {formatDateTime(estimate.estimatedAt)} · Confidence{" "}
            {estimate.confidenceBand}
          </p>
          <ul>
            {estimate.sources.map((source, index) => (
              <li key={index}>
                {source.displayName} · {source.snapshotVersion}
              </li>
            ))}
          </ul>
          <ul>
            {estimate.warnings.map((warning, index) => (
              <li key={index}>{warning.message}</li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  );
}

export function OfferPanel({ jobId }: { jobId: JobId }) {
  const query = useOfferQuery(jobId);
  const data = query.data;
  const { featureFlags } = usePorts();
  const available = getApiCapabilityAvailability(
    featureFlags,
    "jobOffer",
  ).available;
  if (!available)
    return (
      <p>
        Actual offer terms and decisions are available in your private local
        workspace. <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
      </p>
    );
  return (
    <section
      aria-label="Offer terms and decisions"
      className="flex flex-col gap-4"
    >
      <h3>Offer terms and decisions</h3>
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {!data && !query.error ? <Empty title="Loading offer record." /> : null}
      {data ? (
        <>
          {data.currentTerms ? (
            <OfferTermsSummary terms={data.currentTerms.terms} />
          ) : (
            <p>No actual offer terms recorded.</p>
          )}
          <p>
            Offer decision: {data.currentDecision?.decision ?? "Not recorded"}
          </p>
          {data.currentDecision &&
          data.currentDecision.termsRevisionId !==
            data.currentTerms?.revisionId ? (
            <p role="status">
              This decision refers to earlier terms. Review the revised terms
              before confirming a new decision.
            </p>
          ) : null}
          <OfferTermsForm
            key={data.currentTerms?.revisionId ?? "new"}
            jobId={jobId}
            current={data.currentTerms}
          />
          {data.currentTerms ? (
            <OfferDecisionForm
              key={`${data.currentTerms.revisionId}:${data.currentDecision?.decisionId ?? "new"}`}
              jobId={jobId}
              data={data}
            />
          ) : null}
          {data.currentTerms ? <OfferComparison jobId={jobId} /> : null}
          {data.termsHistory.length || data.decisions.length ? (
            <details>
              <summary>Offer history</summary>
              <ol>
                {data.termsHistory.map((revision) => (
                  <li key={revision.revisionId}>
                    <p>
                      Terms recorded {formatDateTime(revision.recordedAt)} ·{" "}
                      {revision.correctionReason ?? "Initial offer"}
                    </p>
                    <OfferTermsSummary terms={revision.terms} />
                  </li>
                ))}
              </ol>
              <ol>
                {data.decisions.map((decision) => (
                  <li key={decision.decisionId}>
                    <p>
                      {decision.decision} ·{" "}
                      {formatDateTime(decision.occurredAt)} ·{" "}
                      {decision.correctionReason ?? "Initial decision"}
                    </p>
                    <SourceText source={decision.source} />
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
