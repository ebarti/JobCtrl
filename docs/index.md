---
layout: home

hero:
  name: JobCtrl
  text: Local-first, AI-assisted job application pipeline
  tagline: Discover jobs, score fit against your real profile, generate audited tailored materials, and apply behind explicit approval gates — all on your own machine.
  image:
    src: /assets/screenshots/dashboard.png
    alt: JobCtrl dashboard showing pipeline progress, job counts, and apply runs
  actions:
    - theme: brand
      text: Live Demo
      link: https://demo.jobctrl.dev
    - theme: alt
      text: Product Tour
      link: /user/screenshots
    - theme: alt
      text: Run From Source / Release Status
      link: /user/getting-started
    - theme: alt
      text: Developer Guide
      link: /developer/

features:
  - icon: 🔎
    title: Profile-Driven Discovery
    details: Multi-source discovery driven by your target roles, locations, and seniority — tracking where each job came from, removing duplicates, and retiring postings that have closed.
    link: /user/normal-flows
    linkText: See the daily workflow
  - icon: 🎯
    title: Explainable Scoring
    details: A versioned policy scores fit 1–10 from structured evidence, and a per-requirement ledger explains exactly why each score happened.
    link: /user/screenshots#job-detail
    linkText: See it on a job
  - icon: 📝
    title: Audited Materials
    details: Tailored resumes where every bullet traces back to its source, gates guard resumes and cover letters against invented facts, and keyword coverage is measured against the final document.
    link: /user/screenshots#apply-review
    linkText: See the review screen
  - icon: ✅
    title: Supervised Apply
    details: Rehearse with dry runs, approve every live submission explicitly, a browser-level guard blocks dry-run submits, and no application is ever submitted twice.
    link: /user/security
    linkText: The approval gates
  - icon: 🔒
    title: Local-First & Private
    details: One SQLite database and generated files under your home directory. Nothing leaves your machine except steps you explicitly configured.
    link: /user/data-and-safety
    linkText: Data, Privacy & Safety
  - icon: ⚙️
    title: Temporal-Native Pipeline
    details: Every stage runs as a durable workflow with heartbeats, classified retries, and a daily LLM spend ceiling.
    link: /user/screenshots#runs-history
    linkText: See run history
---
