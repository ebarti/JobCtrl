# Roadmap

JobCtrl's public direction is a reliable local job-search workflow with
inspectable evidence and explicit user control. [GitHub Issues](https://github.com/ebarti/JobCtrl/issues)
own scope, acceptance criteria, dependencies and current status. The
[migration index #881](https://github.com/ebarti/JobCtrl/issues/881) records the
disposition of earlier backlog entries; an issue is not an execution commitment.

## Reliability And Trust

- Reconcile signed-distribution acceptance against the published release bytes
  and clean-machine evidence ([#884](https://github.com/ebarti/JobCtrl/issues/884)).
- Complete native credential stores and persistent-secret migration
  ([#888](https://github.com/ebarti/JobCtrl/issues/888)), define sensitive-artifact
  retention ([#887](https://github.com/ebarti/JobCtrl/issues/887)), and attribute
  LLM usage and ceilings to workflow lanes ([#886](https://github.com/ebarti/JobCtrl/issues/886)).
- Prove the remaining Apply Review audit, workflow status and profile-discard
  QA paths ([#892](https://github.com/ebarti/JobCtrl/issues/892),
  [#894](https://github.com/ebarti/JobCtrl/issues/894),
  [#893](https://github.com/ebarti/JobCtrl/issues/893)).

## Evidence And Everyday Use

- Design a coherent profile-evidence interview and selective resume-composition
  program ([#883](https://github.com/ebarti/JobCtrl/issues/883)), including editable
  target-search suggestions ([#902](https://github.com/ebarti/JobCtrl/issues/902))
  and evidence-backed coaching ([#903](https://github.com/ebarti/JobCtrl/issues/903)).
- Finish eligible realtime list patches and the remaining application-URL
  cleanup ([#890](https://github.com/ebarti/JobCtrl/issues/890),
  [#891](https://github.com/ebarti/JobCtrl/issues/891)); measure local performance
  before choosing optimizations ([#889](https://github.com/ebarti/JobCtrl/issues/889)).
- Add saved views for source review ([#901](https://github.com/ebarti/JobCtrl/issues/901)),
  import vCard contacts with provenance ([#900](https://github.com/ebarti/JobCtrl/issues/900)),
  and enforce frontend boundaries with linting ([#895](https://github.com/ebarti/JobCtrl/issues/895)).

## Decisions Before Implementation

- Define the complete local/custom LLM-provider contract
  ([#897](https://github.com/ebarti/JobCtrl/issues/897)).
- Resolve public-demo access and consent withdrawal
  ([#885](https://github.com/ebarti/JobCtrl/issues/885)).
- Define portable workspace export and import
  ([#904](https://github.com/ebarti/JobCtrl/issues/904)).

Delivered behavior belongs in the [README](README.md) and owning documentation;
delivery evidence remains in the git log and [plan records](docs/plans/).
