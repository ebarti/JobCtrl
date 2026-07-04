---
layout: home

hero:
  name: JobHunter
  text: Local-first, AI-assisted job application pipeline
  tagline: Discover jobs, score fit against your real profile, generate audited tailored materials, and apply under explicit consent gates — all on your own machine.
  actions:
    - theme: brand
      text: Get Started
      link: /user/getting-started
    - theme: alt
      text: Product Tour
      link: /user/screenshots
    - theme: alt
      text: Developer Guide
      link: /developer/

features:
  - icon: 🔎
    title: Profile-Driven Discovery
    details: Multi-source discovery driven by your target roles, locations, and seniority — tracking where each job came from, removing duplicates, and retiring postings that have closed.
    link: /user/normal-flows
    linkText: See the flows
  - icon: 🎯
    title: Explainable Scoring
    details: A versioned policy scores fit 1–10 from structured evidence, and a per-requirement ledger explains exactly why each score happened.
    link: /architecture/scoring
    linkText: Scoring architecture
  - icon: 📝
    title: Audited Materials
    details: Tailored resumes and cover letters where every bullet traces back to its source, gates guard against invented facts, and keyword coverage is measured against the final document.
    link: /architecture/materials
    linkText: Materials & audit
  - icon: ✅
    title: Supervised Apply
    details: Dry-run first, an explicit approval before any live submission, a browser-level guard during dry runs, and no application is ever submitted twice.
    link: /user/security
    linkText: The consent gates
  - icon: 🔒
    title: Local-First & Private
    details: One SQLite database and generated files under your home directory. Nothing leaves your machine except steps you explicitly configured.
    link: /user/data-and-safety
    linkText: Data & safety
  - icon: ⚙️
    title: Temporal-Native Pipeline
    details: Every stage runs as a durable workflow with heartbeats, classified retries, and a daily LLM spend ceiling.
    link: /architecture/pipeline/
    linkText: Pipeline internals
---
