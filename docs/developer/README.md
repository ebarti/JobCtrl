---
description: "Start contributing to JobCtrl by locating the owning source boundary, architecture contract, validation commands, and security requirements."
---

# Contributor Start

This is the shortest path from a fresh checkout to the document that owns the
change you want to make. Start with workflow and safety, find the owning source
boundary, then choose the narrowest architecture and QA references for the
change.

**Read this if** you are contributing code or documentation and need to know
where to begin.

## Start At The Changed Boundary

Use [Contributing](../../CONTRIBUTING.md) for public PR conventions and
[Local Development](../local-development.md) for setup/runtime commands.
Configured maintainer agents use the [pinned workflow](workflow.md).
Find the [source owner](repository-and-ownership-map.md), then read only the
architecture reference below that owns the change. Choose the smallest proof
through [Reliability & QA](../local-reliability-qa.md). Read the
[security contract](security.md) when credentials, user data, browser state,
network access or application submission are affected.

::: tip Here to use JobCtrl, not change it?
Start with [Getting Started](../user/getting-started.md). It covers setup,
everyday flows, configuration, and local-data boundaries without contributor
tooling.
:::

## Find The Owning Reference

| If you are changing… | Read first |
| --- | --- |
| Runtime processes or the TypeScript/Python split | [Runtime & Processes](../architecture/runtime.md) |
| Shared domain types, REST DTOs, JSON-RPC, or client boundaries | [Contracts, Types & API Boundaries](../architecture/contracts-types-and-api-boundaries.md) |
| SQLite authority, domain events, projections, SSE, or telemetry separation | [Data, Events & Projections](../architecture/data-events-and-projections.md) |
| A browser-facing route or response | [Local TypeScript API](../local-ts-api.md), then its focused API reference |
| Temporal workflows, activities, retries, or stage execution | [Job Pipeline](../architecture/pipeline/index.md) |
| Backend aggregates, ports, or bounded-context language | [Backend Domain Model](../architecture/domain-model/index.md) |
| Frontend state, contexts, ports, or realtime invalidation | [Frontend Architecture](../architecture/frontend/index.md) |
| Documentation structure or wording | [Documentation Standards](documentation-standards.md) |

## Requirements, Decisions, And History

- [Requirements](../requirements.md) records the behavior and technical
  constraints that implementation must keep true.
- [Decisions](../decisions.md) records accepted architectural choices and later
  amendments.
- [`docs/plans/`](../plans/) contains active delivery plans and implemented
  records. It is project history, not the source of current product behavior.

Current behavior belongs in the owning guide and in live code, but requirements
and accepted decisions can be normative. When they disagree, reconcile the
conflict: fix a regression in implementation or explicitly amend the decision
before updating the canonical guide. Implemented plans remain historical
evidence rather than current instructions.
