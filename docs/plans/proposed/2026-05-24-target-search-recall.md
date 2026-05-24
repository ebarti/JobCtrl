# Target Search Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand profile-driven discovery searches so strong non-verbatim matches are found without changing saved profile preferences or weakening location controls.

**Architecture:** Keep exact target-role queries as tier 1. Add deterministic lower-tier recall queries derived from the same target-role intent, and mark those queries with a recall title-match mode so broad-board candidates can pass when they match the domain plus seniority/leadership intent. Keep Workday and ATS searches on tier 1 for now, so the larger recall net applies first to JobSpy broad-board lead generation.

**Tech Stack:** Python worker discovery config, JobSpy adapter, shared title filtering helpers, pytest.

---

### Task 1: Add Target Query Expansion

**Files:**
- Create: `workers/automation/src/jobhunter/discovery/target_queries.py`
- Modify: `workers/automation/src/jobhunter/config.py`
- Test: `workers/automation/tests/test_target_search_preferences.py`

- [x] **Step 1: Define deterministic exact-plus-recall query planning**

Add a helper that turns target roles into ordered query dictionaries. Exact profile roles stay tier 1 with strict matching. Recall queries are tier 2, deduped against exact roles, and carry `match_mode: "recall"` plus `generated_from: "target_roles"`.

- [x] **Step 2: Wire profile target roles through the planner**

Replace the direct `next_cfg["queries"] = [{"query": role, "tier": 1} ...]` assignment with the planner output. Preserve `workday_max_tier = 1` and `ats_max_tier = 1` so direct ATS crawlers do not broaden until source-level evidence supports it.

- [x] **Step 3: Update target-search tests**

Assert that exact roles remain first and tier 1, recall queries are present as tier 2, profile notes are still stripped, and Workday/ATS tier caps remain exact-only.

### Task 2: Add Recall-Safe Title Matching

**Files:**
- Modify: `workers/automation/src/jobhunter/discovery/title_filter.py`
- Modify: `workers/automation/src/jobhunter/discovery/jobspy.py`
- Test: `workers/automation/tests/test_title_filter.py`
- Test: `workers/automation/tests/test_discovery_limits.py`

- [x] **Step 1: Preserve strict matching for exact queries**

Keep `title_matches_query(title, query)` behavior unchanged by default so existing exact target roles and direct ATS paths keep their current precision.

- [x] **Step 2: Add recall match mode**

Allow `title_matches_query(title, query, match_mode="recall")` to pass when the title contains both a leadership/seniority signal and a domain signal inferred from the generated query. This catches examples like `Head of Technology`, `Director, Cybersecurity`, and `Platform Engineering Manager`, while rejecting plain IC titles like `Software Engineer`.

- [x] **Step 3: Pass query match mode through JobSpy searches**

Carry query metadata from `_full_crawl()` into `_run_one_search()` and use it when filtering returned JobSpy rows by title.

- [x] **Step 4: Add unit coverage**

Cover strict-vs-recall differences in the title filter and a JobSpy adapter test showing recall-mode candidates are stored while non-leadership rows are filtered.

### Task 3: Document And Verify

**Files:**
- Modify: `README.md`
- Modify: `docs/local-ts-api.md`
- Modify: `docs/job-pipeline-architecture.md`

- [x] **Step 1: Document search behavior**

Update the target-search sections to state that profile roles generate exact tier-1 queries plus deterministic lower-tier broad-board recall queries, while Workday/ATS remain exact-tier by default.

- [x] **Step 2: Verify targeted Python behavior**

Run `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_target_search_preferences.py workers/automation/tests/test_title_filter.py workers/automation/tests/test_discovery_limits.py`.

- [x] **Step 3: Verify formatting and branch diff**

Run `git diff --check` before committing.
