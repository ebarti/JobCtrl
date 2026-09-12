# Application URL authority inventory

The exact-v10 boundary removes the `jobs.application_url` column. Application
URLs remain valid domain values; removing the legacy storage authority does not
remove canonical targets, approval snapshots, event evidence, or API fields.

| Reader or writer | Current source and behavior |
| --- | --- |
| TypeScript and Python list/detail/dashboard projection builders | Read `job_enrichments.application_url` only. They never restore a cleared target from an alias. |
| API job detail lookup and write-model action/reset/delete lookup | Resolve tenant-scoped canonical/posting identity first, then a unique enrichment or application alias. Shared application endpoints fail closed. |
| Python administrative stage reset | Uses the same tenant-scoped unique locator semantics. |
| TypeScript and Python repeat-application identity | Read canonical enrichment target, then the existing posting URL fallback. Historical aliases are not target authority. |
| API application review and approval validation | Bind the canonical enrichment target, retaining the existing posting URL fallback when no target is available. Saved review/run URLs remain immutable evidence. |
| API resume-template privacy guard | Checks canonical enrichment and retained historical URL aliases for the selected tenant, so migrated private facts cannot leak into reusable templates. |
| Python job loaders and stage readers | Join canonical enrichment and expose its `application_url` in the existing job DTO. Apply, browser navigation, scoring, tailoring, and prompt consumers use that DTO. |
| Detail enrichment discovery-description fallback | Reads the existing discovery description with the canonical enrichment URL; no legacy target fallback. |
| Enrichment repository | Writes only canonical enrichment and retains a lookup alias; no legacy job-column write. |
| JobSpy and Workday discovery metadata refresh | Fills an absent canonical URL with a pending enrichment and retains observed aliases. It leaves a nonempty canonical target unchanged. |
| Gmail application anchors | Join canonical enrichment by tenant and JobId. Feedback scan persistence uses canonical identities and exact runtime admission. |
| Permanent job purge | Captures canonical and historical aliases for existing reference cleanup; the job foreign key removes owned aliases without touching another tenant/job. |
| API, browser QA, and worker current-runtime fixtures | Seed enrichment URLs directly against the exact current schema. Migration fixtures alone seed the historical column. |

`job_application_locators` is a lookup relation, separate from posting locators:
several jobs can share one application form without weakening posting identity
uniqueness. Migration retains both values when canonical and legacy URLs differ.
A null/empty canonical value receives the nonempty legacy value; other enrichment
state is preserved. Alias rows never drive submission, projections, or approval
binding after migration.

The frozen `schema_v7.sql`, historical v6 preparation helpers (including the
wide-column registry and v6 enrichment backfill), and v6/v7/v8/v9 migration
executors still describe the old column. They are isolated compatibility inputs
to the stopped-runtime candidate chain. They are not invoked by exact-v10 runtime
admission. Historical tests intentionally retain those definitions. The new
v9-to-v10 transfer is the final reader of legacy values before column removal.

Verification combines an exact migration preservation matrix, tenant/ambiguity
lookup regressions, a shared cross-runtime migration/projection fixture,
canonical application review tests, discovery/enrichment tests, and native
paired-backup/recovery tests. All migration and recovery fixtures use owned
synthetic databases; they do not establish migration of a real installation.
