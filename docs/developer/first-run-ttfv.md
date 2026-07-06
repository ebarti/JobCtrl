# First-Run Time-To-Value Measurement

This protocol measures first-run time-to-value on the real product path only:
real vendor auth, real discovery from the owner's target search settings, a
real job posting found after T0, real scoring, and a real tailored resume PDF.
Synthetic data, fixtures, seeds, and CI are not valid inputs for this
measurement.

The owner runs this protocol because it can spend LLM credits and may require
interactive vendor auth. Agents may dry-check the probe logic against an
already-running stack, but must not run the real baseline unattended.

## Stop Conditions

T0 is the instant the wrapper starts the first install command,
`corepack pnpm install:interactive`.

TTFV-1 stops when both conditions are true:

- `GET /v1/jobs` returns a measured real job that was not present in the
  all-state pre-work baseline, has `discoveredAt >= T0`, has hashed real
  discovery-source provenance, and has a numeric `fitScore`
- `/jobs` renders that same job with a fit-score badge matching that score

TTFV-2 stops when all conditions are true:

- `GET /v1/apply/review-queue` returns the same measured job with a
  `materialsPreview.resumePdfArtifactId`
- `/apply-review` renders the `open final file` link for that exact PDF
- the link resolves to `/v1/artifacts/:artifactId/preview.pdf` and returns a
  non-empty PDF byte stream

The measurement record stores hashes, counts, timings, status codes, content
type, and byte length. It does not store job titles, job URLs, local artifact
paths, resume contents, provider logs, credentials, or profile data.
Machine-specific environment fields are intentionally coarse: OS family,
architecture, CPU count, memory class, and Node major version.

## Clean Environment

Run the baseline on the owner's Apple-silicon macOS reference machine. Each
run starts from a clean environment:

- no existing checkout for that run
- no `node_modules`
- no `workers/automation/.venv`
- no pnpm, uv, pip, or Playwright browser cache intentionally reused
- no existing `JOBHUNTER_DIR` for the run
- real vendor auth present or completed by the owner during setup

Record the auth scenario in the run notes outside the committed repository:
`warm-auth` when vendor auth already exists and setup reuses it, or `cold-auth`
when the owner completes auth during the run.

The gate is three clean runs. TTFV-1 passes when the median is under 10 minutes
and the worst run is under 15 minutes. TTFV-2 passes when the median is under
30 minutes and the worst run is under 45 minutes. Initial phase budgets are set
from the first owner baseline.

## Owner Command Sequence

Choose a real discovery target that the owner is willing to score and tailor.
Do not commit the target role, generated job identifiers, or the generated
measurement records. During `jobhunter init`, configure exactly one real target
role, one real target location, and the source set the owner wants measured. Do
not seed jobs, fixtures, or sample data. The wrapper captures the pre-work job
baseline across all job visibility states, then starts the real path with
`jobhunter run discover score tailor --limit 1 --workers 1`; it must not enter
the live apply path during the TTFV baseline.

```bash
export JOBHUNTER_TTFV_RUN=run-1

git clone https://github.com/ebarti/JobHunter.git "JobHunter-ttfv-${JOBHUNTER_TTFV_RUN}"
cd "JobHunter-ttfv-${JOBHUNTER_TTFV_RUN}"
git checkout main

node scripts/ttfv-real.mjs run \
  --output "$HOME/.jobhunter/measurements/ttfv-real-${JOBHUNTER_TTFV_RUN}.json"
```

Repeat from a clean environment for `run-2` and `run-3`, then summarize:

```bash
node scripts/ttfv-real.mjs summarize \
  "$HOME/.jobhunter/measurements/ttfv-real-run-1.json" \
  "$HOME/.jobhunter/measurements/ttfv-real-run-2.json" \
  "$HOME/.jobhunter/measurements/ttfv-real-run-3.json" \
  --output "$HOME/.jobhunter/measurements/ttfv-real-summary.json"
```

The summary command passes only when all inputs are gateable full-run records:
default install/init/stack commands, T0 captured on
`corepack pnpm install:interactive`, default discovery-inclusive work command,
proof that the measured job was absent from the all-state baseline and carries
`discoveredAt >= T0`, hashed real discovery-source proof, same-job proof for
both stop conditions, non-CI execution, and successful API/UI/PDF evidence.
Probe-only records, skipped phases, custom commands, seeded jobs, and
timing-only records are rejected and listed in `rejectedRecords`.

For an already-running stack that already contains real pipeline output, probe
without starting install, setup, or a new job:

```bash
node scripts/ttfv-real.mjs probe \
  --output "$HOME/.jobhunter/measurements/ttfv-probe.json"
```

Probe-only records are useful for validating selectors and API expectations.
They are never gateable clean-environment TTFV measurements because the clean
install T0, pre-work discovery baseline, post-T0 discovery proof, and phase
evidence are absent; use the full `run` command for gateable baseline evidence.
When debugging a known real job in an existing stack, pass
`--expected-job-key <read-model-job-key>` to bind the probe without storing the
raw key.

## Interpreting Results

The generated summary is an input to the packaging decision, not the decision
itself. Copy the aggregate numbers into the pending desktop-packaging ADR in
`docs/decisions.md`, including:

- median and worst TTFV-1 and TTFV-2
- phase durations from the measurement records
- auth scenario and any owner-observed friction
- platform result for macOS and any discretionary Linux sanity check

Never use a synthetic-path timing for a public product claim.
