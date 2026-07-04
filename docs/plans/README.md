# Plan Archive

Plans are historical working documents. Canonical project documentation lives
at the top of `docs/`.

- Top level: accepted plans that are not fully delivered (currently the OSS
  release remediation spec).
- `implemented/`: plans, specs, QA checklists, and delivery notes for work
  that has landed or been superseded by canonical docs.

When a plan is fully implemented, move it into `implemented/` with a status
banner recording the delivery PRs and any deviations, and update the canonical
docs to describe the delivered behavior. Delivery history lives in the git log
(Conventional Commits) and in the plan records themselves; the separate
`docs/delivered.md` changelog was retired on 2026-07-04.
