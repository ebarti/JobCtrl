# Public acquisition I/O

This package owns the reusable network leaves used by target feature adapters:
public destination and redirect validation, bounded HTTP transport, proxy
formatting, Retry-After parsing, process-shared host pacing and run budgets.
There are no configuration/database lookups or canonical writers here.

Crawler identity is explicit. `resolve_request_headers(settings)` accepts the
public crawler-settings snapshot and rejects missing/malformed settings.
`PolitenessGateway(request_headers=...)` preserves that session identity. A
caller deliberately using `default_honest_user_agent()` (or the gateway's
documented default) gets the built-in JobCtrl package identity; this never means
looking for a saved setting in another workspace.

`PolitenessSession` combines a caller-owned policy, budget and gateway. Its
optional `record_outcome` callback is an actual feature-owned I/O port. The
network package never writes discovery tables, operational metrics, projections
or events. Features persist acquisition outcomes through their canonical
application transactions.

The rehomed leaves preserve public-destination/DNS checks, redirect validation,
per-host concurrency, request spacing, capped server Retry-After and per-run
request limits. They preserve the current no-robots acquisition policy; source
access/authentication rules remain the calling feature's responsibility.

Contacts uses these modules in both its production composition and its direct
fetcher constructor. Optional Discovery supplies its public
`get_crawler_settings()` snapshot; Contacts without Discovery deliberately uses
the built-in honest identity. A present but unavailable/invalid setting is
reported as an acquisition-configuration failure, with no global fallback.
