# Backend Domain Model

The accepted [Python transformation](../../plans/2026-11-06-python-transformation.md)
reorganizes JobCtrl into explicitly composed feature packages. This is the target
contract, **implementation in progress**: the presence of a package or route does
not establish feature parity or completed cutover. Release and integrated journey
verification are separate decisions.

Python owns application actions and canonical writes. HTTP, CLI and durable worker
entry points call the same application services; no TypeScript business writer or
JSON-RPC forwarding bridge remains at cutover. React remains the client. SQLite
and the existing durable execution model remain local infrastructure.

| Reference | Scope |
| --- | --- |
| [Strategic design](strategic.md) | Feature ownership and removable boundaries |
| [Tactical design](tactical.md) | Source authority, revisions and domain invariants |
| [Ports and adapters](ports.md) | Public services and I/O boundaries |
| [Integration](integration.md) | Composition, durable work and committed events |
| [Persistence](persistence.md) | Feature-owned data and fresh-state transition |
| [Cloud](cloud.md) | Explicitly future concerns, not a current architecture |
| [Glossary](reference.md) | Shared terms |

The [foundation integration contract](../../plans/2026-11-06-python-contracts.md)
sets the current workstream interfaces. The [pipeline reference](../pipeline/index.md)
covers orchestration; [tailoring](../tailoring.md) covers resume composition.
A feature is complete only when reachable in the integrated application, its
retained capability inventory is reconciled, and real product-path evidence
satisfies the [verification requirements](../../local-reliability-qa.md).
