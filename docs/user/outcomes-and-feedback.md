# Outcomes & Feedback

An outcome records what happened after an application: for example, a reply,
interview, rejection, offer, withdrawal or no response. A reviewed outcome is
distinct from an automation run and from an unreviewed email suggestion.

::: info Python transformation in progress
The flows below describe the accepted target and current Applications/Offers
feature contracts. Integrated web, worker and installed-runtime verification is
still pending; see [Getting Started](getting-started.md) for the published version.
:::

## Retrying A Manual Record

Record the outcome, its time and an optional local note. A retry using the same
request identity and unchanged input returns the recorded result rather than
creating another entry. Reusing that identity for different values is a
conflict. If acknowledgement was lost, inspect the saved timeline before
starting a separate action; the first one may already be present.

An interview reflection can be linked to the relevant accepted preparation;
independent question notes remain separate from outcome history. Neither notes
nor a completed activity becomes a confirmed Profile fact or a Fit assessment.

## How Email Becomes An Outcome Suggestion

1. You start a bounded Gmail scan of known application and outcome anchors.
   Recipient and time-window checks limit the search. In the current Python
   command, defaults are 20 anchors, up to 10 results per anchor and a 45-day
   window; the scan may miss messages outside those bounds.
2. A source-bound model decision links message metadata to one application
   before the body is read. Uncertain or unrelated metadata does not establish
   a match.
3. A separate source-bound decision classifies a linked body and cites the
   relevant text. The result is a suggestion, not a reviewed outcome.
4. You accept, correct or ignore the suggestion. Accepting or correcting can
   record an outcome; ignoring records the decision without inventing one.

Evidence and each message's decisions commit independently. A later failure
preserves earlier committed suggestions and reviewed records. If a response is
lost, progress may be unknown until inspection or retry; an already ingested
message is not a new outcome. Message bodies, quotes and private rationale stay
in scoped local reads, not general activity, events or progress responses. The
suggestion audit can show its saved source and model authority without rerunning
it. See [Apply](apply.md#gmail-connector-and-sending-boundary) for account and
send boundaries.

## Explicit Feedback Learning

Your corrections, reviewed outcomes, Discovery feedback and materials decisions
retain their own sources and history. Any recommendation that changes a saved
policy requires your explicit decision; recording an outcome does not silently
rewrite a score, Profile fact, accepted artifact or application approval.
Learning milestones, aspirations and posting demand are not evidence of a
capability. The retained feedback-learning workflow remains subject to
integrated verification in the transformation.

## What You Can See And Control

The Original source candidate keeps the outcome timeline and pending suggestions
in the selected job's application context. **Jobs → Outcomes** summarizes
recorded data without requiring an operations dashboard. Counts describe the
records present; conversion rates and response-time medians are sample-gated
and descriptive, not proof that a particular action caused an outcome. A
suggestion is decided once; a conflicting decision must be reviewed against the
latest saved state. The [API reference](../api/complete-contract.md#feedback-learning-and-policy-history)
identifies the owning routes.

## Source Of Truth And Ownership

Applications owns reviewed outcomes, Gmail evidence and suggestions. A confirmed
application fact, including a matching provider receipt or an explicit reviewed
application confirmation, is different from an unconfirmed email suggestion.
A manual outcome can document what happened after an uncertain send, but it does
not erase the original submit intent or make an automatic retry safe.

Interviews owns preparation and notes; Fit owns person qualification and
corrections; Offers owns actual offer terms and decisions. Composed reads use
those public owners without making the dashboard an alternate writer. General
events carry identifiers and state, not private notes or message bodies.

## Actual Offer Terms And Decisions

Record actual terms from an employer's letter, message or your attested
conversation. Each entry carries a source reference, quotation and your explicit
confirmation. Currency, time base, equity, benefits and deadlines remain unknown
when they are not provided; JobCtrl must not invent a valuation, exchange rate,
annualization or total package. Market compensation estimates are separate from
the employer's actual terms.

Changing terms or correcting an accept/decline decision requires the current
revision or decision and a reason; prior terms and decisions remain visible.
A decision bound to old terms does not silently approve revised terms. The first
terms may also create an idempotent offer milestone when Applications is present.
These actions do not submit an application. Offer-related communications follow
the separate [Outreach review flow](contacts-and-outreach.md#offer-communications).

## Implementation And API Pointers

The Python owner in `features/applications/feedback.py` declares outcome reads,
idempotent manual writes, suggestion decisions, audit and user-started scans;
`features/applications/http.py` declares their `/v1/outcomes` and per-job
routes. Offers owns `/v1/jobs/{id}/offer`. See [feature reads](../architecture/read-model.md)
and [local API](../api/complete-contract.md#apply-review-and-outcomes). Route
declarations and controlled-provider proof are not evidence of live Gmail
access or completed integrated release behavior.
