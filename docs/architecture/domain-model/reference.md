# Domain Reference

<a id="_11-glossary"></a>
## Glossary

| Term | Meaning |
| --- | --- |
| Feature | Explicitly composed owner of a bounded domain, its application actions, data and adapters. |
| Source snapshot | Immutable, versioned input with provenance used by another decision. |
| Requirement | A qualified meaning with a recorded identity; occurrences bind it to source material. |
| Person fit | Qualification supported by Profile evidence and requirement decisions; independent of wording coverage. |
| Wording coverage | A recorded relation between an approved wording and a requirement; it describes expression, not the person's capability. |
| Baseline | The complete authored Profile resume content to be retained in composition. |
| Advisory review | One model coherence review of the assembled resume; its status is distinct from mechanical validation and acceptance. |
| Accepted artifact | The explicitly accepted, version-bound document or export; failed replacement cannot erase it. |
| Durable action | A feature application action executed by the worker through Temporal, with lifecycle and source/authorization fences. |
| Committed event | A bounded invalidation committed with its owning mutation, not a replacement for canonical data. |
| Ambiguous outcome | An external effect may have happened but lacks a conclusive receipt; retry does not assume it failed. |

The [strategic design](strategic.md) assigns ownership and the
[foundation contract](../../plans/2026-11-06-python-contracts.md) captures
provisional integration interfaces. Both describe a transformation in progress.
