---
description: "How JobCtrl uses local DBOS workflows for recovery, retries, visibility and cancellation."
---

# Durable Workflows In A Desktop App

JobCtrl uses DBOS with a local PostgreSQL database to make long-running work
recoverable across worker restarts. Application state and DBOS system tables
share a workspace database; generated files and credentials have separate
owners. This source architecture does not establish an installed release.

## Acceptance and recovery

The API validates a request, persists its domain acceptance and enqueues the
DBOS workflow in one transaction. A stable workspace/action identity allows a
retry after a lost acknowledgement to refer to the same work. An accepted
receipt means queued work was accepted, not that it completed. Runs expose
progress and failure separately. A matching worker and database are required;
database availability alone does not establish worker readiness.

Discovery retains its progress across pages, while separate queues let other
work proceed during a source cooldown. Explicit schedules can search for new
jobs; rechecking saved postings remains manual. Cancellation records the
request and targets the durable workflow, but an already dispatched external
effect may still be unsettled. Retry does not grant approval or repeat an
ambiguous submission. Model calls retain their receipts and spend constraints;
a failed refresh leaves the last accepted artifact intact.

See [Runtime & Processes](../architecture/runtime.md),
[Durable Execution Envelope](../architecture/pipeline/envelope.md), and
[Data, Privacy & Safety](../user/data-and-safety.md). The URL of this guide is
retained for existing links.
