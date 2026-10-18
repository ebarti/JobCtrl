# Optional Company Briefings

Company briefings provide reusable public context alongside a saved job's role
analysis and interview preparation. They are optional and never change fit
scores, resumes, application approvals or submissions. The existing dashboard
and CLI digest link to up to five recently linked companies; they do not create
another digest or research schedule.

## Configure and refresh

This first version is configured and refreshed through the local CLI. The web
app displays saved results. Start with a canonical JobId from Job Detail:

```bash
jobctrl company-briefing configure JOB_ID \
  --company-url https://example.com/ \
  --source https://example.com/about \
  --source https://example.com/news \
  --confirm-identity
jobctrl company-briefing refresh JOB_ID --allow-public-fetch
jobctrl company-briefing show JOB_ID
```

Replace the example URLs with the exact public company and source pages you
have reviewed. Repeat `--source` for up to three pages. Configuration makes no
network calls. `--confirm-identity` confirms that this job belongs to that
company. Repeat configuration for each job that should share the briefing.
Equal company names never establish that link. Different company URLs, including
distinct paths on one hostname, retain separate identities. If the saved job's
employer name changes, the old link is visibly awaiting identity review.

The shared source list belongs to the company: changing it affects every
explicitly linked job and marks its previous briefing stale. Sources cannot
contain credentials, query strings or fragments. Fetching uses anonymous public
HTTP(S), never your browser session, Gmail, profile or resumes. No search query
is generated. The configured enrichment provider receives only the company
identity and bounded public source text; normal lane and daily spend limits apply.

An explicit refresh permits at most three pages, one redirect per page, six
HTTP page requests, a 10-second socket timeout and 1 MiB per response. Existing
public-destination checks, DNS/socket pinning, host pacing and rate-limit policy
apply. Redirects must remain on an explicitly selected source hostname and
cannot introduce credentials or query strings. Each page contributes at most
12,000 visible-text characters. These limits can produce incomplete evidence;
a blocked or unusable source fails the refresh instead of silently dropping it.

A briefing within the seven-day freshness window is reused without fetching or
spending. Add `--force` to deliberately re-fetch it. Identical captured text and
model inputs reuse the accepted determination without another model call.
There is no background refresh. Reading a briefing or opening the digest never
starts provider or network work. All commands support `--json`.

## Inspect the evidence

Job Detail's **Role Analysis** and the selected-job **Interviews** view show the
same accepted briefing. Claims are separated into **Company facts**, **Reported
events** and **Hypotheses**, each with uncertainty and expandable verbatim source
excerpts. Source links retain observation dates and hashes of the bounded text.
An event date appears only when copied from a cited source; an observation date
does not establish when the event occurred. Provenance exposes the persisted
determination ID, provider, model and prompt version.

Seven days is a visibility rule, not proof that a fact remains correct. Older
observations remain clearly stale. Failed refreshes show their failure code and
preserve the last accepted snapshot, including its original observation clock.
Ambiguous source identity requires review of the company and source selection.
Its failed-attempt details retain the model reason, determination ID and observed
source snapshots without replacing the accepted briefing.
A model or source failure never substitutes a guess. If stored provenance cannot
be verified, the web view reports that the briefing is unavailable and preserves
its stored history.

Job-specific implications remain with role analysis and interview preparation.
This first version presents company context for your review; it does not inject
company claims into generated answers or applicant evidence.

## Local retention

Reviewed company links, source configuration, captured public text, accepted
briefings, refresh attempts and model receipts are stored in the local database.
Job links follow the canonical job's lifetime; the reusable company history is
retained independently, including after its last linked job is removed. There
is no automatic deletion or dedicated briefing-history purge command.
