# 5–6. State Architecture and Frontend Ports

## 5. State Architecture (Detailed)

Server, URL and ephemeral client state have distinct owners. TanStack Query stores tenant-first immutable snapshots; Router owns navigable filters and selections; local component state owns transient presentation. Reconcile data without discarding a newer confirmed value, an unsaved draft or a last accepted artifact on failure.

Search, sort, pagination and selected detail routes are navigable URL state; the query cache holds their corresponding server responses. Checked bulk rows are deliberately transient. Saved table definitions, widths, column order, density and theme are user preferences rather than duplicate live query filters. Applying a saved view updates the route explicitly. Tenant identity and the single Query client come from providers; private form drafts stay with their owning feature.

### 5.2 URL, cache and draft ownership

Route search is validated before it becomes query input. A list and its detail route preserve the user's navigable filters when opening and closing the detail. A feature's read factory builds the same tenant-scoped key for both an observer and its route loader; a required detail read can propagate a not-found error while an optional prefetch remains best effort. Do not prefetch a competing list key before saved-view and URL inputs have been resolved.

Form edits are not replaced merely because a background read completed. Autosave acts on a specific dirty snapshot; later edits stay dirty after an earlier acknowledgement. A version conflict retains the draft and requires an explicit fresh baseline. A timeout, unreadable acknowledgement or ambiguous server error preserves the attempted state and presents reconciliation rather than asserting that a write failed. Feature-owned version fences prevent an older in-flight read from replacing a later canonical publication.

### 5.3 Optimistic Updates

Optimistic mutations cancel the affected in-flight reads, publish a reversible patch and record enough ownership to remove only the failed operation. Concurrent mutations and newer publications must not be undone by an older rollback. Invalidation after a mutation or committed event must defer refetch where it would overwrite a pending optimistic patch. The shared `createOptimisticMutation` and `invalidateQueriesWithOptimisticOwnership` utilities provide that coordination; each feature decides its exact keys and patch relevance. Ambiguous writes require reconciliation with canonical state before a repeat external effect.

## 6. Hexagonal Boundaries — Frontend Ports & Adapters

The shell constructs ports and provides them to feature-owned hooks. `HttpPort` sends JSON, text and binary requests to the Python application's `/v1` endpoints. Features own endpoint paths, schemas, DTO validation and meaning. Error responses preserve status and the Python error envelope, and network/timeout or server failures after a write expose uncertainty. Browser downloads, clipboard, storage, session and the SSE connection are adapters behind ports. A feature must not access `fetch`, `EventSource`, storage or clipboard directly.

The tab-scoped session-storage port is for minimal request-recovery metadata, not request bodies, credentials, profile facts or generated documents. A recovery flow checks the current database-incarnation identity before reconciling or retrying a saved request and treats unavailable storage, cryptography, health or workspace continuity as unknown. Fingerprints support exact-input comparison but can reveal low-entropy values through guessing; do not log them. Local and demo storage use separate namespaces.

Durable preparation, Discovery and Interview recovery bind the saved action key and input fingerprint to both workspace and database-incarnation identities. The transport sends the expected incarnation with status lookups and submissions; the Python middleware rejects a mismatch before running a handler. A lookup that finds no admission at one instant does not authorize a different request: the same original input may be retried with the same identity. Each feature decides when a recorded result has been sufficiently reconciled to permit new work. The identity is an opaque filesystem-incarnation observation, not a permanent business identifier; filesystem inode reuse remains a theoretical limit.

Profile transfer uses a separate browser port to inspect the existing legacy IndexedDB and local-storage records without creating or changing them. It reports inaccessible or malformed records separately and hashes valid preserved PDF bytes without logging their contents. The feature owns the transfer manifest, provenance and user-initiated download; the adapter does not infer that historical bytes are factual authority.

The explicit place-search port sends only the selected location query after a
user action and validates provider results at its boundary. Profile joins a
selected place by recorded row index and exact saved text; editing/removing a row
invalidates or reindexes that binding. A read, keystroke or autosave cannot
perform place lookup or semantic assessment.

Private editor recovery uses a different storage purpose from minimal durable
request metadata. Profile/preference version-2 recovery stores non-secret
changed-field patches; direct password/credential edits use only session/tenant/
section-scoped memory and a native reload guard. Safe restores preserve saved
credentials. Valid older copies project safely before removal; malformed data
keeps a generic paused retry/discard barrier without a raw JSON disclosure.
Owner/revision CAS prevents cross-tab overwrite, and explicit ownership recovery
handles a retained peer-tab draft. Profile/Plate editing pauses until explicit
restore/discard. Recovery resets with tenant changes and demo copies have a
separate workspace/reset epoch. Restored document content remains distinct from
its saved baseline and accepted artifact.

### 6.5 Canonical DTOs And Frontend Input Refinements

Feature API owners define public DTOs. Consume an existing shared DTO only when it is the actual Python endpoint contract; do not create a transparent central DTO facade or assume legacy response shapes. Validate data at the boundary and retain frontend-specific form refinements locally. Identity strings remain compatible with route parameters.

### Automated Boundary Checks

`corepack pnpm web:lint` checks TypeScript dependency direction and capability provenance. Routes and views compose feature helpers, not raw HTTP, Query or persistent stores; feature modules do not import routes, views or sibling private state. Browser capabilities remain behind adapters. Aliases, casts, computed access or missing type declarations do not grant authority. Exemptions in `apps/web/boundary-exemptions.json` need a specific justification and must fail when stale.
