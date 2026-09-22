# Local And Custom LLM Provider Contract

> **Status: design only.** Local and custom providers are unavailable in the
> current product. This proposal does not add a provider, restore a URL field,
> enable production traffic, define a database schema version, or unblock
> [#902](https://github.com/ebarti/JobCtrl/issues/902). Every interface and
> rollout step below is proposed future work unless the text explicitly labels
> an item as current evidence.

This plan defines the proof a future local or custom LLM provider must supply
before JobCtrl can expose it. The contract is deliberately fail closed: a
provider is selectable for one operation only when the exact endpoint,
credential, adapter, model, schema, control, usage, and budget bindings needed
for that operation are fresh and proven.

## Accepted Scope And Vocabulary

The owner has already chosen four boundaries for this work:

- this change is a design, with no production behavior change;
- local/custom providers remain unavailable by default;
- the retired arbitrary provider URL configuration is not restored; and
- no runtime, provider, settings schema, database schema, or #902 behavior is
  changed by this plan.

The words **current**, **proposed**, and **proven** have distinct meanings in
this document:

- **Current** describes source observed at an immutable revision. A declaration
  or docstring is evidence of an interface, not evidence that a provider obeys
  it.
- **Proposed** describes a future contract or implementation shape. It is not a
  claim that JobCtrl supports the behavior today.
- **Proven** means a future adapter has passed the required product proof against
  the exact real endpoint and identity it will use. Unit fixtures, an auth
  probe, a successful model-list request, and a provider's compatibility label
  do not establish generation capability on their own.

## Immutable Source Evidence

The primary snapshot for current-source observations is
[`6a82c233c434e67f0a2d1c6df3db6aa68d036b75`](https://github.com/ebarti/JobCtrl/tree/6a82c233c434e67f0a2d1c6df3db6aa68d036b75).
The two in-flight PR observations use their own immutable heads. Later changes
must be reconciled before implementation; this table must not be treated as a
claim about a moving branch.

| Immutable source and symbol | Current/proven observation | What it does not prove |
| --- | --- | --- |
| [`domain/ports/llm.py::LlmPort`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/domain/ports/llm.py#L36-L90) | **Current:** declares `chat`, `chat_json`, and `ask`, with `model`, `temperature`, `max_tokens`, `response_schema`, and `thinking_budget`. | Its passthrough wording does not prove an adapter binds or enforces any control. |
| [`llm_client.py::_normalize_unsupported_sdk_controls`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/infrastructure/llm/llm_client.py#L43-L69) | **Current:** the sanctioned agent SDK path warns and drops `temperature` and `max_tokens`. | A successful call does not prove output or cost bounds. |
| [`llm_client.py::_parse_model_spec`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/infrastructure/llm/llm_client.py#L93-L113), [`_default_provider`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/infrastructure/llm/llm_client.py#L572-L579) | **Current:** URL/raw config is rejected; only Claude, Codex, and Google/Gemini are routed; the first ready provider is the default. | It does not define a safe custom endpoint identity or prevent a future adapter from silently falling back unless that behavior is explicitly prohibited. |
| [`model_catalog.py::provider_model_catalog`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/infrastructure/llm/model_catalog.py#L13-L61), [`_safe_text`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/infrastructure/llm/model_catalog.py#L245-L253) | **Current:** model lists come from authenticated runtimes, are bounded to 512 entries, and reject control characters or IDs over 160 characters. A provider can still report `ready: true` with an empty list after catalog failure. | Readiness or a nonempty catalog does not prove a listed model supports a particular operation, schema, control, usage field, or bound. |
| [`setup_probes.py::ready_llm_providers`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/infrastructure/setup_probes.py#L927-L944) | **Current:** readiness combines auth and SDK-import probes. | It does not execute generation and therefore cannot prove live connectivity or operation capability. |
| [`scoring/employer_analysis.py::build_analyze_use_case`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/scoring/employer_analysis.py#L64-L139), [`llm_analysis_synthesizer.py::LlmAnalysisSynthesizer`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/infrastructure/analysis/llm_analysis_synthesizer.py#L13-L48) | **Current:** fixed Claude, Codex, and Google SDK draft adapters are distinct from the provider-neutral `LlmPort` synthesis leg. | Adding an `LlmPort` backend would not automatically cover draft legs. |
| [`analyze_use_case.py::AnalyzeJobUseCase`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/domain/materials/analyze_use_case.py#L132-L212) and [`analysis.py::cache_key`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/domain/materials/analysis.py#L243-L263) | **Current:** analysis is posting-snapshot grounded, prose validated, generation versioned, and cached by snapshot/prompt/SDK-set identity. A failed refresh does not replace the last persisted generation. | The existing cache identity does not bind a future custom endpoint, credential, model, adapter, schema, or budget revision. |
| [`llm.py::record_llm_spend`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/llm.py#L48-L88), [`estimate_llm_cost_usd`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/llm.py#L157-L179) | **Current:** accounting records observed usage after calls; a fragile name test treats any model containing `local` as zero cost. | Observed usage is not durable pre-dispatch admission, and a model name is not trusted billing classification. |
| [`llm_spans.py::llm_generation_span`](https://github.com/ebarti/JobCtrl/blob/6a82c233c434e67f0a2d1c6df3db6aa68d036b75/workers/automation/src/jobctrl/infrastructure/observability/llm_spans.py#L45-L118) | **Current:** generation spans invoke the spend callback after a response and swallow callback failures. | Telemetry success does not prove authoritative accounting, and an accounting failure currently cannot stop acceptance. |
| [#886 / PR #960 at `7c6c76f`](https://github.com/ebarti/JobCtrl/tree/7c6c76f936fcfde4fed6b59e686d2b1d2a9ab815), especially [`llm_lanes.py`](https://github.com/ebarti/JobCtrl/blob/7c6c76f936fcfde4fed6b59e686d2b1d2a9ab815/workers/automation/src/jobctrl/llm_lanes.py) and [`schema_v11.sql`](https://github.com/ebarti/JobCtrl/blob/7c6c76f936fcfde4fed6b59e686d2b1d2a9ab815/workers/automation/src/jobctrl/infrastructure/migrations/schema_v11.sql) | **Proven at that observed PR head:** the proposed authority uses canonical lanes and one `llm_spend(day,lane)` ledger, with observed lane-token thresholds plus the global USD threshold. | It has no strict in-flight ceiling or reservation lifecycle. This plan assigns no schema version and creates no parallel ledger. |
| [#902 / PR #956 at `f3f3ad9`](https://github.com/ebarti/JobCtrl/tree/f3f3ad9c4ee8cb1f3677f45c2ad576907127b086), especially [`suggest_target_roles`](https://github.com/ebarti/JobCtrl/blob/f3f3ad9c4ee8cb1f3677f45c2ad576907127b086/workers/automation/src/jobctrl/domain/profile/target_role_suggestions.py#L84-L176) | **Proven at that observed PR head:** production model inference is disabled when provider call bounds are absent. | This contract does not change that behavior. A separate synthetic title-qualifier semantic gap also remains and cannot be satisfied by provider readiness. |

## Decisions Still Owned By The Product Owner

The entries in the “recommended starting policy” column are design
recommendations, not recorded owner decisions. Implementation remains blocked
until the owner selects the rollout-relevant alternatives and the proof named
in the last column exists.

| Choice | Recommended starting policy | Alternatives | Owner | Unblock condition |
| --- | --- | --- | --- | --- |
| Endpoint scope | One explicitly opted-in literal loopback endpoint per provider instance. | Optional LAN endpoint; explicit remote endpoint allowlist. Both remain unresolved. | Product owner, with security review. | Written choice names allowed scopes; containment tests pass for every chosen scope. |
| Transport flavor | One versioned adapter profile with adapter-owned paths and semantics; an OpenAI-compatible profile is only a transport claim. | Additional native protocol profiles, each separately proven. | Worker/provider owner. | Real-endpoint operation/control/schema/usage matrix passes for the exact adapter revision. |
| Authentication | Loopback may use no auth only when the owner explicitly chooses it; otherwise use a credential reference. Any remote endpoint requires authenticated HTTPS. | Header token, mutual TLS, or a named provider-native flow. Credentials never appear in general config. | Product owner and security owner. | Secret resolution, redaction, redirect/proxy containment, rotation, and restart behavior are proven. |
| Rollout | Disabled configuration, then discovery-only status, then allow one proven capability at a time. | Broader opt-in after all target capabilities pass. | Product owner. | Each capability has product proof against every target endpoint and owned synthetic data. |
| Budget policy | Observed accounting only, clearly labeled as overshoot-capable; operations that require a strict bound remain unavailable. | Strict admission after the #886 ledger owner accepts a durable reservation design. | Product owner and #886 ledger owner. | Selected mode is explicit. Strict mode additionally proves atomic reservation, reconciliation, replay, crash, and day-rollover behavior. |

No implementation may infer that “local” means LAN, remote, unauthenticated,
free, private, or trusted. Those are independent properties.

## Proposed Ownership And Typed Envelopes

Worker infrastructure owns transport, endpoint validation, DNS/IP containment,
TLS, authentication, secret resolution, provider-specific schemas, retries,
usage normalization, and adapter proofs. The domain `LlmPort` remains
provider-neutral and expresses only the operation the domain needs.

General configuration may store only nonsecret settings and opaque bindings.
Credentials remain in Keychain or another existing credential boundary. A
proposed saved provider instance is shaped like this:

```text
ProviderInstanceConfig {
  providerInstanceId: OpaqueId
  enabled: false by default
  endpointProfile: {
    canonicalOrigin: NonSecretOrigin
    endpointRevision: RevisionToken
    scope: literal_loopback | authenticated_remote_allowlist
    transportProfileId: OpaqueId
  }
  credentialRefId: OpaqueId | none
  selectedModelCatalogId: OpaqueId | none
  budgetMode: observed | strict
}
```

`canonicalOrigin` is accepted only through a validated settings workflow. It is
never accepted from `LlmPort.model`, a prompt, job data, an environment
redirect, or a per-call URL. The worker resolves `credentialRefId`; API and UI
surfaces receive only presence, revision, and safe status.

The proposed adapter emits three immutable envelopes:

```text
CapabilityEnvelope {
  providerInstanceId, adapterRevision, endpointRevision, credentialRevision
  modelCatalogId, modelRevision
  operations: Map<Operation, OperationCapability>
  usageProof, billingClassification, provedAt, expiresAt
}

OperationCapability {
  operation: chat | chat_json | ask | analysis_draft | analysis_synthesis
             | materials_voice | apply_agent
  supportedControls
  schemaProfile | none
  responseBodyLimit, timeoutProfile, retryProfile
  usageCategories, callBoundProof | none
}

ReadinessEnvelope {
  providerInstanceId, operation, ready
  boundRevisionSet
  checkedAt, expiresAt
  safeReasons: ReadinessReason[]
}
```

`ReadinessReason` is a closed code such as `disabled`, `endpoint_rejected`,
`credential_missing`, `credential_changed`, `catalog_unavailable`,
`model_not_allowed`, `connectivity_unproven`, `operation_unsupported`,
`schema_unproven`, `control_unbound`, `usage_unproven`,
`accounting_unavailable`, or `budget_bound_unproven`. It contains no host,
model name, credential detail, path, response, or raw exception.

The operation-level predicate is:

```text
ready(instance, operation, request) =
  instance.enabled
  AND endpoint_identity_is_pinned_and_fresh
  AND credential_revision_is_pinned_and_fresh
  AND exact_model_catalog_binding_is_fresh
  AND adapter_supports(operation)
  AND every_requested_control_is_bound
  AND requested_schema_profile_is_proven
  AND live_connectivity_proof_is_fresh
  AND usage_and_accounting_proof_satisfies_budget_mode
  AND no_invalidation_token_changed
```

Every conjunct is required. There is no provider-wide boolean that makes all
operations ready, and no provider fallback when the selected operation fails.

## Proposed Endpoint, Authentication, And Egress Containment

The recommended first implementation accepts one of these policies only after
explicit local opt-in:

1. `http` to a literal IPv4 or IPv6 loopback address. `localhost` and other DNS
   names are excluded from this first policy because literal loopback avoids DNS
   ambiguity.
2. If the owner later chooses remote support, `https` to an exact configured
   hostname and port in an explicit allowlist, with an explicit credential and
   ordinary certificate/hostname validation.

The validator rejects unknown schemes, URL userinfo, query, fragment, dynamic
path selection, Unicode/IDNA ambiguity, wildcard hosts, arbitrary model-to-URL
mapping, environment proxy/endpoint redirects, and provider-supplied endpoint
rewrites. The canonical origin contains no operation path; the versioned
transport profile owns every fixed path it may call.

Credential-bearing requests disable redirects and ambient proxy discovery. A
redirect response fails before a second request. Remote resolution must return
only addresses allowed by the selected endpoint scope. The connection policy
pins the approved address set for the readiness revision and verifies the
actual peer; a changed resolution invalidates readiness before credentials are
sent. Private, loopback, link-local, multicast, unspecified, reserved, and
metadata-service ranges are denied for remote profiles. Loopback profiles deny
every non-loopback peer. Mixed allowed/denied DNS answers fail as a set.

The endpoint binding includes canonical origin, approved address-set digest,
TLS identity where applicable, adapter revision, and endpoint revision. The
credential binding includes credential reference and credential revision,
never secret material. Rotation of either binding invalidates catalog,
capability, readiness, model selection, and cached generation identity.

Every request has finite connect, response-header, body-idle, and total
deadlines plus a streaming byte ceiling. A safe initial recommendation is a
5-second connect deadline, 15-second total catalog/probe deadline, 120-second
total generation deadline, 1 MiB catalog body limit, and 4 MiB generation body
limit. These numbers are recommendations to validate against the target, not
accepted product decisions. A target that cannot operate inside its proved
profile remains unavailable rather than receiving an unbounded exception.

Catalog and readiness probes are read only: `GET` or the protocol's documented
no-side-effect equivalent, no tools, no session creation, no filesystem write,
no completion generation, and no provider configuration mutation. If a
protocol cannot offer a no-side-effect probe, it can become ready only through
the explicit owned-synthetic generation proof, which must be clearly labeled
as generation and accounted as a call.

## Proposed Model Catalog And Invalidation Contract

The model catalog must be fetched through the exact authenticated endpoint,
credential revision, and transport profile that will execute the call. The
worker normalizes it into a deterministic allowed subset:

- at most 512 entries, sorted by the sanitized provider ID before local opaque
  IDs are minted;
- each provider ID is 1–160 printable characters, with control, bidi-control,
  path, URL, credential-like, and duplicate values rejected;
- each entry binds the exact provider model identity to an opaque local catalog
  ID, model revision, adapter revision, endpoint revision, credential revision,
  proved operations, controls, schema profile, usage categories, and billing
  classification; and
- only the opaque local catalog ID crosses general configuration, API, UI, log,
  event, or telemetry boundaries. Arbitrary provider model IDs are unsafe
  telemetry labels.

An empty, malformed, stale, or failed catalog has no selectable models even if
auth/SDK probes report ready. A saved selection whose binding disappears is
shown as unavailable; it is never sent as free text and never falls back to a
different model or provider.

A future explicit-model attestation is a separate alternative for endpoints
without discovery. It must bind one exact model identity to the endpoint,
credential, adapter, capability, schema, usage, and budget proofs. A text field
or a successful free-text completion is insufficient.

Readiness and selections are invalidated on endpoint, DNS/address set,
credential, model catalog, model selection, adapter, transport schema,
structured-output schema profile, pricing/billing classification, usage
normalization, timeout/retry, or budget-policy changes. Process restart clears
ephemeral proofs. Saved nonsecret configuration remains disabled or unavailable
until the worker rebuilds fresh envelopes; restart never promotes stale state.

## Proposed `LlmPort` Operation Contract

Unsupported operations or controls reject before any network egress. The
adapter must validate the entire request first, reserve strict budget when
applicable, and then dispatch exactly once under a unique attempt ID.

| Port surface | Proposed provider obligation | Accepted result |
| --- | --- | --- |
| `chat(messages, response_schema=None)` | Prove chat, message roles, sizes, timeout, response bound, refusal/truncation mapping, usage, and selected budget mode. | A nonempty assistant string. Refusal, truncation, missing content, over-limit content, or ambiguous finish state fails. |
| `chat(messages, response_schema=schema)` | Prove native constrained structured output for the locally accepted schema profile. Prompt-only “return JSON” behavior is not capability. | A JSON document independently parsed and validated locally, returned as its valid JSON string encoding. |
| `chat_json(messages, response_schema=schema)` | Same native and local schema proof as structured `chat`; root object required. | A locally validated `dict`. A list, scalar, duplicate-key ambiguity, non-JSON, or schema mismatch fails. |
| `ask(prompt, **kwargs)` | Translate to one user `LlmMessage`, then apply the exact `chat` contract. | Same return/failure semantics as `chat`. |

`ask` accepts only `model`, `temperature`, `max_tokens`, `response_schema`, and
`thinking_budget`. Unknown keys, positional provider config, URLs, auth fields,
transport fields, or retry controls fail before endpoint resolution.

Control binding is exact:

- `model` is `None` or an opaque catalog selection bound to this provider
  instance and revision set. Raw IDs, URLs, and cross-provider selectors fail.
- `temperature` is permitted only when the target proves the exact requested
  value reaches the model. Normalization to a provider default is rejection.
- `max_tokens` is permitted only when it is a hard provider-enforced total
  output bound with documented treatment of reasoning/tool tokens. Advisory or
  silently dropped values are rejection.
- `thinking_budget` is permitted only when the exact model exposes a proved
  hard bound with defined inclusion in usage and maximum cost. Ordinal
  approximation is a different control and cannot satisfy a numeric request.
- `response_schema` must pass local meta-schema and complexity limits before
  egress and must fit the adapter's proven schema subset.

The initial structured-output subset should require an object root, explicit
`required` properties, bounded strings/arrays, finite nesting, no external
references, and `additionalProperties: false` at every object level. A schema
outside that subset is unsupported. Independently validate the returned bytes
with a local validator configured to reject duplicate keys, non-finite numbers,
extra properties, missing properties, wrong types, and trailing data. Provider
refusal, content filtering, truncation, non-JSON, unsupported schema keywords,
or validation failure is a failed billable attempt. Semantic domain validation
such as posting grounding, candidate-prose rules, or role-title meaning remains
a separate owning-layer gate.

## Employer Analysis, Materials, And Non-`LlmPort` Calls

Employer analysis has two distinct legs. Draft adapters produce independent
`JobAnalysisDraft` values; the neutral synthesizer reconciles surviving drafts.
A future custom provider must declare and prove each leg separately. Supporting
`chat_json` does not automatically enroll it as a draft adapter, synthesizer,
voice pass, or autonomous Apply agent.

For every enabled leg, the composition root binds the operation capability,
opaque model selection, endpoint/credential/adapter revisions, minimized input
shape, schema revision, usage proof, and budget mode. Only successful,
independently grounded and prose-valid drafts enter synthesis. Failed,
unavailable, or rejected legs are recorded as failures, never counted as votes
or agreement. There is no silent cloud fallback. If all configured draft legs
are unavailable or fail, analysis is blocked. A failed refresh preserves the
last accepted generation and its child audit rows.

The future employer-analysis cache fingerprint must add, per leg and for the
synthesizer, provider instance, capability revision, opaque model revision,
endpoint revision, credential revision, adapter revision, schema revision,
prompt revision, data-minimization revision, usage-normalization revision, and
budget-mode revision to the existing posting snapshot/prompt/SDK-set authority.
Any changed component invalidates reuse. Posting-span grounding and candidate
prose validation continue to run independently before persistence.

The complete current provider-call inventory outside `LlmPort` at the primary
snapshot is:

| Current surface | Provider action | Future treatment |
| --- | --- | --- |
| `ClaudeAnalysisAdapter`, `CodexAnalysisAdapter`, `AntigravityAnalysisAdapter` | Direct SDK employer-analysis draft generation. | Separate `analysis_draft` proofs and per-leg rollout; not covered by an `LlmPort` adapter. |
| `ClaudeVoiceAdapter` | Direct Claude SDK materials voice transform. | Separate `materials_voice` proof; retain final provenance/fabrication checks and clean pre-voice fallback. |
| `ClaudeCodeCliAdapter` | Spawns the Claude Apply runtime and may invoke browser tools. | Separate `apply_agent` and tool-bound proof. Local/custom LLM enablement does not alter submission approval or authorize this subprocess. |
| `provider_model_catalog` runtime clients | Authenticated model enumeration. | Discovery-only read path subject to endpoint/auth containment; never generation readiness by itself. |
| `setup_probes` SDK/auth probes | Import/config/auth checks. | Input to safe reason codes only; never generation capability by itself. |

The source also contains the legacy direct HTTP `LLMClient`, but no production
generation call site imports its `get_client` or `create_client` at this
snapshot. Future implementation must repeat a repository-wide reference and
subprocess inventory; a newly active call outside the typed registry is a
rollout blocker.

## Proposed Telemetry Boundary

Telemetry is metadata only and is never accounting authority. The bounded
allowlist is:

- stable opaque provider-instance ID;
- operation and product lane;
- unique attempt ID and retry ordinal;
- outcome/reason code;
- capability, schema, model, endpoint, credential, and adapter **revision
  tokens**, where tokens are non-reversible and bounded; and
- endpoint origin class: `literal_loopback` or `authenticated_remote`, never
  the endpoint or host.

Telemetry must not contain endpoint, host, port, URL, raw provider/model ID,
prompt, job/profile/posting text, response, authentication data, credential
reference, local path, provider error text, exception message/object, response
header/body, or DNS address. Cardinality is bounded by closed operations,
lanes, reasons, outcomes, origin classes, and locally minted revision tokens.
Optional export failure must not change accounting state; accounting failure
must change admission and acceptance state as defined below.

## Proposed Usage, Spend, And Strict Admission

[#886](https://github.com/ebarti/JobCtrl/issues/886) and its ledger owner remain
the authority for lane vocabulary and spend persistence. The observed head uses
`discovery`, `enrichment`, `scoring`, `tailoring`, `apply`, `contact`,
`interview`, `profile`, and `compensation`; `legacy` is migration-only. This
plan neither names a database schema version nor creates a shadow ledger.

Observed thresholds run after provider usage and can overshoot. Product and
operator surfaces must say “observed threshold” and must not call them strict
ceilings. Unknown tokens, categories, price, or cost are `unknown`, never zero.
A zero-cost classification is accepted only from a trusted, revisioned endpoint
billing policy that explicitly attests local unmetered execution; provider or
model names containing `local` have no authority.

Usage normalization retains provider-reported input, cache-read, cache-write,
visible output, reasoning, tool, and internal-retry categories separately until
a revisioned billing policy maps them to totals. A category already included in
a provider total is not added again. The normalized record states which source
fields were authoritative and whether any category is unknown.

Every actual provider attempt is counted, including refusals, truncated or
invalid responses, schema/domain validation failures, timeouts with ambiguous
dispatch, provider-internal retries when observable, and client retries. Each
retry gets a unique attempt ID linked to one logical call. A response rejected
by JobCtrl remains potentially billable.

Strict admission is unavailable unless the adapter proves conservative maxima
for all billable input, visible output, reasoning, tool activity, provider
internal retries, client retries, taxes/markups where applicable, and maximum
call cost under a pinned pricing/billing revision. If any maximum is unknown,
that operation may run only under an owner-selected observed policy and cannot
satisfy a feature that requires a strict provider bound, including #902's model
path at the referenced PR head.

If the owner selects strict mode, the #886 ledger owner must first design and
accept one atomic durable reservation/reconciliation path in the authoritative
ledger. Its required lifecycle is:

```text
reserved -> dispatch_intent -> observed/reconciled
```

- `reserved` atomically checks and debits the conservative maximum for the UTC
  day and lane before egress.
- `dispatch_intent` is durable before bytes can leave the process.
- `observed/reconciled` idempotently settles once against authoritative usage,
  retaining conservative debit for unknown categories.
- timeout, cancellation, crash, lost response, or day rollover after dispatch
  keeps the debit/reservation until authoritative reconciliation. Midnight does
  not move it to a more favorable day.
- release is allowed only when durable evidence proves dispatch never occurred.
- replay uses the same reservation/attempt identity and cannot double release
  or double settle.

An authoritative accounting write failure blocks dispatch. A failure after
dispatch blocks response acceptance and further provider calls until the
ambiguous attempt is durably reconciled; telemetry success cannot override it.
This lifecycle is a future requirement, not a claim that PR #960 implements it.

## Proposed Implementation Slices And Ownership

Each slice remains disabled until its own proof passes. File names are intended
owners and may be adjusted to current topology at implementation time without
moving responsibilities across layers.

1. **Reconcile dependencies and owner choices.** Re-read the merged state of
   #886/PR #960 and #902/PR #956, record endpoint scope, transport, auth,
   rollout, and budget decisions, and rerun the provider-call inventory. This is
   the prerequisite for all code slices.
2. **Add disabled types and configuration.** Worker config and secret-boundary
   owners add typed provider-instance, endpoint-profile, credential-reference,
   capability, readiness, and safe-reason types. Contract/API owners add
   read-only unavailable projections. No provider is enabled and no free-text
   URL/model path exists. Likely owners: `workers/automation/src/jobctrl/config/`,
   `packages/contracts/`, `apps/api/src/`, and existing credential services.
3. **Build the transport and adapter proof harness.** Infrastructure owns URL
   canonicalization, IP/DNS/TLS/proxy/redirect containment, bounded HTTP,
   credential resolution, catalog normalization, exact model binding, control
   rejection, structured-output validation, usage normalization, and typed
   errors under `workers/automation/src/jobctrl/infrastructure/llm/`. Domain
   `LlmPort` stays provider-neutral. Real-target proof precedes selection.
4. **Add strict reservations only if selected.** This slice starts only after
   the #886 ledger owner accepts a design against the then-current authoritative
   ledger. It owns atomic reserve/dispatch-intent/reconcile, concurrency,
   idempotency, replay, crash, and UTC rollover. No provider adapter may invent
   its own table or schema version.
5. **Expose discovery/readiness.** Existing provider model API and Settings UI
   owners show disabled/unavailable state, safe reason codes, proof freshness,
   and invalidation. Empty/failed catalogs have no selections. Saving config is
   not readiness; restart behavior is explicit.
6. **Compose employer analysis and materials.** Analysis owners add separate
   per-leg enrollment and fingerprints for draft, synthesis, and voice. They
   preserve data minimization, grounding, prose, generation, cache, agreement,
   and last-accepted-artifact invariants. No missing leg becomes phantom
   consensus or cloud fallback.
7. **Roll out one capability at a time.** Start with the exact capability the
   owner authorizes, keep all others unavailable, and require the full product
   proof for every configured real target endpoint before first use. Apply
   remains separate because it is an autonomous subprocess/tool boundary.

#902 remains gated on its separate title-semantics validation and complete
bounded-call proof. This contract does not change, unblock, or repair #902 or
PR #956.

## Adversarial Verification Gates For Future Implementation

These gates are requirements for future code; they were **not run for this
design-only change**.

1. **Endpoint/auth containment:** reject userinfo/query/fragment, redirects,
   proxy injection, endpoint/model/env redirects, DNS rebinding, mixed DNS
   answers, metadata/link-local/private egress outside selected scope, TLS
   mismatch, credential rotation races, and credential forwarding to any
   changed peer. Prove no request follows a redirect and no secret appears in
   diagnostics.
2. **Real read-only catalog:** against each exact authenticated target, show the
   bounded sanitized deterministic subset, endpoint/credential binding, empty
   and failed behavior, stale-selection invalidation, and no side effect. A fake
   catalog cannot satisfy this gate.
3. **Operation/schema/control matrix:** for every target model and operation,
   prove supported controls reach the provider exactly; unknown/unsupported
   controls cause no egress; structured output is provider constrained and
   independently validated; refusal, truncation, non-JSON, duplicate keys,
   extra properties, and unsupported schemas fail closed.
4. **Cancellation/timeout/usage/retries:** exercise pre-dispatch cancellation,
   in-flight cancellation, connect/read/total timeout, body limits, ambiguous
   dispatch, provider and client retries, invalid responses, and missing usage.
   Prove each actual attempt has one identity and no usage becomes zero by
   absence.
5. **Strict reservation, if selected:** race concurrent calls at the last
   budget unit; replay reserve/settle; crash before and after dispatch intent;
   lose responses; fail accounting writes; reconcile provider usage; cross UTC
   midnight; and prove release occurs only for known non-dispatch.
6. **Employer/materials failure:** mix ready, unavailable, invalid, and failing
   draft/synthesis/voice legs; prove no phantom consensus or cloud fallback;
   verify posting grounding, prose validation, per-leg minimization, complete
   cache invalidation, and preservation of the last accepted artifact after a
   failed refresh.
7. **API/UI state:** prove disabled-by-default behavior, typed safe reasons,
   empty/failed catalog unavailability, restart rebuilding rather than promoting
   stale proof, credential/model/adapter/schema/budget invalidation, and no raw
   endpoint/model/error leakage.
8. **No-egress negative cases:** instrument DNS and sockets and show zero egress
   for unsupported operation/control/schema, stale binding, missing accounting,
   rejected endpoint, missing credential, or strict-bound failure.
9. **Separate #902 semantics:** rerun the title-qualifier and canonical-evidence
   scenarios independently. Provider readiness or a bounded call is not a pass
   for semantic role validation.

Before first use, every enabled capability must pass these applicable gates as
an actual product path against each real target endpoint using an owned
synthetic workspace and synthetic data. Unit adapters, mocks, a docs build, or
an auth/catalog probe alone are insufficient.

## Design Verification Boundary

This document can be checked only as a contract: documentation link integrity,
source-reference review, and internal consistency. No live provider, product,
runtime, credential, network, database, or production-data verification is part
of this design change. Those proofs belong to the future slices above.
