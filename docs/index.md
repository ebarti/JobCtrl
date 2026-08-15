---
layout: home
title: "JobCtrl.dev — Local-first job search automation"
titleTemplate: false
description: "JobCtrl.dev is the open-source, local-first job search application for private discovery, evidence-based fit scoring, truthful resume tailoring, and supervised applications."

hero:
  name: JobCtrl
  text: Run your job search. Keep your data.
  tagline: Discover jobs, prove the fit, tailor truthful materials, and keep live submission behind your approval by default — from one local, auditable workspace.
  image:
    src: /assets/screenshots/dashboard.png
    alt: JobCtrl dashboard showing pipeline progress, job counts, and apply runs
  actions:
    - theme: brand
      text: Try the Live Demo
      link: https://demo.jobctrl.dev/
    - theme: alt
      text: Install on Apple silicon
      link: /user/getting-started
    - theme: alt
      text: See How It Works
      link: /user/product-tour
    - theme: alt
      text: View on GitHub
      link: https://github.com/ebarti/JobCtrl

features:
  - icon: 🔒
    title: Your Workspace, Locally
    details: No account and no hosted backend. Your profile, job database, generated files, browser state, and logs stay on your machine by default.
    link: /user/data-and-safety
    linkText: See the data boundary
  - icon: 🔎
    title: Profile-Driven Discovery
    details: Multi-source discovery driven by your target roles, locations, and seniority — tracking where each job came from, removing duplicates, and retiring postings that have closed.
    link: /user/discovery
    linkText: Understand discovery
  - icon: 🎯
    title: Explainable Scoring
    details: A versioned policy scores fit 1–10 from structured evidence, and a per-requirement ledger explains exactly why each score happened.
    link: /user/scoring-and-employer-analysis
    linkText: Understand scoring
  - icon: 📝
    title: Audited Materials
    details: Tailored resumes where every bullet traces back to its source, gates guard resumes and cover letters against invented facts, and keyword coverage is measured against the final document.
    link: /user/materials-and-tailoring
    linkText: Understand the audit trail
  - icon: ✅
    title: Supervised Apply
    details: Rehearse with dry runs, keep final browser submission manual, and allow only exact-approved email applications through an owned at-most-once sender.
    link: /user/apply
    linkText: Understand apply controls
  - icon: ⚙️
    title: Work That Survives Interruptions
    details: Durable workflows preserve progress through restarts, retry classified failures, and block new spendful runs when the estimated daily total exceeds a configurable threshold.
    link: /user/product-tour#runs
    linkText: See run history
---

## Help test JobCtrl on Apple silicon

JobCtrl.dev is the home of this open-source JobCtrl project. If you use an
Apple-silicon Mac, spend ten minutes with the synthetic-data demo or current
public build and tell us where the first-run experience becomes unclear.

1. [Explore the demo](https://demo.jobctrl.dev/) without entering personal data.
2. [Install the current public build](/user/getting-started) when you are ready
   to try the local workflow.
3. [Report the first point of friction](https://github.com/ebarti/JobCtrl/discussions/797),
   including your macOS version and the step you reached, but no credentials,
   resumes, application data, logs, or other personal information.

Even a short “I expected X and saw Y” report helps make the next first run
clearer.

## Practical JobCtrl Guides

- [Local-first job search automation](/guides/local-first-job-search-automation)
  — what stays local, what uses the network, and why durable workflows matter.
- [Open-source job application tracking](/guides/open-source-job-application-tracker)
  — connect jobs, evidence, materials, applications, and outcomes.
- [Resume tailoring without fabrication](/guides/resume-tailoring-without-fabrication)
  — keep the posting as context and the Candidate Profile as evidence.
- [Evidence-based job fit scoring](/guides/evidence-based-job-fit-scoring)
  — inspect requirement fit, confidence, eligibility, and corrections.
- [At-most-once application submission](/guides/at-most-once-job-application-submission)
  — stop ambiguous employer-facing work from becoming a blind retry.
- [Temporal workflows in a desktop app](/guides/temporal-workflows-desktop-app)
  — make long-running local automation recoverable and visible.
