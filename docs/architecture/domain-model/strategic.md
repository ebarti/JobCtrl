# Strategic Design: Feature Ownership

The following is the accepted target, under implementation. Each feature owns
its domain, application actions, schema, adapters and public contracts. The
composition root connects public services; it must not grant access to another
feature's private tables or business writers.

| Feature | Authority and boundaries |
| --- | --- |
| Profile | Career facts, sources and attachments, confirmations, preferences, authored baseline, wording text and its user approval. It does not own requirement matches or fit. |
| Jobs | Job identity, manual capture, posting and source snapshots. Manual Jobs remains usable without automatic Discovery or Companies. |
| Requirements | Qualified requirement identities, occurrences, model-determined equivalence and reusable catalog retrieval. |
| Fit | Person qualification, source-bound evidence support, scores/corrections, and relations between requirements and approved wording. |
| Resumes | Selection and assembly from approved wording, coverage manifest, edits, advisory review, acceptance, rendering and locale exports. |
| Discovery and Companies | Optional search, ingestion and independent company research; each has its own owner. |
| Contacts and Outreach | Separate contact facts and reviewed communication lifecycle; Contacts works without Outreach. |
| Applications | Screening answers, exact-payload approval, assisted execution and outcomes. Resume acceptance remains with Resumes. |
| Interviews, Learning and Digest | Preparation and session notes; plans and milestones; summaries and acknowledgements. A learning activity does not establish capability or change Fit. |
| Compensation and Offers | Neutral compensation calculations and provider ports; distinct offer terms, history and decisions. |

Dashboard, Activity, Settings and Evidence Map compose feature-owned panels or
queries. The shell owns navigation, layout and a single event connection; each
feature owns its data, commands and invalidation. A disabled optional feature
must not make an unrelated core feature depend on its private implementation.

All previously implemented capabilities except Cover Letters are in the
migration baseline. Parked feature expansion remains parked. See the
[workstream assignments](../../plans/2026-11-06-transformation-workstreams.md)
for acceptance and dependencies; those assignments are not proof of delivery.
