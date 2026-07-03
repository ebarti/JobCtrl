# Target Search Recall Implementation Plan

> **Status:** Implemented. Canonical current behavior is documented in
> `README.md`, `docs/local-ts-api.md`, and
> `docs/job-pipeline-architecture.md`; the delivery summary is in
> `docs/delivered.md`.

**Goal:** Expand profile-driven discovery searches so strong non-verbatim matches are found without changing saved profile preferences or weakening location controls.

**Architecture:** Keep exact target-role queries as tier 1. Add deterministic recall queries derived from the same target-role intent, keep them in the same tier, and mark them with a recall title-match mode so candidates can pass when they match the domain plus seniority/leadership intent. Broad-board providers use recall queries as retrieval probes; direct ATS and Workday sources enumerate known boards/employers and apply the same exact-plus-recall intent internally. Relevance remains a scoring concern after discovery; query generation should not downrank candidates before they are seen.

**Tech Stack:** Python worker discovery config, JobSpy adapter, shared title filtering helpers, pytest.

---

### Task 1: Add Target Query Expansion

**Files:**
- Create: `workers/automation/src/jobhunter/discovery/target_queries.py`
- Modify: `workers/automation/src/jobhunter/config.py`
- Test: `workers/automation/tests/test_target_search_preferences.py`

- [x] **Step 1: Define deterministic exact-plus-recall query planning**

Add a helper that turns target roles into ordered query dictionaries. Exact profile roles stay tier 1 with strict matching. Recall queries also stay tier 1, are deduped against exact roles, and carry `match_mode: "recall"` and `generated_from: "target_roles"`.

- [x] **Step 2: Wire profile target roles through the planner**

Replace the direct `next_cfg["queries"] = [{"query": role, "tier": 1} ...]` assignment with the planner output. Preserve `workday_max_tier = 1` and `ats_max_tier = 1`. For direct ATS and Workday, use the planner output as local title filters after source enumeration rather than multiplying board fetches by every role variant.

- [x] **Step 3: Update target-search tests**

Assert that exact roles remain first and tier 1, recall queries are present as tier 1 without source-only scoping, profile notes are still stripped, and direct ATS query handling uses the recall set as internal filters.

### Task 2: Add Recall-Safe Title Matching

**Files:**
- Modify: `workers/automation/src/jobhunter/discovery/title_filter.py`
- Modify: `workers/automation/src/jobhunter/discovery/jobspy.py`
- Test: `workers/automation/tests/test_title_filter.py`
- Test: `workers/automation/tests/test_discovery_limits.py`

- [x] **Step 1: Preserve strict matching for exact queries**

Keep `title_matches_query(title, query)` behavior unchanged by default so exact target roles keep their current precision.

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

Update the target-search sections to state that profile roles generate exact queries plus same-tier recall queries, JobSpy uses them as broad-board retrieval probes, direct ATS/Workday use them as internal title filters after source enumeration, and scoring determines relevance after discovery.

### Task 4: Prevent Existing Jobs From Consuming Bounded Discovery

**Files:**
- Modify: `workers/automation/src/jobhunter/discovery/jobspy.py`
- Test: `workers/automation/tests/test_discovery_limits.py`

- [x] **Step 1: Count only new jobs against JobSpy's bounded crawl limit**

Update `_full_crawl()` and `store_jobspy_results()` so existing rediscoveries do not reduce the remaining new-job limit. Keep using the configured fetch size per query so an existing first result does not hide later new candidates in the same query response.

- [x] **Step 2: Add regression coverage**

Add tests proving an existing exact-query hit does not prevent a later recall query from running, and an existing row inside one JobSpy result set does not consume the one-new-job storage limit.

- [x] **Step 2: Verify targeted Python behavior**

Run `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_target_search_preferences.py workers/automation/tests/test_title_filter.py workers/automation/tests/test_discovery_limits.py`.

- [x] **Step 3: Verify formatting and branch diff**

Run `git diff --check` before committing.
