# Profile authoring boundary

Profile owns factual sources, authored achievements, exact wording text and user
approval. Fit supplies an immutable source-bound authoring brief; Profile never
discovers requirements, computes person qualification or approves its own text.
`request_authoring` retains every origin and returns a prior exact request without
another model call. Pending wording is separate from approved wording and cannot
become factual authority.

An optional `expected_approved_variants` inventory fences both authoring
transactions against the exact public approved inventory. Publication also
validates factual revisions and every referenced source. Proposal-only revisions
do not invalidate another pending request. A changed fact or approved inventory,
invalid result, provider failure or cancellation preserves accepted wording.

The existing explicit durable `profile.author_wording` action can supply
`retry_of_proposal_id` for a known failed or semantically uncertain attempt.
Retries require a new origin, the same achievement and exact source revisions,
and unchanged opaque group/gap bindings. The new brief records the previous
proposal and origin in `origin_metadata.retry_of_proposal_id` and
`retry_of_origin_key`. Profile checks eligibility and lineage before inference
and again in the publication transaction. A prior attempt can have one successor;
retry that successor deliberately if it also fails. Approved, pending, rejected,
deferred and valid unsupported outcomes cannot be retried through this option.
No ordinary read or save dispatches authoring or retries.

`get_authoring_proposal(include_brief=True)` exposes the retained immutable public
brief without process metadata. `follow_retry=True` projects the latest linked
attempt without deleting or rewriting its ancestors. A read that proves the
recorded owner is absent projects `status=failed`, `recorded_status=generating`,
`interrupted=true` and `failure_code=authoring_interrupted`; it does not mutate
the retained attempt or dispatch work. Explicit
`recover_interrupted=True` uses the
recorded owner's actual process liveness to recover an interrupted generating
request to its retained failed state, without model work. A live or unverifiable
owner remains generating and cannot be retried. Missing provider acknowledgement
remains an unknown prior remote outcome; an explicitly authorized successor does
not change or erase that history. Fit owns manual retry selection and operation
budgets, while Profile continues to require user approval of any resulting text.
The existing wording library read exposes safe attempt and lineage IDs, source
gap IDs and status; it does not expose the recorded process owner.

## Manual revision and experience recovery

The HTTP adapter exposes `PATCH /v1/profile/wording/{variant_id}` for pending
drafts only. `expectedProfileVersion`, `expectedVariantRevision` and `exactText`
fence the new `text`; a reviewed variant is not mutated. Earlier pending
revisions are retained. `GET .../{variant_id}/history` returns exact retained
revisions plus the current one without approving or restoring text.

Creating a proposed revision through `POST /v1/profile/wording` can retain
`replacesVariantId`, `replacesVariantRevision` and `intendedRequirementIds`.
Source/variant fences preserve lineage and accepted wording; intended requirement
IDs are user intent, not semantic coverage. Model-authoring provenance retains
its recorded group/action/replacement IDs separately. Profile owns text and exact
review; Fit owns recorded current requirement/wording relationships. The
[11 November decision](../../../../../../docs/decisions.md#_2026-11-11-requirement-led-current-wording-and-proposed-revisions)
requires reuse/consolidation before another maintained wording and keeps proposed
revisions/history separate from the current expression.

`GET /v1/profile/recovery` inventories removed roles/achievements from retained
Profile versions. `POST /v1/profile/recovery/restore` requires
`expectedProfileVersion`, `sourceProfileVersion`, `kind` and exact original `id`.
It inserts only that absent record into the latest saved document. Restore a
removed parent role before its achievement; changed/recovered records refuse a
stale request. Original identity and retained wording/source history survive,
without replacing concurrent authored edits or accepted resume bytes.

Search location metadata remains Profile-owned. Optional
`experience.target_location_bindings` joins each zero-based `rowIndex` and exact
saved text to its user-selected Photon place identity, coordinates and selection
provenance. Changed text/position clears stale bindings; old text-only rows remain
unverified. This is structural/source metadata, not geographic qualification or
search permission inferred from past employment. Reads/saves perform no lookup,
assessment, automatic refresh or document regeneration.
