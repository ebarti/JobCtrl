# Demo Access, Consent Withdrawal, And Visitor Erasure Proposal

- **Date:** 2026-09-22
- **Status:** **PROPOSED — awaiting owner decision**
- **Related issue:** [#885](https://github.com/ebarti/JobCtrl/issues/885)
- **Scope:** Design for the hosted synthetic demo at `demo.jobctrl.dev`.
- **Authority:** This document recommends a future contract. It is not an owner
  decision, implementation authorization, legal conclusion, merge approval,
  deployment approval, or production-data operation.

## Reading This Proposal

The labels below keep source evidence separate from recommendations:

- **CURRENT** describes source and documentation at
  `6a82c233c434e67f0a2d1c6df3db6aa68d036b75`. It does not claim that a live
  production path was exercised.
- **RECOMMENDED** is the proposed design. Every recommendation remains subject
  to the owner choices in this document and a separate implementation scope.
- **FUTURE VERIFICATION** is evidence a later implementation must produce. No
  future check listed here has run.

This proposal makes no legal-compliance finding. Product implementation and
any legal/privacy approval are separate gates. The implemented public-demo plan
also preserves that distinction: D5 deferred withdrawal and erasure, and D6
requires privacy-owner approval for operational measurement and removal of that
lane if it is rejected. It does not permit replacing rejected measurement with
identifiers.

## Current Boundary

**CURRENT — source-traced, not production-verified:**

1. The browser renders a static consent shell before mounting the demo. A
   confirmed v2 grant mounts the demo, creates `DemoTelemetryAdapter`, and
   loads Google Analytics. Decline records a best-effort aggregate choice and
   redirects to `jobctrl.dev`. A consent-service read failure leaves the shell.
2. The edge service accepts an identity-free denial but rejects an
   identity-bearing denied POST with `409`. Consent GET, health, and telemetry
   require the applicable active visitor/session pair. A missing or inactive
   pair makes GET clear stale cookies; it does not delete retained rows.
3. A valid repeated grant refreshes the active identity. A grant with a valid
   active visitor but no session creates another session for that visitor.
   Multiple sessions can therefore remain active for one visitor.
4. The consent cookie is browser-readable. Visitor and session cookies are
   `HttpOnly`. All are host-only, `Secure`, `Path=/`, and `SameSite=Lax`.
   Consent and visitor cookies have a fixed lifetime of 180 days minus two
   hours; the session cookie has no `Max-Age`.
5. The event insert checks the active pair inside the insert statement. Raw
   product events and aggregate operational counters expire within 90 days
   minus the retention safety margin. Retry digests and rate rows expire within
   24 hours minus that margin. The scheduled retention job runs hourly.
6. A fresh grant blocks if its required operational counter or identity write
   fails. Telemetry and denial-counter failures are best effort. Health requires
   a grant, but its later failure does not unmount the accepted demo.
7. Browser telemetry sends immediately with `keepalive` and has no withdrawal
   lifecycle. The Google loader enables the tag but has no corresponding
   unload path. Current public documentation accurately says post-accept
   withdrawal and immediate visitor-event deletion are unavailable.

No production request, cookie, D1 row, browser profile, deletion, or deployment
was inspected for this proposal.

## Owner Decisions

The owner must record every decision below before implementation. Selecting a
recommendation accepts its product and operational cost; it still does not
constitute legal approval or implementation authority.

| ID | Decision | Recommended choice | Explicit alternatives | Cost and tradeoff |
| --- | --- | --- | --- | --- |
| `DP-885-01` | Optional demo access | Make the full synthetic demo available without analytics. Present equal **Continue without analytics** and **Choose analytics** paths. | Keep the current acceptance-required gate; or remove the hosted demo. | Optional access requires decoupling app bootstrap from measurement. Keeping the gate is cheaper but preserves the concern tracked by #885. Removing the demo eliminates this measurement boundary and its public value. |
| `DP-885-02` | First-party product analytics purpose | Offer a separate, default-off first-party opt-in. | Bundle it with GA in one default-off analytics opt-in; or remove first-party product analytics. | Separation gives purpose-level choice and more UI/state combinations. Bundling is simpler but less granular. Removal loses consented route/action evidence. |
| `DP-885-03` | Google Analytics purpose | Offer a separate, default-off Google opt-in. | Bundle it with first-party analytics in one default-off choice; or remove GA from the demo. | Separate GA control is clearest but must manage a third-party lifecycle independently. Bundling is simpler. Removal avoids the GA teardown and third-party deletion boundary. |
| `DP-885-04` | Withdrawal versus deletion | Withdrawal stops future collection and revokes every active session for the currently identified visitor. A separate **Delete this browser's demo events** action also erases live visitor-linked rows. | Make withdrawal also delete; or provide withdrawal only and retain rows to expiry. | Separate actions keep prospective choice distinct from destructive erasure, but require plain disclosure and two controls. Combining them is simpler and more destructive. Withdrawal-only leaves the current erasure gap. |
| `DP-885-05` | Receipt, recovery, and identification scope | Issue a bounded opaque `HttpOnly` erasure capability only when a first-party visitor is created. Keep it after analytics withdrawal solely for deletion/status. | Expire all linkage on withdrawal and make later erasure impossible; or require a manually mediated support path. | The capability preserves narrow erasure authority without a telemetry identifier. It creates another sensitive lifecycle to secure and retain. Losing it limits automated erasure to data the browser can still identify. |
| `DP-885-06` | Retention and backup restoration | Use the limits in [Retention](#retention), plus a bounded external recovery-suppression manifest replayed before a restored D1 can serve. | Choose shorter limits; remove retained analytics; or block restore/launch until another resurrection-safe design is approved. | Suppression adds operational recovery work and a separate protected record. Omitting it risks restored rows reappearing after a claimed deletion. |
| `DP-885-07` | Operational metrics | If separately approved, keep only minimized, non-linkable, best-effort daily counters; they never block access or a privacy action. | Remove the operational lane and scope health/choice analysis to consented traffic; never replace it with an identifier. | Kept counters help detect coarse service failures but cannot measure unique people or a nonconsenting funnel. Removal reduces data and operating complexity. |
| `DP-885-08` | Capability lifetime | **Proposal recommendation, not accepted policy:** choose a fixed 270-day lifetime from each explicit first-party grant: the 180-day maximum visitor collection window plus the 90-day maximum event-retention tail, with no passive renewal. | A shorter disclosed lifetime; no self-service post-withdrawal erasure capability; or shorter event/identity retention that preserves full coverage with a shorter capability. | Full-tail coverage retains deletion authority longer. A shorter capability reduces authority retention but can make automated erasure unavailable while retained events still exist; the UI and notice must expose that gap rather than promise a button. |
| `DP-885-09` | Recovery-suppression lifetime | Retain suppression entries for 35 days: the currently documented 30-day paid D1 Time Travel horizon plus a five-day restore-verification buffer. Block launch if configured backup horizons exceed it. | A different explicit horizon-plus-buffer bound; or disable restore of visitor-linked data. | The entry may outlive live event rows after deletion, but prevents a restore from resurrecting them. The bound must change deliberately if backup configuration changes. |

## Recommended Experience

### Entry and purpose choices

**RECOMMENDED:** The first screen gives two equally prominent actions:

- **Continue without analytics** mounts the complete synthetic demo without a
  first-party visitor/session identity and without loading GA.
- **Choose analytics** opens two independent switches, both off by default:
  **Share first-party demo usage** and **Share usage with Google Analytics**.
  Saving all switches off is equivalent to continuing without analytics.

Denied, unknown, and access-only states create no tracking identifier. A small,
non-identifying versioned preference may remember that all purposes are off,
subject to `DP-885-07`; it cannot encode a visitor, session, request, or
fingerprint. The demo must never infer either grant from entry, prior v2 access,
another purpose, or a missing response.

A persistent **Privacy settings** control remains available from every demo
route. It shows each purpose independently and exposes withdrawal, deletion,
and local synthetic reset as different actions. The documentation site at
`jobctrl.dev` remains a separate host, consent contract, and storage boundary;
its cookie settings neither grant nor withdraw demo purposes.

### Withdrawal

**RECOMMENDED:** Turning a purpose off first writes a local pending-deny marker,
stops that adapter, and prevents queued or newly resolved work from replaying.
For first-party analytics, the server then atomically revokes every active
session in the currently identified visitor generation. Withdrawal alone keeps
prior events until their disclosed retention deadline. The UI says so before
confirmation.

The browser retains the first-party visitor/session cookies only while server
withdrawal is pending because the erasure capability is intentionally not
authorized for withdrawal. The local pending-deny marker disables every
application use of those cookies for telemetry, health, or grant replay; the
only allowed application request is the same idempotent withdrawal retry. The
server may still consider the pair active while the browser is offline, which
the pending state must disclose. After confirmed server revocation, the browser
expires both tracking cookies and retains only the bounded erasure capability,
if one exists. An offline or failed request leaves the control in **Stopped
here; server withdrawal pending** and retries with the same operation key. It
must not report server completion from a timeout, `429`, `503`, malformed
response, or lost response.

Turning GA off applies the strictest supported consent-denied command before
preventing new application calls and reloading the demo to clear executable
tag state. Already transmitted Google data is outside the first-party D1
deletion transaction. Cookie deletion cannot erase data GA has already
received, and an offline, frozen, or already transmitting third-party context
prevents any promise of instant global cessation.

### Deletion

**RECOMMENDED:** **Delete this browser's demo events** is a separately
confirmed action. It immediately performs local stop, revokes all sessions for
the currently identified visitor, and transactionally deletes live
visitor-linked data. It does not claim to find rotated historical visitors,
other browsers, other devices, lost cookies, or people. It does not use IP,
user agent, behavioral matching, fingerprinting, or a client-supplied visitor
target to recover linkage.

The action deletes, as one live-D1 transaction:

1. all `consented_product_events` rows for the capability-bound visitor;
2. every `active_demo_identities` row for that visitor and generation, after
   capturing all of its session hashes inside the transaction;
3. every `telemetry_rate_windows` row for those sessions, plus every future
   visitor/session-scoped rate or retry row introduced by the next contract;
4. superseded first-party consent/generation state for that visitor; and
5. the live erasure-operation receipt state only after a durable bounded status
   and recovery-suppression record exists.

`telemetry_global_rate_windows`, `operational_rate_windows`,
`operational_retry_digests`, and non-linkable operational aggregates have no
visitor key and therefore cannot be selected as this visitor's data. Their
continued use depends on `DP-885-07`; the disclosure must say they are not part
of visitor erasure. No future visitor/session-scoped row may be omitted merely
because its table was added after this proposal.

Cloudflare D1 `batch()` executes statements sequentially and rolls the sequence
back when a statement fails. The future implementation must use that atomic
boundary, or another demonstrated D1 transaction boundary, rather than a loop
of independently committed deletes. A database error or rate limit keeps the
operation pending/failed and never produces a success receipt.

Deletion uses a capability-bound idempotency key. Retrying the same operation
returns the same terminal result. When the response is lost, a capability-only
status endpoint reports `pending`, `completed`, or a retryable failure without
accepting a visitor identifier from the client. If read replicas are enabled,
the mutation returns a D1 Session bookmark and the follow-up status read uses a
Session with that bookmark so the receipt cannot regress behind the write.

## Identity, Capability, And Storage Contract

### Bounded erasure capability

**RECOMMENDED:** The first successful first-party grant with no valid capability
mints a random opaque erasure capability alongside the first visitor
generation. The browser receives it only as a host-only, `Secure`, `Path=/`,
`SameSite=Lax`, `HttpOnly` cookie. The edge stores only a keyed digest and its
bound visitor hash/generation. The capability:

- is accepted only by deletion and deletion-status routes;
- is never read by telemetry, health, reporting, GA, or operational counters;
- cannot grant access, grant analytics, revive a generation, or select a
  client-provided target;
- has a fixed owner-chosen lifetime with no passive sliding renewal;
- is atomically replaced on a later explicit first-party grant: the new digest
  inherits the same still-addressable visitor and bound generations, adds the
  new generation, receives a new fixed lifetime under `DP-885-08`, and revokes
  the old digest before the browser receives its one replacement cookie;
- is cleared after confirmed deletion or fixed expiry.

This is an intentional tradeoff: keeping narrow authority enables deletion
after tracking cookies are expired, but retaining any capability extends the
period in which that browser can request a destructive action. If the cookie
is cleared or expires, the service cannot reconstruct linkage. A valid current
capability addresses the bound visitor, the explicitly bound generations, and
all their sessions. A visitor/capability that expired or was rotated before
that binding is a historical visitor and cannot be recovered. Cross-device
identities are also not addressable.

The server never leaves a replaced capability valid but inaccessible behind a
single cookie, and the browser never accumulates a cookie per generation.
Replacement is allowed only for an explicit first-party grant and revokes the
old digest in the same transaction. After fixed expiry, the privacy UI must not
display a functioning deletion promise for retained rows it can no longer
identify. If the owner chooses less than full-tail coverage, the disclosure
must state the exact self-service window and the remaining retention tail.

Replacement inherits only the prior generations explicitly named in that same
transaction. Revoking the old digest makes every omitted prior generation
unavailable to the new capability; no later join, fingerprint, or hidden
server-side capability may recover it. The implementation and disclosure must
treat that as lost erasure reach, not silently imply that one browser cookie
still covers it.

### Cookie and browser-storage matrix

Names are descriptive placeholders. A later implementation must choose and
review exact names without treating this proposal as a schema allocation.

| State | Storage | Purpose | Proposed lifetime and access | Privacy behavior |
| --- | --- | --- | --- | --- |
| Access/choice | Versioned non-identifying browser preference | Remember entry and the two default-off purpose choices | Fixed, at most 180 days; browser-readable; no passive renewal | Missing/stale means unknown with both purposes off. It is never an analytics ID. |
| Pending local deny/delete | Non-identifying local state plus cross-tab message | Stop stale in-flight bootstrap, grant, telemetry, and GA work | Until the server result is reconciled; browser-readable | Written before network I/O and wins over late grant responses. Contains no visitor/session ID. |
| First-party visitor | Host-only `HttpOnly` cookie | Join consented first-party events for one visitor generation | Fixed, at most 180 days; no passive renewal | Issued only after explicit first-party opt-in; retained solely for the same withdrawal retry while locally disabled, then expired after confirmed revocation. |
| First-party session | Host-only `HttpOnly` session cookie | Bound one browser session to the visitor generation | Browser-session lifetime | Every session is revoked together on withdrawal/deletion. A pending local deny makes the cookie unusable except for withdrawal retry; startup revalidates server state before telemetry. |
| Erasure capability | Host-only `HttpOnly` opaque cookie | Authorize deletion/status for one bound visitor and its explicitly linked generations | Owner choice under `DP-885-08`; fixed; no passive renewal | Survives withdrawal but never participates in telemetry or reporting joins. |
| GA cookies/tag state | GA-managed demo-host state | Separate third-party analytics purpose | Fixed configured lifetime at most 180 days; no passive first-party extension | Created/loaded only after the separate GA opt-in. Turning GA off prevents new application calls and follows the documented GA denial/reload path. |
| Synthetic workspace | IndexedDB or in-memory demo state | Browser-local synthetic product experience | Existing seed/version lifecycle | Available without analytics. **Reset synthetic demo data** does not withdraw, revoke, or erase server analytics. |
| Documentation-host consent | `jobctrl.dev` local storage/cookies | Documentation analytics | Existing documentation-host contract | Separate origin and choice; it never controls `demo.jobctrl.dev`. |

Browser session restoration, BFCache, and frozen tabs can preserve JavaScript or
session cookies beyond a user's intuitive idea of a closed tab. Every
`pageshow` (including persisted pages), resume/visibility transition, and
telemetry send must re-check the local pending marker and the server generation
as appropriate. A restored client cannot treat the presence of a session cookie
as a grant.

### Next-contract migration from v2

**RECOMMENDED:** Treat the next consent contract name, hosted D1 migration file,
and version number as provisional until implementation. This hosted design does
not allocate the local product schema version reserved by #886.

On first next-contract contact:

1. A missing, denied, malformed, inactive, or stale v2 tuple becomes access-only
   with both analytics purposes off. No identifier is minted.
2. A valid active v2 visitor/session may be used once in a same-origin migration
   transaction to revoke the v2 generation and mint a restricted erasure
   capability bound to that known visitor. It must not infer a first-party or
   GA grant. Both next-contract purposes remain off.
3. Existing v2 events keep their original fixed expiry unless the capability
   holder requests deletion. Migration does not renew their retention.
4. A missing old identity cannot be recovered. Historical rotated visitors and
   cross-device identities remain out of scope; no fingerprinting or support
   guess may join them.
5. The browser clears v2 choice/identity cookies after a confirmed migration or
   handles them as stale after failure. A late v2 response cannot overwrite a
   pending local denial or create a next-contract grant.

The implementation must document whether a valid v2 tuple receives the
capability automatically during this one-time privacy-preserving migration.
That migration choice is part of `DP-885-05`, not an implied decision here.

## Race And Failure Safety

**RECOMMENDED:** Every state-changing route requires same-origin request
metadata, `Cache-Control: no-store`, a strict allowlisted JSON object, a small
endpoint-specific byte limit, and an edge-generated target derived only from
the authenticated cookies/capability. There is no visitor ID, session ID, hash,
or generation field in a client payload. Origin/Fetch Metadata rejection,
content-type enforcement, and rate limits fail closed without a state change.

The server owns a monotonic visitor generation:

1. first-party grant activates exactly one current generation and its sessions;
2. an event insert succeeds only when its visitor, session, purpose grant, and
   generation are active in the same D1 statement/transaction;
3. withdrawal/deletion revokes the generation and all its sessions atomically;
4. a delayed event from a revoked generation fails the write fence; and
5. a delayed grant response cannot reactivate that generation. A later grant
   requires a new explicit choice and a new generation.

The client writes `pending-deny` or `pending-delete` synchronously before any
request, disposes the first-party adapter, applies the GA deny path, and blocks
all queued grants, health calls, telemetry sends, and late promise continuations.
`BroadcastChannel` plus the storage event makes the stop visible across open
tabs. Each tab also revalidates on `pageshow`, BFCache restoration, visibility
resume, and network recovery. The pending marker remains authoritative until a
status check proves the server outcome or the user explicitly starts a new
grant after the pending operation completes.

These controls can stop this application's future sends. They cannot recall a
request already received by GA, force an offline tab to receive a server
revocation immediately, or prove instant third-party cessation across frozen
contexts. The UI and public notice must state that boundary plainly.

Failure behavior is conservative:

| Failure | Access | Local collection | Server/third-party claim |
| --- | --- | --- | --- |
| Consent service unavailable on first visit | Full synthetic demo remains available without analytics | Off | No grant inferred |
| Grant `429`/`503`/timeout/lost response | Demo remains available | Purpose stays off until confirmed | Status is unknown/retryable, never granted |
| Withdrawal offline or response lost | Demo remains available | Stops immediately and pending state persists | Server completion remains pending; GA global cessation is not claimed |
| Deletion transaction fails | Demo remains available without the affected purpose | Stops immediately | No success receipt; idempotent retry/status remains available |
| Cookie blocked or cleared | Demo remains available without first-party analytics | Off unless a separately confirmed GA choice remains | No linkage recovery, fingerprint, or client target |
| Cross-tab/BFCache stale client | Demo remains usable after revalidation | Pending marker blocks sends | Generation fence rejects stale first-party writes |

## D1 Recovery And Deletion Suppression

**RECOMMENDED:** A live D1 deletion is not deletion from Time Travel. Cloudflare
currently documents Time Travel retention of 30 days for paid plans and seven
days for free plans. Restoring an older point can therefore resurrect a row
that was deleted from the live database.

Before any production implementation can launch deletion, it must add this
bounded recovery protocol:

1. Before the live delete, write an operation-keyed, capability-derived
   suppression entry to a protected recovery manifest outside the restorable
   telemetry D1 database. It contains only the visitor digest/generation needed
   to suppress restored rows, operation state, and fixed expiry. It is never a
   reporting source.
2. Delete and revoke live rows in one D1 transaction. Mark the recovery entry
   complete only after the live transaction commits. A prepared entry is still
   replayed conservatively after restore because it represents an explicit
   deletion request.
3. Quarantine every telemetry D1 restore: no application Worker or reporting
   reader may serve it. Replay every unexpired prepared/completed suppression,
   rerun retention, and verify absence of each suppressed generation before
   routing traffic or reports to the restored database.
4. Preserve exact restore point, manifest version, replay counts, retention
   result, and independent absence-check evidence. If the manifest is missing,
   stale, inconsistent, or older than the backup horizon, the restore cannot
   serve. This is a launch/recovery blocker, not a warning.
5. Retain suppression for the bounded period chosen in `DP-885-09`, then remove
   it only after every backup capable of containing the row has expired and the
   verification buffer has elapsed.

The recovery-manifest technology and access controls require a separate
implementation design and owner approval. The observable contract above is
mandatory: a solution that cannot preserve it blocks deletion launch. It must
not silently fall back to serving an unsuppressed restore.

Sources checked 2026-09-22:

- [D1 database API and `batch()` rollback](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 Time Travel retention and restore boundary](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 read replication and Sessions consistency](https://developers.cloudflare.com/d1/best-practices/read-replication/)

These sources support the database mechanics only; they are not legal guidance.

## Retention

**RECOMMENDED:** Retention is fixed at issuance/write time and does not slide on
passive reads, page views, telemetry, or session restoration.

| Data | Proposed maximum | Renewal | Notes |
| --- | --- | --- | --- |
| Non-identifying choice/access preference | 180 days | Only a new explicit choice | Missing/stale means both purposes off. |
| First-party visitor identity | 180 days | Only a new explicit first-party grant creates a new generation | Withdrawal revokes it immediately. |
| GA demo-host state | 180 days | Only under the separately chosen GA contract | Subject to the disclosed third-party boundary. |
| Raw first-party product events | 90 days | Never | Withdrawal retains them to fixed expiry; deletion removes live rows. |
| Non-linkable operational aggregates | 90 days | Never | Kept only if `DP-885-07` approves them. |
| Transient rate/retry/idempotency rows | 24 hours | Retry may reuse the same operation's original bound | Never extended by unrelated traffic. |
| Erasure capability | Owner choice; recommended 270 days from each explicit first-party grant for the full 180-day identity plus 90-day event tail | Replaced only by a later explicit first-party grant; never passively | Survives withdrawal solely for deletion/status. A shorter choice must disclose when self-service ends while retained events may remain. |
| Recovery suppression | 35 days under the current 30-day maximum backup horizon | Never | Must cover the configured backup horizon plus verification buffer. |

Operational aggregates remain schema-separated, minimized, and best effort.
They cannot identify unique visitors, measure a nonconsenting funnel, join to
events/capabilities, or block demo access, grant, withdrawal, deletion, or
status. If the owner rejects them, implementation removes the lane rather than
adding another identifier.

### Future reporting semantics

**CURRENT — source-traced:** the operational report labels its populations
`all choices` and `granted initialization attempts`. The consented-audience
report counts distinct visitor and session hashes and labels that population
`consented traffic`.

**RECOMMENDED:** Optional access makes the initialization denominator an owner
choice under `DP-885-07`. A future report must either keep initialization
measurement limited to first-party-granted attempts and label it exactly as
such, or add an approved non-linkable access-only initialization counter and
label the combined population **all demo initialization attempts**. It must not
silently keep the old label for a changed population. Choice-counter totals are
operations, not unique visitors. Distinct pseudonymous visitor/session hashes
are browser identities, not people. No report may relabel either as users,
people, or a nonconsenting conversion funnel.

## Future Delivery Shape

No slice below is authorized by this proposal. After every owner decision and
separate legal/privacy review, implementation may be split into reviewable
hosted-demo changes:

1. next-contract types, provisional hosted D1 migration, generation fence, and
   rollback-safe fixtures;
2. access-only bootstrap plus separate first-party/GA purpose controls;
3. persistent privacy settings, local pending-stop lifecycle, cross-tab/BFCache
   handling, and GA deny/reload behavior;
4. all-session withdrawal, capability-only deletion/status, transactional
   erasure, and fixed retention;
5. recovery suppression and quarantined-restore tooling; and
6. current-behavior documentation replacement only after the behavior is
   implemented and independently verified.

Migration filenames and version numbers remain provisional. This hosted D1
work is independent of the local product schema v11 reserved by #886.

## Future Implementation And Verification Matrix

**FUTURE VERIFICATION — none of these checks ran for this proposal:**

| Area | Required future evidence | Expected result |
| --- | --- | --- |
| Local D1/Workers migration | Real local D1 migrations from representative v2 data, forward reopen, rollback on injected statement failure, retry, retention, and migration-status evidence | No inferred grant; rows/counts preserved or intentionally suppressed; failed migration leaves the old contract usable; retry converges once |
| Transaction and race fixtures | Real handler/database tests for all-session revoke, generation-fenced event writes, grant-versus-withdraw/delete races, late/lost responses, duplicate operation keys, and an unaffected sentinel visitor | No stale generation writes or reactivation; target rows change atomically; sentinel visitor and events are byte-for-byte unaffected |
| Strict edge contract | Same-origin/Fetch Metadata and CSRF probes, content-type/size/extra-key rejection, cookie tampering, client-chosen target attempts, and `Cache-Control: no-store` assertions | Only the capability-bound visitor can be affected; invalid requests make no state change and disclose no database state |
| Built demo, two tabs | Exercise the actual production-mode built demo in two tabs with network capture | Full demo works with all analytics off; no first-party telemetry or Google request before a purpose grant or after its local off action; pending stop propagates across tabs |
| Lifecycle restoration | BFCache, frozen/background tab, browser session restoration, visible/resume, and stale in-flight grant/telemetry fixtures | Pending deny wins; restored tabs revalidate; revoked generations cannot write or reload GA |
| Faults | Cookie blocking, offline transitions, `429`, `503`, timeout, malformed/lost response, D1 error, and retry/status checks | Access remains available; collection fails off; no false grant, withdrawal, deletion, or success receipt |
| Expiry and v2 migration | Fixed-clock choice/ID/event/rate/capability expiry, no-passive-renewal probes, valid/invalid/missing v2 identities, and rotated-old-identity cases | Both purposes default off; valid bounded migration follows the owner decision; lost/old identity is not recovered or fingerprinted |
| Deletion and restore | Delete a uniquely owned synthetic visitor with multiple sessions/events/rates, quarantine a Time Travel restore containing it, replay suppression, and run an independent absence check | Live transaction deletes all scoped rows; restore cannot serve until every suppressed generation is absent; unrelated sentinel remains |
| GA boundary | Browser network/DevTools checks for default off, explicit on, off/reload, cookie clearing, already-sent request, offline/frozen tab, and separate first-party choice | The implementation makes only the bounded promises in this plan and never claims first-party deletion erased Google-held data |
| Reporting populations | Run each operational and consented report against analytics-off, first-party-on, GA-only, both-on, repeated-choice, and multi-session fixtures | Labels match the exact included population; choice operations are not unique visitors; pseudonymous visitors/sessions are not reported as people |
| Documentation | Build links and compare disclosure/settings text to the exact candidate behavior | Current docs change only when shipped behavior and verified limitations match them |

Production verification is a future, separately authorized action. It must use
an owned synthetic browser profile, cookies, visitor generation, sessions,
events, and recovery entries; record the exact release, configuration, D1
migration, and retention evidence; read/delete no other visitor; and finish with
a fresh independent post-action check of the target and sentinel. A local pass,
preview, fixture, or this proposal cannot substitute for that evidence.

## Exit Conditions For Proposal Acceptance

This proposal can move from **PROPOSED** only when:

1. the owner records `DP-885-01` through `DP-885-09`, including explicit
   operational-measurement and retention choices;
2. a separate legal/privacy review accepts the intended notice and purpose
   model without treating this engineering proposal as its conclusion;
3. each future slice receives implementation scope and verification limits;
4. recovery suppression has an approved concrete technology and access model;
   and
5. current public documentation remains unchanged until implementation and
   future verification support replacement text.
