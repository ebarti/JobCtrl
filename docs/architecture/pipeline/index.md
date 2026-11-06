# Durable Work and Pipeline Architecture

JobCtrl's accepted target keeps durable execution while moving all application
actions and canonical writes into explicitly composed Python features. HTTP,
CLI and the worker call the same feature services. The transformation is
**in progress**: the target contract and retained capabilities below are not
proof that each journey is integrated or verified.

Discovery can find and prepare jobs, but manual capture belongs to Jobs and must
work without it. Other feature owners retain requirements, person fit, resume
composition, applications and optional research/communication work. The
[stage guide](stages.md) identifies these responsibilities; it does not impose
one universal state machine on unrelated features.

Durable work must expose its identity, progress and truthful terminal status;
be cancellable where possible; recover without duplicating accepted work; and
preserve approval, source/version and external-effect fences on every retry.
An accepted submission response means the workflow was accepted, not that the
business action finished. An unknown external outcome requires verification,
not an automatic repeat.

- [Activities and execution envelope](envelope.md)
- [Feature work and stages](stages.md)
- [Concurrency and fan-out](concurrency.md)
- [Operations, schedules and recovery](operations.md)
- [Historical search-unit assessment](search-unit-concurrency-assessment.md)
- [Domain integration](../domain-model/integration.md) and
  [foundation contract](../../plans/2026-11-06-python-contracts.md)

At complete cutover no Fastify business writer or JSON-RPC bridge remains.
Feature completion requires real application, API, database, worker and renderer
journeys, not merely moved files or registered actions. External providers may
be controlled at their boundary; internal JobCtrl behavior remains real.
