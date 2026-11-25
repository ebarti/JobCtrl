---
description: "Interpret the structured JobCtrl doctor and setup readiness report."
---

# Doctor Diagnostic Coverage

`jobctrl doctor --json` returns the canonical `/v1/setup/status` report. A
successful response means the report was read; it does not mean every capability
is ready. A bootstrap error produces a typed CLI failure.

The PostgreSQL check reports `status: ready` when admitted. The DBOS check
reports `status: ready` or `unavailable`, with `available`, `engine` and
`systemSchema`. The worker check separately reports `status: healthy` or
`unavailable`, with `healthy` and a reason or message. A reachable database does
not prove a compatible worker can execute work. Other setup checks describe
Profile, providers, browser and policy readiness; configured credentials are not
proof of a successful live provider call.

Use owned synthetic workspaces and real product entrypoints to qualify actual
worker execution, external boundaries, cancellation and recovery. See
[Reliability & QA](../../local-reliability-qa.md).
