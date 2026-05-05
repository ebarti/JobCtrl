"""Resume tailoring: LLM-powered ATS-optimized resume generation per job.

THIS IS THE HEAVIEST REFACTOR. Every piece of personal data -- name, email, phone,
skills, companies, projects, school -- is loaded at runtime from the user's profile.
Zero hardcoded personal information.

The LLM returns structured JSON, code assembles the final text. Header (name, contact)
is always code-injected, never LLM-generated. Each retry starts a fresh conversation
to avoid apologetic spirals.
"""

import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from jobhunter import config
from jobhunter.config import RESUME_PATH, TAILORED_DIR
from jobhunter.database import get_connection, get_jobs_by_stage
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.llm import get_client
from jobhunter.state import ensure_job_stage_rows, record_job_artifact, record_job_event, set_stage_state, utc_now
from jobhunter.resume_profile import (
    get_education_entries,
    get_experience_entries,
    get_custom_tailoring_prompt,
    get_max_experience_bullets,
    get_required_bullets_by_experience_id,
    get_required_experience_entry_ids,
    get_required_skill_category_ids,
    get_resume_constraints,
    get_resume_master,
    get_skill_categories,
    get_tailoring_policy,
    get_writing_style,
    require_resume_master,
    tailored_experience_bullets,
    tailored_experience_title,
)
from jobhunter.scoring.validator import (
    BANNED_WORDS,
    normalize_profile_list,
    sanitize_text,
    validate_json_fields,
)

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 5  # max cross-run retries before giving up


# ── Prompt Builders (snapshot-driven) ─────────────────────────────────────

def _build_master_tailor_prompt(snapshot: ProfileSnapshot) -> str:
    """Build a tailoring prompt anchored to the canonical LaTeX resume schema."""
    profile = snapshot.as_dict()
    require_resume_master(profile)
    resume = get_resume_master(profile)
    constraints = get_resume_constraints(profile)
    required_experience_ids = get_required_experience_entry_ids(profile)
    required_skill_ids = get_required_skill_category_ids(profile)
    all_experience_entries = get_experience_entries(profile)
    all_skill_categories = get_skill_categories(profile)
    experience_entries = [
        entry for entry in get_experience_entries(profile)
        if not required_experience_ids or entry.get("id") in required_experience_ids
    ] or all_experience_entries
    skill_categories = [
        category for category in get_skill_categories(profile)
        if not required_skill_ids or category.get("id") in required_skill_ids
    ] or all_skill_categories
    education_entries = get_education_entries(profile)

    experience_payload = [
        {
            "id": entry.get("id"),
            "date_range": entry.get("date_range"),
            "title": entry.get("title"),
            "company": entry.get("company"),
            "location": entry.get("location"),
            "bullets": entry.get("bullets", []),
        }
        for entry in experience_entries
    ]
    skills_payload = [
        {
            "id": category.get("id"),
            "label": category.get("label"),
            "items": category.get("items", []),
        }
        for category in skill_categories
    ]
    education_payload = [
        {
            "id": entry.get("id"),
            "date": entry.get("date"),
            "degree": entry.get("degree"),
            "institution": entry.get("institution"),
            "location": entry.get("location"),
        }
        for entry in education_entries
    ]

    required_bullets = get_required_bullets_by_experience_id(profile)
    tailoring_policy = get_tailoring_policy(profile)
    writing_style = get_writing_style(profile)
    custom_tailoring_prompt = get_custom_tailoring_prompt(profile)
    max_bullets = get_max_experience_bullets(profile)
    real_metrics = normalize_profile_list(constraints.get("real_metrics", []))
    metrics_str = ", ".join(real_metrics) if real_metrics else "N/A"
    banned_str = ", ".join(BANNED_WORDS)
    policy_lines = [
        f"- Tailoring mode: {tailoring_policy['mode']}",
        f"- Rewrite executive profile: {'yes' if tailoring_policy['allow_summary_rewrite'] else 'no, preserve the baseline summary'}",
        f"- Reframe experience titles: {'yes' if tailoring_policy['allow_title_reframing'] else 'no, titles are fixed by the master resume'}",
        f"- Rewrite achievement bullets: {'yes' if tailoring_policy['allow_achievement_rewriting'] else 'no, preserve the original bullets'}",
        f"- Reorder or trim skills: {'yes' if tailoring_policy['allow_skill_reordering'] else 'no, preserve original skill order and wording'}",
        f"- Minor inferred phrasing: {'allowed' if tailoring_policy['allow_minor_inference'] else 'not allowed'}",
    ]
    style_lines = [
        f"- Tone: {writing_style['tone']}",
        f"- Bullet style: {writing_style['bullet_style']}",
        f"- Verbosity: {writing_style['verbosity']}",
        f"- Keyword density: {writing_style['keyword_density']}",
        f"- Avoid first person: {'yes' if writing_style['avoid_first_person'] else 'no'}",
    ]
    custom_prompt_block = (
        f"\nUSER ADDITIONAL TAILORING PROMPT:\n{custom_tailoring_prompt}\n"
        if custom_tailoring_prompt
        else ""
    )

    return f"""You are tailoring a resume that is backed by a canonical LaTeX master file.

You are ONLY allowed to rewrite the mutable content:
- the executive profile, if policy allows it
- the bullets for each existing experience entry, if policy allows it
- the title field for each existing experience entry, only if policy allows it
- the ordering/content of items inside each existing skill category, if policy allows it

The code will inject all fixed structure from the master resume:
- experience metadata (date_range, title, company, location)
- all education entries
- section order

HARD RULES:
- Return EVERY required experience entry id exactly once
- Return EVERY required skill category id exactly once
- Preserve every required bullet listed below in the matching experience entry
- Do NOT add or remove experience entries
- Do NOT add or remove education entries
- Do NOT add or remove skill categories
- Do NOT change real numbers ({metrics_str})
- Do NOT invent companies, roles, degrees, or certifications
- Max {max_bullets} bullets per experience entry
- No em dashes
- BANNED WORDS: {banned_str}

MASTER EXECUTIVE PROFILE:
{resume.get("executive_profile", {}).get("baseline_text", "")}

MASTER EXPERIENCE ENTRIES:
{json.dumps(experience_payload, indent=2, ensure_ascii=False)}

MASTER EDUCATION ENTRIES (fixed, injected by code):
{json.dumps(education_payload, indent=2, ensure_ascii=False)}

MASTER SKILL CATEGORIES:
{json.dumps(skills_payload, indent=2, ensure_ascii=False)}

TAILORING POLICY:
{chr(10).join(policy_lines)}

WRITING STYLE:
{chr(10).join(style_lines)}
{custom_prompt_block}
REQUIRED EXPERIENCE IDS:
{json.dumps(required_experience_ids, ensure_ascii=False)}

REQUIRED SKILL CATEGORY IDS:
{json.dumps(required_skill_ids, ensure_ascii=False)}

REQUIRED BULLETS BY EXPERIENCE ID:
{json.dumps(required_bullets, indent=2, ensure_ascii=False)}

OUTPUT ONLY VALID JSON:
{{
  "executive_profile": "2-4 sentences tailored to the target role.",
  "experience_updates": [
    {{"id": "{required_experience_ids[0] if required_experience_ids else 'experience_entry_id'}", "title": "optional rewritten title only when policy allows", "bullets": ["bullet 1", "bullet 2"]}}
  ],
  "skill_category_updates": [
    {{"id": "{required_skill_ids[0] if required_skill_ids else 'skill_category_id'}", "items": ["item 1", "item 2"]}}
  ]
}}"""


def _build_tailor_prompt(snapshot: ProfileSnapshot) -> str:
    """Build the resume tailoring system prompt from the snapshot."""
    return _build_master_tailor_prompt(snapshot)


def _build_judge_prompt(snapshot: ProfileSnapshot) -> str:
    """Build the LLM judge prompt from the snapshot."""
    profile = snapshot.as_dict()
    boundary = profile.get("skills_boundary", {})
    resume_facts = profile.get("resume_facts", {})

    # Flatten allowed skills for the judge
    all_skills: list[str] = []
    for items in boundary.values():
        all_skills.extend(normalize_profile_list(items))
    skills_str = ", ".join(all_skills) if all_skills else "N/A"

    real_metrics = normalize_profile_list(resume_facts.get("real_metrics", []))
    metrics_str = ", ".join(real_metrics) if real_metrics else "N/A"

    return f"""You are a resume quality judge. A tailoring engine rewrote a resume to target a specific job. Your job is to catch LIES, not style changes.

You must answer with EXACTLY this format:
VERDICT: PASS or FAIL
ISSUES: (list any problems, or "none")

## CONTEXT -- what the tailoring engine was instructed to do (all of this is ALLOWED):
- Change the title to match the target role
- Rewrite the summary from scratch for the target job
- Reorder bullets and projects to put the most relevant first
- Reframe bullets to use the job's language
- Drop low-relevance bullets and replace with more relevant ones from other sections
- Reorder the skills section to put job-relevant skills first
- Change tone and wording extensively

## WHAT IS FABRICATION (FAIL for these):
1. Adding tools, languages, or frameworks to TECHNICAL SKILLS that aren't in the original. The allowed skills are ONLY: {skills_str}
2. Inventing NEW metrics or numbers not in the original. The real metrics are: {metrics_str}
3. Inventing work that has no basis in any original bullet (completely new achievements).
4. Adding companies, roles, or degrees that don't exist.
5. Changing real numbers (inflating 80% to 95%, 500 nodes to 1000 nodes).

## WHAT IS NOT FABRICATION (do NOT fail for these):
- Rewording any bullet, even heavily, as long as the underlying work is real
- Combining two original bullets into one
- Splitting one original bullet into two
- Describing the same work with different emphasis
- Dropping bullets entirely
- Reordering anything
- Changing the title or summary completely

## TOLERANCE RULE:
The goal is to get interviews, not to be a perfect fact-checker. Allow up to 3 minor stretches per resume:
- Adding a closely related tool the candidate could realistically know is a MINOR STRETCH, not fabrication.
- Reframing a metric with slightly different wording is a MINOR STRETCH.
- Adding any LEARNABLE skill given their existing stack is a MINOR STRETCH.
- Only FAIL if there are MAJOR lies: completely invented projects, fake companies, fake degrees, wildly inflated numbers, or skills from a completely different domain.

Be strict about major lies. Be lenient about minor stretches and learnable skills. Do not fail for style, tone, or restructuring."""


# ── JSON Extraction ───────────────────────────────────────────────────────

def extract_json(raw: str) -> dict:
    """Robustly extract JSON from LLM response (handles fences, preamble).

    Args:
        raw: Raw LLM response text.

    Returns:
        Parsed JSON dict.

    Raises:
        ValueError: If no valid JSON found.
    """
    raw = raw.strip()

    # Direct parse
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # Markdown fences
    if "```" in raw:
        for part in raw.split("```")[1::2]:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            try:
                return json.loads(part)
            except json.JSONDecodeError:
                continue

    # Find outermost { ... }
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            pass

    raise ValueError("No valid JSON found in LLM response")


# ── Resume Assembly (profile-driven header) ──────────────────────────────

def assemble_resume_text(data: dict, snapshot: ProfileSnapshot) -> str:
    """Assemble plain-text resume output from the canonical resume master."""
    profile = snapshot.as_dict()
    require_resume_master(profile)
    personal = profile.get("personal", {})
    tailoring_policy = get_tailoring_policy(profile)
    resume = get_resume_master(profile)
    required_experience_ids = get_required_experience_entry_ids(profile)
    required_skill_ids = get_required_skill_category_ids(profile)
    required_education_ids = set(get_resume_master(profile).get("tailoring_rules", {}).get("required_education_entry_ids", []))
    all_experience_entries = get_experience_entries(profile)
    all_education_entries = get_education_entries(profile)
    all_skill_categories = get_skill_categories(profile)
    experience_entries = [
        entry for entry in all_experience_entries
        if not required_experience_ids or entry.get("id") in required_experience_ids
    ] or all_experience_entries
    education_entries = [
        entry for entry in all_education_entries
        if not required_education_ids or entry.get("id") in required_education_ids
    ] or all_education_entries
    skill_categories = [
        category for category in all_skill_categories
        if not required_skill_ids or category.get("id") in required_skill_ids
    ] or all_skill_categories

    experience_updates = {
        entry.get("id"): entry
        for entry in data.get("experience_updates", [])
        if isinstance(entry, dict) and entry.get("id")
    }
    skill_updates = {
        entry.get("id"): entry
        for entry in data.get("skill_category_updates", [])
        if isinstance(entry, dict) and entry.get("id")
    }

    lines: list[str] = []
    lines.append(personal.get("full_name", ""))

    contact_parts: list[str] = []
    if personal.get("email"):
        contact_parts.append(personal["email"])
    if personal.get("phone"):
        contact_parts.append(personal["phone"])
    if personal.get("website_url"):
        contact_parts.append(personal["website_url"])
    if personal.get("linkedin_url"):
        contact_parts.append(personal["linkedin_url"])
    if contact_parts:
        lines.append(" | ".join(contact_parts))
    lines.append("")

    lines.append("EXECUTIVE PROFILE")
    if tailoring_policy["allow_summary_rewrite"]:
        executive_profile = data.get("executive_profile", "")
    else:
        executive_profile = resume.get("executive_profile", {}).get("baseline_text", "")
    lines.append(sanitize_text(executive_profile))
    lines.append("")

    lines.append("EXPERIENCE")
    for entry in experience_entries:
        update = experience_updates.get(entry.get("id"), {})
        title = tailored_experience_title(entry, update, profile)
        lines.append(sanitize_text(f"{title} | {entry.get('company', '')}"))
        subtitle_parts = [entry.get("location", ""), entry.get("date_range", "")]
        subtitle = " | ".join(part for part in subtitle_parts if part)
        if subtitle:
            lines.append(sanitize_text(subtitle))

        bullets = tailored_experience_bullets(entry, update, profile)
        for bullet in bullets:
            lines.append(f"- {sanitize_text(str(bullet))}")
        lines.append("")

    lines.append("EDUCATION")
    for entry in education_entries:
        lines.append(sanitize_text(str(entry.get("degree", ""))))
        subtitle_parts = [entry.get("institution", ""), entry.get("location", ""), entry.get("date", "")]
        subtitle = " | ".join(part for part in subtitle_parts if part)
        if subtitle:
            lines.append(sanitize_text(subtitle))
        if entry.get("details"):
            lines.append(sanitize_text(str(entry["details"])))
        lines.append("")

    lines.append("SKILLS")
    for category in skill_categories:
        update = skill_updates.get(category.get("id"), {})
        items = update.get("items", category.get("items", [])) if tailoring_policy["allow_skill_reordering"] else category.get("items", [])
        sanitized_items = [sanitize_text(str(item)) for item in items if str(item).strip()]
        lines.append(f"{category.get('label', 'Skills')}: {', '.join(sanitized_items)}")

    return "\n".join(lines)


# ── LLM Judge ────────────────────────────────────────────────────────────

def judge_tailored_resume(
    original_text: str, tailored_text: str, job_title: str, snapshot: ProfileSnapshot
) -> dict:
    """LLM judge layer: catches subtle fabrication that programmatic checks miss.

    Args:
        original_text: Base resume text.
        tailored_text: Tailored resume text.
        job_title: Target job title.
        snapshot: ProfileSnapshot used to build the judge prompt.

    Returns:
        {"passed": bool, "verdict": str, "issues": str, "raw": str}
    """
    judge_prompt = _build_judge_prompt(snapshot)

    messages = [
        {"role": "system", "content": judge_prompt},
        {"role": "user", "content": (
            f"JOB TITLE: {job_title}\n\n"
            f"ORIGINAL RESUME:\n{original_text}\n\n---\n\n"
            f"TAILORED RESUME:\n{tailored_text}\n\n"
            "Judge this tailored resume:"
        )},
    ]

    client = get_client()
    response = client.chat(messages, max_tokens=150000, temperature=0.1)

    passed = "VERDICT: PASS" in response.upper()
    issues = "none"
    if "ISSUES:" in response.upper():
        issues_idx = response.upper().index("ISSUES:")
        issues = response[issues_idx + 7:].strip()

    return {
        "passed": passed,
        "verdict": "PASS" if passed else "FAIL",
        "issues": issues,
        "raw": response,
    }


# ── Core Tailoring ───────────────────────────────────────────────────────

def tailor_resume(
    resume_text: str, job: dict, snapshot: ProfileSnapshot,
    max_retries: int = 3, validation_mode: str = "normal",
) -> tuple[str, dict]:
    """Generate a tailored resume via JSON output + fresh context on each retry.

    Key design choices:
    - LLM returns structured JSON, code assembles the text (no header leaks)
    - Each retry starts a FRESH conversation (no apologetic spiral)
    - Issues from previous attempts are noted in the system prompt
    - Em dashes and smart quotes are auto-fixed, not rejected

    Args:
        resume_text:      Base resume text.
        job:              Job dict with title, site, location, full_description.
        snapshot:         Immutable ProfileSnapshot for prompts/validation.
        max_retries:      Maximum retry attempts.
        validation_mode:  "strict", "normal", or "lenient".
                          strict  -- banned words trigger retries; judge must pass
                          normal  -- banned words = warnings only; judge can fail on last retry
                          lenient -- banned words ignored; LLM judge skipped

    Returns:
        (tailored_text, report) where report contains validation details.
    """
    profile = snapshot.as_dict()
    job_text = (
        f"TITLE: {job['title']}\n"
        f"COMPANY: {job['site']}\n"
        f"LOCATION: {job.get('location', 'N/A')}\n\n"
        f"DESCRIPTION:\n{(job.get('full_description') or '')[:6000]}"
    )

    tailor_prompt_base = _build_tailor_prompt(snapshot)
    report: dict = {
        "attempts": 0,
        "validator": None,
        "judge": None,
        "status": "pending",
        "validation_mode": validation_mode,
        "system_prompt": tailor_prompt_base,
        "job_text": job_text,
        "attempt_history": [],
    }
    avoid_notes: list[str] = []
    tailored = ""
    client = get_client()

    for attempt in range(max_retries + 1):
        report["attempts"] = attempt + 1

        # Fresh conversation every attempt
        prompt = tailor_prompt_base
        if avoid_notes:
            prompt += "\n\n## AVOID THESE ISSUES (from previous attempt):\n" + "\n".join(
                f"- {n}" for n in avoid_notes[-5:]
            )
        attempt_record: dict = {
            "attempt": attempt + 1,
            "avoid_notes": list(avoid_notes[-5:]),
            "system_prompt": prompt,
        }

        messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": f"ORIGINAL RESUME:\n{resume_text}\n\n---\n\nTARGET JOB:\n{job_text}\n\nReturn the JSON:"},
        ]

        raw = client.chat(messages, max_tokens=150000, temperature=0.4)
        attempt_record["raw_response"] = raw

        # Parse JSON from response
        try:
            data = extract_json(raw)
        except ValueError:
            attempt_record["parse_error"] = "Output was not valid JSON. Return ONLY a JSON object, nothing else."
            attempt_record["status"] = "parse_error"
            report["attempt_history"].append(attempt_record)
            avoid_notes.append("Output was not valid JSON. Return ONLY a JSON object, nothing else.")
            continue
        attempt_record["parsed_json"] = data

        # Layer 1: Validate JSON fields
        validation = validate_json_fields(data, profile, mode=validation_mode)
        report["validator"] = validation
        attempt_record["validator"] = validation

        if not validation["passed"]:
            # Only retry if there are hard errors (warnings never block)
            avoid_notes.extend(validation["errors"])
            attempt_record["status"] = "failed_validation"
            if attempt < max_retries:
                report["attempt_history"].append(attempt_record)
                continue
            # Last attempt — assemble whatever we got
            tailored = assemble_resume_text(data, snapshot)
            report["status"] = "failed_validation"
            attempt_record["tailored_text"] = tailored
            report["attempt_history"].append(attempt_record)
            return tailored, report

        # Assemble text (header injected by code, em dashes auto-fixed)
        tailored = assemble_resume_text(data, snapshot)
        attempt_record["tailored_text"] = tailored

        # Layer 2: LLM judge (catches subtle fabrication) — skipped in lenient mode
        if validation_mode == "lenient":
            report["judge"] = {"verdict": "SKIPPED", "passed": True, "issues": "none"}
            report["status"] = "approved"
            attempt_record["judge"] = report["judge"]
            attempt_record["status"] = "approved"
            report["attempt_history"].append(attempt_record)
            return tailored, report

        judge = judge_tailored_resume(resume_text, tailored, job.get("title", ""), snapshot)
        report["judge"] = judge
        attempt_record["judge"] = judge
        log.info("Judge result: %s", judge)

        if not judge["passed"]:
            avoid_notes.append(f"Judge rejected: {judge['issues']}")
            attempt_record["status"] = "judge_rejected"
            if attempt < max_retries:
                # In normal mode, only retry on judge failure if there are retries left
                if validation_mode != "lenient":
                    report["attempt_history"].append(attempt_record)
                    continue
            # Accept best attempt on last retry (all modes) or if lenient
            report["status"] = "approved_with_judge_warning"
            report["attempt_history"].append(attempt_record)
            return tailored, report

        # Both passed
        report["status"] = "approved"
        attempt_record["status"] = "approved"
        report["attempt_history"].append(attempt_record)
        return tailored, report

    report["status"] = "exhausted_retries"
    return tailored, report


# ── Batch Entry Point ────────────────────────────────────────────────────

def _tailor_one_job(
    job: dict,
    resume_text: str,
    snapshot: ProfileSnapshot,
    validation_mode: str,
) -> dict:
    """Tailor one job and write its output artifacts."""
    tailored, report = tailor_resume(
        resume_text,
        job,
        snapshot,
        validation_mode=validation_mode,
    )

    safe_title = re.sub(r"[^\w\s-]", "", job["title"])[:50].strip().replace(" ", "_")
    safe_site = re.sub(r"[^\w\s-]", "", job["site"])[:20].strip().replace(" ", "_")
    prefix = f"{safe_site}_{safe_title}"

    job_path = TAILORED_DIR / f"{prefix}_JOB.txt"
    job_desc = (
        f"Title: {job['title']}\n"
        f"Company: {job['site']}\n"
        f"Location: {job.get('location', 'N/A')}\n"
        f"Score: {job.get('fit_score', 'N/A')}\n"
        f"URL: {job['url']}\n\n"
        f"{job.get('full_description', '')}"
    )
    job_path.write_text(job_desc, encoding="utf-8")

    report_path = TAILORED_DIR / f"{prefix}_REPORT.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    txt_path = None
    pdf_path = None
    if report["status"] in ("approved", "approved_with_judge_warning"):
        txt_path = TAILORED_DIR / f"{prefix}.txt"
        txt_path.write_text(tailored, encoding="utf-8")

        # Extract the parsed JSON from the last successful attempt
        last_attempt = report.get("attempt_history", [{}])[-1] if report.get("attempt_history") else {}
        parsed_json = last_attempt.get("parsed_json")
        if parsed_json:
            try:
                from jobhunter.scoring.pdf import convert_resume_to_pdf
                pdf_out = TAILORED_DIR / f"{prefix}.pdf"
                convert_resume_to_pdf(parsed_json, snapshot.as_dict(), pdf_out)
                pdf_path = str(pdf_out)
            except Exception:
                log.error("LaTeX PDF generation failed for %s", txt_path, exc_info=True)
        else:
            log.debug("No parsed JSON available for PDF generation: %s", txt_path)

    return {
        "url": job["url"],
        "path": str(txt_path) if txt_path else None,
        "pdf_path": pdf_path,
        "title": job["title"],
        "site": job["site"],
        "status": report["status"],
        "attempts": report["attempts"],
    }


def run_tailoring(min_score: int = 7, limit: int = 0,
                  validation_mode: str = "normal", workers: int = 1,
                  retailor: bool = False,
                  snapshot: ProfileSnapshot | None = None) -> dict:
    """Generate tailored resumes for high-scoring jobs.

    Args:
        min_score:       Minimum fit_score to tailor for.
        limit:           Maximum jobs to process. 0 means no limit.
        validation_mode: "strict", "normal", or "lenient".
        workers:         Number of parallel LLM workers.
        retailor:        If True, include jobs that already have a tailored resume.

    Returns:
        {"approved": int, "failed": int, "errors": int, "elapsed": float}
    """
    if snapshot is None:
        from jobhunter.infrastructure.profile import get_profile_repository
        from jobhunter.domain.tenant import LOCAL_TENANT
        snapshot = get_profile_repository().load_snapshot(LOCAL_TENANT)
    resume_text = RESUME_PATH.read_text(encoding="utf-8")
    conn = get_connection()

    jobs = get_jobs_by_stage(
        conn=conn,
        stage="pending_tailor",
        min_score=min_score,
        limit=limit,
        retailor=retailor,
    )

    if not jobs:
        if retailor:
            log.info("No jobs eligible for tailoring or re-tailoring with score >= %d.", min_score)
        else:
            log.info("No untailored jobs with score >= %d.", min_score)
        return {"approved": 0, "failed": 0, "errors": 0, "elapsed": 0.0}

    TAILORED_DIR.mkdir(parents=True, exist_ok=True)
    worker_count = max(1, workers)
    log.info(
        "Tailoring resumes for %d jobs (score >= %d) with %d worker(s)%s...",
        len(jobs),
        min_score,
        worker_count,
        " [re-tailor enabled]" if retailor else "",
    )
    t0 = time.time()
    results: list[dict] = []
    stats: dict[str, int] = {"approved": 0, "failed_validation": 0, "failed_judge": 0, "error": 0}
    future_to_job: dict = {}

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        for job in jobs:
            ensure_job_stage_rows(conn, job["url"], discovered_at=job.get("discovered_at"))
            started_at = utc_now()
            job["_tailor_started_at"] = started_at
            set_stage_state(conn, job["url"], "tailor", "running", started_at=started_at)
            record_job_event(conn, job["url"], "tailor", "StageStarted", message="Tailoring started")
            future = executor.submit(
                _tailor_one_job,
                job,
                resume_text,
                snapshot,
                validation_mode,
            )
            future_to_job[future] = job

        for completed, future in enumerate(as_completed(future_to_job), start=1):
            job = future_to_job[future]
            try:
                result = future.result()
            except Exception as e:
                result = {
                    "url": job["url"], "title": job["title"], "site": job["site"],
                    "status": "error", "attempts": 0, "path": None, "pdf_path": None,
                }
                log.error("%d/%d [ERROR] %s -- %s", completed, len(jobs), job["title"][:40], e)

            results.append(result)
            stats[result.get("status", "error")] = stats.get(result.get("status", "error"), 0) + 1

            elapsed = time.time() - t0
            rate = completed / elapsed if elapsed > 0 else 0
            log.info(
                "%d/%d [%s] attempts=%s | %.1f jobs/min | %s",
                completed, len(jobs),
                result["status"].upper(),
                result.get("attempts", "?"),
                rate * 60,
                result["title"][:40],
            )

    # Persist to DB: increment attempt counter for ALL, save path only for approved
    now = datetime.now(timezone.utc).isoformat()
    _success_statuses = {"approved", "approved_with_judge_warning"}
    for r in results:
        if r["status"] in _success_statuses:
            conn.execute(
                "UPDATE jobs SET tailored_resume_path=?, tailored_at=?, "
                "tailor_attempts=COALESCE(tailor_attempts,0)+1 WHERE url=?",
                (r["path"], now, r["url"]),
            )
            set_stage_state(
                conn,
                r["url"],
                "tailor",
                "succeeded",
                attempt_count=r.get("attempts") or 1,
                started_at=next((job.get("_tailor_started_at") for job in jobs if job["url"] == r["url"]), None),
                finished_at=now,
            )
            if r.get("path"):
                record_job_artifact(conn, r["url"], "tailor", "tailored_resume_txt", r["path"], status="active", created_at=now)
            if r.get("pdf_path"):
                record_job_artifact(conn, r["url"], "pdf", "tailored_resume_pdf", r["pdf_path"], status="active", created_at=now)
            record_job_event(
                conn,
                r["url"],
                "tailor",
                "StageCompleted",
                message=f"Tailoring {r['status']}",
                payload={"attempts": r.get("attempts")},
            )
        else:
            conn.execute(
                "UPDATE jobs SET tailor_attempts=COALESCE(tailor_attempts,0)+1 WHERE url=?",
                (r["url"],),
            )
            attempts = int(r.get("attempts") or 0) + 1
            exhausted = attempts >= config.DEFAULTS["max_tailor_attempts"] or r["status"] == "exhausted_retries"
            set_stage_state(
                conn,
                r["url"],
                "tailor",
                "exhausted" if exhausted else "failed",
                attempt_count=attempts,
                max_attempts=config.DEFAULTS["max_tailor_attempts"],
                started_at=next((job.get("_tailor_started_at") for job in jobs if job["url"] == r["url"]), None),
                finished_at=now,
                error_code=str(r["status"]).upper(),
                error_message=f"Tailoring ended with status {r['status']}",
                retryable=True,
                next_action=f"jobhunter retry tailor {r['url']} --reset-attempts" if exhausted else f"jobhunter retry tailor {r['url']}",
            )
            record_job_event(
                conn,
                r["url"],
                "tailor",
                "StageFailed",
                level="error",
                message=f"Tailoring ended with status {r['status']}",
            )
    conn.commit()

    elapsed = time.time() - t0
    log.info(
        "Tailoring done in %.1fs: %d approved, %d failed_validation, %d failed_judge, %d errors",
        elapsed,
        stats.get("approved", 0),
        stats.get("failed_validation", 0),
        stats.get("failed_judge", 0),
        stats.get("error", 0),
    )

    return {
        "approved": stats.get("approved", 0),
        "failed": stats.get("failed_validation", 0) + stats.get("failed_judge", 0),
        "errors": stats.get("error", 0),
        "elapsed": elapsed,
    }
