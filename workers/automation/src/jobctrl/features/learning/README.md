# Learning

Learning owns dated selected-job cohorts, explicit user aspirations,
source-bound career comparisons, selected proposals and revisioned milestone
activity. It reads immutable Jobs postings and confirmed, supported Profile
achievement evidence through public services. Posting demand, demonstrated
evidence, aspiration and completed activity remain distinct. Completing a
milestone never confirms a skill or changes Profile or Fit.

`GET` and `POST /v1/evidence-map/learning` support read, preview, compare,
choose and update. Preview is read-only; compare checks the reviewed source
fingerprint before model spend and again in the publication transaction.
Model citations must be exact source spans. A retained comparison binds the
exact model receipt as well as its input fingerprint; milestone origins and
revision history are checked on reads and updates. Failed comparisons retain
the prior accepted result and record a safe attempt code.

Clients can supply `Idempotency-Key` on every Learning POST. The key is bound
to the exact JSON command; a different command using that key is rejected.
Successful writes and their response are stored in the same transaction and
replayed on a same-key retry. Comparisons retain their source snapshot, model
selection and uniquely scoped provider fingerprint before spend. After an
interruption, an already successful model receipt is revalidated and published
without another model call; an uncertain provider outcome is left unresolved.
Known terminal failures replay the same error; an intentionally new attempt uses
a new key. An unkeyed request does not receive this retry guarantee.

`GET /v1/evidence-map/learning/request-status` takes the same header and reports
`in_progress`, `ready_to_resume`, `complete`, `failed` or `unresolved`.
`ready_to_resume` means retrying the same key is safe, not that the source
snapshot is still current. An unresolved provider outcome requires review;
it must not cause an automatic new model call or a claim of failure.

The former tailoring-policy recommendation/review/rollback surface was tied
to the retired rule-driven resume engine. It is not a career milestone or an
implicit skills update; explicit writing preferences and user resume feedback
belong to Profile and Resumes respectively.
