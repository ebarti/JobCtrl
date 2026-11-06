# Outreach

Outreach owns reviewed message generations, user-attested send history and
surfaced reminders. It consumes immutable public Contacts/Profile snapshots and
optional Jobs, Offers, Compensation and Applications ports. It never reads their
private tables. Contacts has no dependency on this package.

The retained capability inventory is:

- Generate a source-bound message, or verify an exact user-edited replacement.
  Draft composition, exhaustive claim verification and independent quality review
  use the real model gateway with lane/spend preflight. Edits run both review
  calls again; they cannot inherit an earlier pass. Strict source/line IDs and
  verbatim citations are mechanical checks; model determinations own meaning.
- Persist claim provenance, line anchors, model receipts and the exact public
  source revisions. Approval joins the stored claim/quality records and checks
  the actual message text. Failed/invalid refreshes retain the last approved
  generation. A failed quality verdict can be inspected but cannot be approved.
- Bind revisions to the explicitly selected `sourceDraftId`, preserve its kind
  and exact offer revision, and compare `expectedFingerprint` for thread writes.
  A completed proposal loses publication authority if its thread, recipient,
  Profile, posting, offer or compensation sources change during verification.
  The 409 response carries the unpublished text and completed reviews for user
  reconciliation; it never replaces accepted history.
- Preserve offer negotiation, clarification, acceptance and decline drafts.
  Unknown terms remain unknown. Acceptance/decline requires the matching
  user-attested decision on the exact current terms. Compensation stays labelled
  as posting/market evidence and never becomes an employer offer.
- Copy only a currently approved, mechanically valid message after final
  source/version checks through the copy endpoint. **There is no external send
  transport.** The user operates their channel separately.
- Record an explicit send attestation with request UUID, approved draft, channel
  label and date. Exact retries return the original durable receipt before
  current-source checks. Reusing the identity for changed input conflicts. A
  replay does not add an event or restore older approvals/reminders. An uncertain
  acknowledgement therefore never requires another external action.
- Schedule, complete and dismiss reminders with a thread fingerprint. Date-only
  values retain their precision. Suggestions use the actual application
  submission plus seven calendar days, or the previous reminder plus fourteen;
  no suggestion is inferred after a reply or without a submission anchor. An
  explicit manual due date remains available. Reading due reminders never acts
  on them.
- Replay a durable generation/revision using its publication receipt after a
  worker crash. The same action identity cannot mint another canonical generation
  after publication but before acknowledgement; the receipt points to the
  original draft while the response reads the current thread.

`http.py` retains the contact outreach and thread draft/review/send-log/follow-up
routes. It adds thread detail and a checked draft `/copy` endpoint.
`thread.fingerprint` is required as `expectedFingerprint` for revision, review,
copy and reminder commands. Conflicts use the foundation's standard 409
`revision_conflict` error envelope. `outreach.generate` and `outreach.revise`
expose these same application actions to durable dispatch.
A draft's `/determinations` read is scoped to its thread/draft membership and
exposes exact persisted instructions, schema, context, sources, provider receipt
and result. Missing records remain explicitly unavailable; the reader never
reconstructs a model verdict from message text or recipient identity.
Availability (`complete`/`available`) is separate from verified authority. The
reader joins each gateway receipt, checks status/provenance/exact output, and
recomputes its input fingerprint from the saved prompt/schema/context/sources
using the recorded provider/model. Receipt contexts bind the public source
revisions and exact reviewed body. An authentic failed-quality review remains
verified while blocked by its verdict; missing or mismatched receipt authority
blocks approval, copy and fresh send attestations.

Only `outreach_*` tables are read by this package's SQLite adapter. Generated
messages, facts, model results and source snapshots never appear in event
payloads. Events invalidate the feature's public reads using IDs and state.
The target recurring real-application journeys are in
`apps/web/e2e/journeys/optional.spec.ts`; their only controlled seams are external
providers. No messages or applications are sent by Outreach QA.
