# JobHunter

**Applied to 1,000 jobs in 2 days. Fully autonomous. Open source.**

[![PyPI version](https://img.shields.io/pypi/v/jobhunter?color=blue)](https://pypi.org/project/jobhunter/)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ebarti/JobHunter?style=social)](https://github.com/ebarti/JobHunter)

---

## What It Does

JobHunter is a staged autonomous job application pipeline. It discovers jobs across 5+ boards, scores them against your resume with AI, tailors your resume per job, writes cover letters, converts them to upload-ready PDFs, and can **submit applications for you**. It navigates forms, uploads documents, answers screening questions, all hands-free.

Run the whole pipeline in one shot, or drive each stage directly.

```bash
pip install jobhunter
pip install --no-deps python-jobspy && pip install pydantic tls-client requests markdownify regex
jobhunter init          # one-time setup: resume, profile, preferences, API keys
jobhunter doctor        # verify your setup — shows what's installed and what's missing
jobhunter run           # discover > enrich > score > tailor > cover letters
jobhunter run -w 4      # parallel discovery, enrichment, scoring, and tailoring
jobhunter discover      # run only stage 1
jobhunter enrich        # run only stage 2
jobhunter score -w 4    # run only stage 3 with parallel LLM scoring
jobhunter tailor -w 4   # run only stage 4 with parallel LLM tailoring
jobhunter cover         # run only stage 5
jobhunter pdf           # convert pending resumes / cover letters to PDF
jobhunter apply         # autonomous browser-driven submission
jobhunter apply -w 3    # parallel apply (3 Chrome instances)
jobhunter apply --dry-run  # fill forms without submitting
```

> **Why two install commands?** `python-jobspy` pins an exact numpy version in its metadata that conflicts with pip's resolver, but works fine at runtime with any modern numpy. The `--no-deps` flag bypasses the resolver; the second command installs jobspy's actual runtime dependencies. Everything except `python-jobspy` installs normally.

---

## Two Paths

### Full Pipeline (recommended)
**Requires:** Python 3.11+, TeX Live/MacTeX (`pdflatex`), Node.js (for npx), Gemini API key (free), Claude Code CLI, Chrome

Runs every pipeline stage, then launches autonomous application submission. This is the full power of JobHunter.

### Discovery + Tailoring Only
**Requires:** Python 3.11+, TeX Live/MacTeX (`pdflatex`), Gemini API key (free)

Runs discovery, enrichment, scoring, tailoring, cover-letter generation, and PDF conversion. You submit applications manually with the AI-prepared materials.

---

## The Pipeline

| Stage | What Happens |
|-------|-------------|
| **1. Discover** | Scrapes 5 job boards (Indeed, LinkedIn, Glassdoor, ZipRecruiter, Google Jobs) + 48 Workday employer portals + 30 direct career sites |
| **2. Enrich** | Fetches full job descriptions via JSON-LD, CSS selectors, or AI-powered extraction |
| **3. Score** | AI rates every job 1-10 based on your resume and preferences. Only high-fit jobs proceed |
| **4. Tailor** | AI rewrites your resume per job: reorganizes, emphasizes relevant experience, adds keywords. Never fabricates |
| **5. Cover Letter** | AI generates a targeted cover letter per job |
| **6. PDF** | Converts tailored resumes and cover letters into upload-ready PDFs |

Each stage is independent. Run `jobhunter run` for the full pipeline, or
call `jobhunter discover`, `jobhunter enrich`, `jobhunter score`,
`jobhunter tailor`, `jobhunter cover`, and `jobhunter pdf` individually.

Auto-apply is a separate command that consumes the generated materials and submits applications.

---

## JobHunter vs The Alternatives

| Feature | JobHunter | AIHawk | Manual |
|---------|-----------|--------|--------|
| Job discovery | 5 boards + Workday + direct sites | LinkedIn only | One board at a time |
| AI scoring | 1-10 fit score per job | Basic filtering | Your gut feeling |
| Resume tailoring | Per-job AI rewrite | Template-based | Hours per application |
| Auto-apply | Full form navigation + submission | LinkedIn Easy Apply only | Click, type, repeat |
| Supported sites | Indeed, LinkedIn, Glassdoor, ZipRecruiter, Google Jobs, 46 Workday portals, 28 direct sites | LinkedIn | Whatever you open |
| License | AGPL-3.0 | MIT | N/A |

---

## Requirements

| Component | Required For | Details |
|-----------|-------------|---------|
| Python 3.11+ | Everything | Core runtime |
| TeX Live/MacTeX (`pdflatex`) | Resume PDFs | Required for tailored resume PDF generation |
| Node.js 18+ | Auto-apply | Needed for `npx` to run Playwright MCP server |
| Gemini API key | Scoring, tailoring, cover letters | Free tier (15 RPM / 1M tokens/day) is enough |
| Chrome/Chromium | Auto-apply | Auto-detected on most systems |
| Claude Code CLI | Auto-apply | Install from [claude.ai/code](https://claude.ai/code) |

**Gemini API key is free.** Get one at [aistudio.google.com](https://aistudio.google.com). OpenAI and local models (Ollama/llama.cpp) are also supported.

### Optional

| Component | What It Does |
|-----------|-------------|
| CapSolver API key | Solves CAPTCHAs during auto-apply (hCaptcha, reCAPTCHA, Turnstile, FunCaptcha). Without it, CAPTCHA-blocked applications just fail gracefully |

> **Note:** python-jobspy is installed separately with `--no-deps` because it pins an exact numpy version in its metadata that conflicts with pip's resolver. It works fine with modern numpy at runtime.

---

## Configuration

All generated by `jobhunter init`:

### `profile.json`
Your personal data in one structured file: contact info, work authorization, compensation, structured resume entries, skills, tailoring constraints, and EEO defaults. Powers scoring, tailoring, PDF rendering, and form auto-fill.

The `resume` block is mandatory. JobHunter uses it as the canonical resume template for LaTeX rendering and fact-preserving tailoring:

```json
{
  "resume": {
    "executive_profile": {"baseline_text": "Short factual summary."},
    "experience_entries": [
      {
        "id": "current_role",
        "date_range": "Jan 2022 -- Present",
        "title": "Software Engineer",
        "company": "Example Corp",
        "location": "Remote",
        "bullets": ["Built and maintained production services."]
      }
    ],
    "education_entries": [],
    "skill_categories": [
      {"id": "languages", "label": "Languages", "items": ["Python", "SQL"]}
    ],
    "tailoring_rules": {
      "required_experience_entry_ids": ["current_role"],
      "required_skill_category_ids": ["languages"],
      "max_experience_bullets": 4
    }
  }
}
```

### `searches.yaml`
Job search queries, target titles, locations, boards. Run multiple searches with different parameters.

### `.env`
API keys and runtime config: `GEMINI_API_KEY`, `LLM_MODEL`, `CAPSOLVER_API_KEY` (optional).

Do not commit `~/.jobhunter/profile.json`, `.env`, generated prompts, logs, tailored resumes, PDFs, browser worker directories, or SQLite databases. The repository `.gitignore` excludes these local artifacts by default.

### Package configs (shipped with JobHunter)
- `config/employers.yaml` - Workday employer registry (48 preconfigured)
- `config/sites.yaml` - Direct career sites (30+), blocked sites, base URLs, manual ATS domains
- `config/searches.example.yaml` - Example search configuration

---

## How Stages Work

### Discover
Queries Indeed, LinkedIn, Glassdoor, ZipRecruiter, Google Jobs via JobSpy. Scrapes 48 Workday employer portals (configurable in `employers.yaml`). Hits 30 direct career sites with custom extractors. Deduplicates by URL.

### Enrich
Visits each job URL and extracts the full description. 3-tier cascade: JSON-LD structured data, then CSS selector patterns, then AI-powered extraction for unknown layouts.

### Score
AI scores every job 1-10 against your profile. 9-10 = strong match, 7-8 = good, 5-6 = moderate, 1-4 = skip. Only jobs above your threshold proceed to tailoring.

### Tailor
Generates a custom resume per job: reorders experience, emphasizes relevant skills, incorporates keywords from the job description. Your `resume_facts` (companies, projects, metrics) are preserved exactly. The AI reorganizes but never fabricates.

### Cover Letter
Writes a targeted cover letter per job referencing the specific company, role, and how your experience maps to their requirements.

### PDF
Converts tailored resumes and cover letters into upload-ready PDFs. Resume PDFs require `pdflatex`; run `jobhunter doctor` before relying on PDF conversion.

### Auto-Apply
Claude Code launches a Chrome instance, navigates to each application page, detects the form type, fills personal information and work history, uploads the tailored resume and cover letter, answers screening questions with AI, and submits. A live dashboard shows progress in real-time.

The Playwright MCP server is configured automatically at runtime per worker. No manual MCP setup needed.

```bash
# Utility modes (no Chrome/Claude needed)
jobhunter apply --mark-applied URL    # manually mark a job as applied
jobhunter apply --mark-failed URL     # manually mark a job as failed
jobhunter apply --reset-failed        # reset all failed jobs for retry
jobhunter apply --gen --url URL       # generate prompt file for manual debugging
```

---

## CLI Reference

```
jobhunter init                         # First-time setup wizard
jobhunter discover                     # Run only discovery
jobhunter enrich                       # Run only enrichment
jobhunter score                        # Run only scoring
jobhunter tailor                       # Run only resume tailoring
jobhunter tailor --retailor            # Re-run tailoring for already-tailored jobs
jobhunter cover                        # Run only cover letter generation
jobhunter pdf                          # Convert pending text artifacts to PDF
jobhunter doctor                       # Verify setup, diagnose missing requirements
jobhunter run [stages...]              # Run pipeline stages (or 'all')
jobhunter run --workers 4              # Parallel discovery/enrichment/score/tailor
jobhunter run --stream                 # Concurrent stages (streaming mode)
jobhunter run --min-score 8            # Override score threshold
jobhunter run --dry-run                # Preview without executing
jobhunter run --validation lenient     # Relax validation (recommended for Gemini free tier)
jobhunter run --validation strict      # Strictest validation (retries on any banned word)
jobhunter run tailor --retailor        # Re-tailor resumes in a sequential run
jobhunter apply                        # Launch auto-apply
jobhunter apply --workers 3            # Parallel browser workers
jobhunter apply --dry-run              # Fill forms without submitting
jobhunter apply --continuous           # Run forever, polling for new jobs
jobhunter apply --headless             # Headless browser mode
jobhunter apply --url URL              # Apply to a specific job
jobhunter status                       # Pipeline statistics
jobhunter dashboard                    # Open HTML results dashboard
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and PR guidelines.

---

## License

JobHunter is licensed under the [GNU Affero General Public License v3.0](LICENSE).

You are free to use, modify, and distribute this software. If you deploy a modified version as a service, you must release your source code under the same license.

## Responsible Use

JobHunter can fill and submit job applications with personal data. You are responsible for reviewing generated materials, answering truthfully, respecting each site's terms, and choosing whether autonomous submission is appropriate for your situation. Use `jobhunter apply --dry-run` before unattended submissions.
