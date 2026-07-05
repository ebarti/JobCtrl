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
      text: How It Works
      link: /architecture/
    - theme: alt
      text: Developer Guide
      link: /developer/

features:
  - icon: 🔎
    title: Profile-Driven Discovery
    details: Multi-source discovery driven by your target roles, locations, and seniority — with provenance, dedup evidence, and a closed list for dead postings.
    link: /user/normal-flows
    linkText: See the flows
  - icon: 🎯
    title: Explainable Scoring
    details: A versioned policy scores fit 1–10 from structured evidence, and a per-requirement ledger explains exactly why each score happened.
    link: /architecture/scoring
    linkText: Scoring architecture
  - icon: 📝
    title: Audited Materials
    details: Tailored resumes and cover letters with per-bullet provenance, fabrication gates, and keyword coverage computed against the shipped text.
    link: /architecture/materials
    linkText: Materials & audit
  - icon: ✅
    title: Supervised Apply
    details: Dry-run first, an explicit approval before any live submission, a browser-layer dry-run guard, and at-most-once submits.
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
