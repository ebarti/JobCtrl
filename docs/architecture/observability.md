# Observability and Model Accounting

Operational status, durable model receipts and diagnostic telemetry are
separate from canonical feature state. The Python transformation is in progress:
this page identifies the current source boundaries and target privacy rules,
not completed telemetry or provider coverage.

## Model receipts and spend

The Python `app/model.py` gateway records operation, provider/model, lane,
prompt version, input fingerprint, receipt identity, timing, status and available
usage. A feature validates and binds a receipt to its own source revisions before
accepting a semantic result; a receipt alone does not approve a document or
external action. Lane and spend admission precede provider work.

The gateway distinguishes provider-reported values where available,
`sdk_estimate` values and estimates from explicitly configured model prices.
The Claude SDK's dollar total is an SDK estimate, not a billed provider total;
its receipt records SDK/version provenance and leaves an unknown CLI version
null. A transport interruption can leave provider execution or spend uncertain;
the gateway retains that uncertainty rather than inventing zero cost.
A call known to fail before dispatch is distinct from a call with unknown
provider execution. Unresolved accounting can block subsequent budgeted work.
Consult `app/model.py` and [settings](../user/configuration.md) for current
availability and policy; controlled-provider tests do not prove actual provider
billing or semantic accuracy.

## Local operations telemetry

Action/run identity, status, cancellation, committed event IDs and feature-owned
receipts support local operations. They must distinguish requested cancellation,
terminal completion and an ambiguous external effect. A progress or health
probe cannot fabricate a receipt or prove an external send. Operational views
contain bounded allowlisted metadata rather than raw inputs, credentials,
documents, mail bodies, paths or exception text.

## Diagnostic export

Existing opt-in OpenTelemetry/Langfuse capability is part of the retained
baseline, but its wiring and privacy on the transformed Python candidate require
integrated verification. Do not infer active spans, trace propagation, exporter
availability or hosted-provider cost from legacy JSON-RPC instrumentation.
Any enabled export must be disableable and privacy-bounded; prompts,
completions, Profile evidence, job descriptions and generated documents must not
be exported as general telemetry. Diagnostic spans do not replace canonical
source, decision or review records.

## Verification

Exercise model admission, failure, source binding, resolved and unresolved spend,
redacted operations and configured export through real target entry points with
owned synthetic state. Separately verify live provider and installed-runtime
behavior before making those claims. See [Python journey ledger](../developer/qa/python-journeys.md)
and [security](../developer/security.md).
