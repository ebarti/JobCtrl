# Contacts

Contacts owns confirmed people, fact provenance, reviewed CSV/vCard imports and
supervised public-source research. `bootstrap.py` composes the service, its
feature-owned SQLite store, HTTP routes and the `contacts.research` durable
action. It has no Outreach or Profile dependency. An employer-linked contact
works when Jobs is omitted; a job link is checked through the Jobs public port.

The retained capability inventory is:

- Create, filter, inspect, correct and soft-delete contacts. Every fact records
  its source, capture method, timestamp, confidence and explicit confirmation.
- Compare the exact saved fingerprint before replacing a contact. Every
  successful save advances the revision, including a same-clock/no-op save.
  Unchanged facts retain their identity and provenance. New/changed facts get
  user-entered provenance; a failed or stale save leaves accepted data intact.
- Preview CSV and vCard 3/4 without writes, then explicitly commit. Confirmation
  repeats duplicate checks inside the writer transaction. Email and usable phone
  identifiers identify literal duplicate records; ambiguous identifiers reject a
  record. A name alone never proves identity. Import never merges or overwrites
  existing contacts. Unsupported vCard properties remain visible as warnings;
  invalid cards do not prevent valid neighboring cards from importing.
- Start durable research for explicitly selected sources. The conservative
  source policy runs before acquisition, and the hardened adapter retains public
  destination/redirect protection, gateway politeness, byte limits, timeouts and
  cancellation checks. Protected sources require manual capture. Model extraction
  returns exact source IDs and Unicode spans, and preserves its provider receipt.
- Keep researched people as proposals until an explicit confirmation promotes a
  candidate. Confirmation joins the recorded determination and exact source
  spans; researched facts retain their provenance when becoming confirmed.
- Distinguish a model-accepted empty extraction from provider, budget, source,
  schema and acquisition failures. Worker retry reuses the task identity, and a
  failed attempt does not remove accepted proposals.

`http.py` retains `/v1/contacts`, `/import`, `/research`, research detail and
candidate confirmation, plus contact detail/PATCH/DELETE. Research POST returns
202 only after the application confirms durable submission. A stable
`Idempotency-Key` (or optional UUID `requestId`) reuses the same task/run; changing
the input under that identity conflicts. Other writes return canonical read DTOs.
GET and HEAD remain read-only. A task's `/determinations` read exposes its exact
persisted prompt, schema, context, sources, provider receipt and result, including
rejected source bindings. Missing authority is explicit, never reconstructed as
an accepted empty extraction.
Availability (`complete`/`available`) is separate from verified authority. Readers
join the public gateway receipt and validate its succeeded status, provenance,
exact output and recomputed request fingerprint. Candidate confirmation also
checks the exact candidate index/spans from that recorded result. Missing or
mismatched authority disables confirmation without deleting the retained review.

Only this feature's adapter reads its `contacts_*` tables. Values and page/model
content remain private canonical state; events carry IDs, revisions and status
invalidations. The synthetic page adapter is available only with the shared
owned-workspace marker/token. It controls external acquisition HTTP and returns
raw page responses; source policy, HTML parsing, model extraction, source
validation and persistence remain real application code.
The production adapter uses the neutral `jobctrl.network` leaves. Its direct
constructor uses a declared honest identity; composition optionally consumes
Discovery's public crawler-settings snapshot. Neither path reads legacy global
configuration, a legacy database or an operational-metrics writer. Missing or
invalid configured identity is a recorded acquisition-configuration failure.

The target recurring journeys belong to `apps/web/e2e/journeys/optional.spec.ts`.
No internal API, domain or repository mocks are used by the target journeys.
