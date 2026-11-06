# Offers feature

Offers owns private, user-confirmed offer terms, revisions and decisions. It
is separate from Compensation: a benchmark never becomes an actual offer, and
unknown equity, benefits, currency, periods and deadlines stay unknown. Each
term carries the user's source reference, verbatim quote, capture time and
explicit confirmation. Revising terms or correcting a decision requires the
current revision/decision ID and a correction reason; previous records remain
in the append-only history. First terms also request an idempotent Applications
offer milestone through its public port in the same transaction when that
optional feature is present.

The application service depends on the feature-owned ledger repository and its
transaction interface. The SQLite adapter supplies the Jobs existence check,
append-only writes, optional Applications milestone and ID-only event through
one shared transaction; it also joins the transaction supplied by Jobs for
reviewed permanent deletion. Source-bound reads accept the caller's transaction
so Outreach can recheck the exact terms and decision before publication. Offers
does not invoke a model; its confirmed records are inputs to other features.

`GET /v1/jobs/{id}/offer` reads the ledger;
`POST /v1/jobs/{id}/offer/terms` and `/decisions` append reviewed revisions.
`current_terms` and `assert_terms_current` expose copied, source-bound context
for Outreach, and a reviewed permanent job deletion calls `delete_job_data`
in Jobs' transaction. General events carry IDs only. HTTP and application
checks exist, while integrated browser/Temporal and full optional-feature
composition remain coordinator-owned acceptance work.
