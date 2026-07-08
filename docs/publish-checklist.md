# Publish-Mechanics Checklist

> **Repository-only.** Excluded from the published docs site (registered in
> `docs/.vitepress/config.ts` `UNPUBLISHED_FILES` + `srcExclude`, like
> `docs/backlog.md` and `docs/claims-ledger.md`). It is launch-governance, not
> user documentation.
>
> Implements Phase C of
> [`docs/plans/implemented/2026-07-05-launch-readiness-artifacts-plan.md`](plans/implemented/2026-07-05-launch-readiness-artifacts-plan.md)
> §9.

## Purpose and boundary

A concrete, verifiable checklist for the **mechanical** publish steps, each with
a verification and a rollback note. This checklist **prepares and verifies** the
steps; it does **not** execute them.

The **authoritative release gate is OSS spec §5**
([`docs/plans/implemented/2026-07-03-oss-release-remediation-spec.md`](plans/implemented/2026-07-03-oss-release-remediation-spec.md)
§5 "Release gate — flipping public"). That gate owns the capability and privacy
preconditions (W0.\* privacy scanner, W1.\* apply safety, W2.\* naming/governance,
Temporal P1b–P5). This checklist does not duplicate those; it lists only the
publish *mechanics* that feed the gate. **Do not flip visibility, deploy the
public docs site, or tag a release until every OSS spec §5 box is checked.**

## Owner-only actions (do not execute here)

Every step below is an **owner-only** action. Implementing agents prepare and
verify; the repository owner executes. Steps 9.3 and 9.4 additionally depend on
the pre-publication rename train and are **out of scope for R7a** — they belong
to the rename train / post-rename launch assets (R7b).

## Steps

### 9.1 — Repository visibility flip (owner-only)

- **Action.** Owner flips `github.com/ebarti/JobCtrl` from private to public.
- **Verification.**
  - `release-check` (`.github/workflows/release-check.yml`) is green on `main`
    for every commit since W0.4 landed (it triggers on every `push` to `main`
    and is also available through `workflow_dispatch` for maintainer-reviewed
    branches).
  - `python3 scripts/release_check.py` reports zero findings locally on the
    exact commit to be published.
  - Every box in OSS spec §5 is checked, including the final human manual QA
    (`jobctrl doctor` clean; seeded `/apply-review` approval → dry-run
    evidence → gated submit; one harness dry-run showing blocked-channel
    evidence; no real applications).
- **Rollback.** Flip back to private. **Honest limitation:** anything fetched
  while the repository was public cannot be recalled, and git history remains
  reachable — the real mitigation is the pre-flip privacy gate, not rollback.
  OSS spec §1 records the owner's acceptance of historical blobs remaining
  reachable.

### 9.2 — Docs-site deploy (owner-only)

- **Preconditions (OSS spec §5 gate).** Deploying `docs/.vitepress/dist` to the
  public `jobctrl-docs` Cloudflare project is itself a going-public act, so it
  carries the **same OSS spec §5 gate as 9.1**. The `deploy` job in
  `docs-site.yml` is gated only on `DOCS_DEPLOY_ENABLED` and `main` — **not**
  on `release-check` — so this checklist is the
  only guard. Before setting `DOCS_DEPLOY_ENABLED` or configuring the Cloudflare
  secrets:
  - `python3 scripts/release_check.py` reports zero findings locally on the
    exact commit to be deployed, and `release-check`
    (`.github/workflows/release-check.yml`) is green on that `main` commit.
  - Every box in OSS spec §5 is checked — in particular the W0.\* privacy
    scanner, the owner's recorded capability-posture acceptance, and the final
    human manual QA — exactly as required for 9.1.
  - The claims-ledger freeze (`docs/claims-ledger.md`, GATE G1) is re-stamped at
    the actual freeze `main` sha and owner-signed, so the public site cannot
    ship provisional or unsigned public claims.
- **Action.** Set the repository variable `DOCS_DEPLOY_ENABLED=true` and the two
  Cloudflare secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) so the
  `deploy` job in `.github/workflows/docs-site.yml` runs from `main` (it is
  gated on `vars.DOCS_DEPLOY_ENABLED == 'true'` and `main`;
  it deploys `docs/.vitepress/dist` to the Cloudflare Pages project
  `jobctrl-docs`).
- **Verification.** On the next `main` push the `deploy` job runs (not skipped),
  the site serves, and `pnpm docs:build` + `pnpm docs:check:runtime` are green on
  the built artifact.
- **Rollback.** Unset `DOCS_DEPLOY_ENABLED` → the `deploy` job skips cleanly and
  the workflow stays green. If a bad build shipped, redeploy the previous
  `docs-site-dist` artifact.

### 9.3 — Repository-rename redirect (owner-only; rename landed 2026-07-07)

> **Update 2026-07-07.** The rename train
> ([`docs/plans/implemented/2026-07-05-rename-jobctrl-plan.md`](plans/implemented/2026-07-05-rename-jobctrl-plan.md))
> has merged and the repository is `ebarti/JobCtrl`; `REPO_URL` already points
> at it. What remains is verifying the old-URL redirects at the visibility
> flip.

- **Action.** After the visibility flip, verify GitHub's
  automatic old-URL redirects resolve; `REPO_URL` in
  `docs/.vitepress/config.ts` and the README badges already point at
  `ebarti/JobCtrl`; re-run `pnpm docs:build` if any link needed fixing.
- **Rollback (for reference).** Rename back (GitHub reserves the prior name);
  revert the `REPO_URL`/link edits.

### 9.4 — Release tagging (owner-only; rename landed 2026-07-07, mechanics ready)

> **Update 2026-07-07.** The distribution is renamed (`pyproject` name
> `jobctrl`) and the tag trigger (`push: tags: v*`) is restored in
> `.github/workflows/publish.yml`; `release_check` enforces both. The "Publish
> to PyPI" workflow remains `disabled_manually` on GitHub as the safety catch.

- **Action.** Confirm the `jobctrl` PyPI name is held, re-enable the "Publish
  to PyPI" workflow, then tag the first public release; the tag build is gated
  on the release-check workflow passing.
- **Rollback.** Delete the tag; if a bad artifact published to PyPI, yank it;
  re-disable the workflow.

### 9.5 — Homebrew tap publication (owner-only; new 2026-07-07)

The formula's canonical copy lives in-repo at
`packaging/homebrew/Formula/jobctrl.rb` (head-only spec until the first
tag). The tap repository `ebarti/homebrew-tap` already exists (it ships
`claude-notifier` and `skills`), and `Formula/jobctrl.rb` is committed in the
owner's local tap clone (`~/Github/homebrew-tap`, commit `d76b052`) —
**unpushed**, so nothing is published yet. At release:

- **Action.** Push the tap commit (`git -C ~/Github/homebrew-tap push`); at
  the first public tag, add the stable `url` (tag tarball) and its `sha256`
  to both copies, re-run `brew style`/`brew audit --formula`, push the tap
  update, and verify `brew install ebarti/tap/jobctrl` end to end. The
  README's Get Started section already documents the tap command.
- **Rollback.** Revert or delete `Formula/jobctrl.rb` in the tap; the
  README's script and manual paths are unaffected.

## Status summary

| Step | Owner-only | Rename-gated | Status |
| --- | --- | --- | --- |
| 9.1 Visibility flip | Yes | No | Prepared + verifiable; owner executes |
| 9.2 Docs-site deploy | Yes | No | Prepared + verifiable; owner executes |
| 9.3 Rename redirect | Yes | Landed 2026-07-07 | Redirect verify at flip; owner executes |
| 9.4 Release tagging | Yes | Landed 2026-07-07 | Mechanics ready; owner re-enables + tags |
| 9.5 Homebrew tap | Yes | No | Formula in-repo + staged in local tap clone; owner pushes + pins stable spec at first tag |
