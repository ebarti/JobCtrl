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
