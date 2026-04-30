"""Job fit scoring: LLM-powered evaluation of candidate-job match quality.

Scores jobs on a 1-10 scale by comparing the user's resume against each
job description. All personal data is loaded at runtime from the user's
profile and resume file.
"""

import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from jobhunter.config import RESUME_PATH
from jobhunter.database import get_connection, get_jobs_by_stage
from jobhunter.llm import get_client
from jobhunter.state import ensure_job_stage_rows, record_job_event, set_stage_state, utc_now

log = logging.getLogger(__name__)


# ── Scoring Prompt ────────────────────────────────────────────────────────

SCORE_PROMPT = """You are a job fit evaluator. Given a candidate's resume and a job description, score how well the candidate fits the role.

SCORING CRITERIA:
- 9-10: Perfect match. Candidate has direct experience in nearly all required skills and qualifications.
- 7-8: Strong match. Candidate has most required skills, minor gaps easily bridged.
- 5-6: Moderate match. Candidate has some relevant skills but missing key requirements.
- 3-4: Weak match. Significant skill gaps, would need substantial ramp-up.
- 1-2: Poor match. Completely different field or experience level.

IMPORTANT FACTORS:
- Weight technical skills heavily (programming languages, frameworks, tools)
- Consider transferable experience (automation, scripting, API work)
- Factor in the candidate's project experience
- Be realistic about experience level vs. job requirements (years of experience, seniority)

RESPOND IN EXACTLY THIS FORMAT (no other text):
SCORE: [1-10]
KEYWORDS: [comma-separated ATS keywords from the job description that match or could match the candidate]
REASONING: [2-3 sentences explaining the score]"""


def _parse_score_response(response: str) -> dict:
    """Parse the LLM's score response into structured data.

    Args:
        response: Raw LLM response text.

    Returns:
        {"score": int, "keywords": str, "reasoning": str}
    """
    score = 0
    keywords = ""
    reasoning = response

    for line in response.split("\n"):
        line = line.strip()
        if line.startswith("SCORE:"):
            try:
                score = int(re.search(r"\d+", line).group())
                score = max(1, min(10, score))
            except (AttributeError, ValueError):
                score = 0
        elif line.startswith("KEYWORDS:"):
            keywords = line.replace("KEYWORDS:", "").strip()
        elif line.startswith("REASONING:"):
            reasoning = line.replace("REASONING:", "").strip()

    return {"score": score, "keywords": keywords, "reasoning": reasoning}


def score_job(resume_text: str, job: dict) -> dict:
    """Score a single job against the resume.

    Args:
        resume_text: The candidate's full resume text.
        job: Job dict with keys: title, site, location, full_description.

    Returns:
        {"score": int, "keywords": str, "reasoning": str}
    """
    job_text = (
        f"TITLE: {job['title']}\n"
        f"COMPANY: {job['site']}\n"
        f"LOCATION: {job.get('location', 'N/A')}\n\n"
        f"DESCRIPTION:\n{(job.get('full_description') or '')[:6000]}"
    )

    messages = [
        {"role": "system", "content": SCORE_PROMPT},
        {"role": "user", "content": f"RESUME:\n{resume_text}\n\n---\n\nJOB POSTING:\n{job_text}"},
    ]

    try:
        client = get_client()
        response = client.chat(messages, max_tokens=512, temperature=0.2)
        return _parse_score_response(response)
    except Exception as e:
        log.error("LLM error scoring job '%s': %s", job.get("title", "?"), e)
        return {"score": 0, "keywords": "", "reasoning": f"LLM error: {e}"}


def run_scoring(limit: int = 0, rescore: bool = False, workers: int = 1) -> dict:
    """Score unscored jobs that have full descriptions.

    Args:
        limit: Maximum number of jobs to score in this run.
        rescore: If True, re-score all jobs (not just unscored ones).
        workers: Number of parallel LLM workers.

    Returns:
        {"scored": int, "errors": int, "elapsed": float, "distribution": list}
    """
    resume_text = RESUME_PATH.read_text(encoding="utf-8")
    conn = get_connection()

    if rescore:
        query = "SELECT * FROM jobs WHERE full_description IS NOT NULL"
        if limit > 0:
            query += f" LIMIT {limit}"
        jobs = conn.execute(query).fetchall()
    else:
        jobs = get_jobs_by_stage(conn=conn, stage="pending_score", limit=limit)

    if not jobs:
        log.info("No unscored jobs with descriptions found.")
        return {"scored": 0, "errors": 0, "elapsed": 0.0, "distribution": []}

    # Convert sqlite3.Row to dicts if needed
    if jobs and not isinstance(jobs[0], dict):
        columns = jobs[0].keys()
        jobs = [dict(zip(columns, row)) for row in jobs]

    worker_count = max(1, workers)
    log.info("Scoring %d jobs with %d worker(s)...", len(jobs), worker_count)
    t0 = time.time()
    errors = 0
    results: list[dict] = []
    future_to_job: dict = {}

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        for job in jobs:
            ensure_job_stage_rows(conn, job["url"], discovered_at=job.get("discovered_at"))
            started_at = utc_now()
            job["_score_started_at"] = started_at
            set_stage_state(conn, job["url"], "score", "running", started_at=started_at)
            record_job_event(conn, job["url"], "score", "stage_started", message="Scoring started")
            future = executor.submit(score_job, resume_text, job)
            future_to_job[future] = job

        for completed, future in enumerate(as_completed(future_to_job), start=1):
            job = future_to_job[future]
            try:
                result = future.result()
            except Exception as e:
                log.error("Unhandled scoring error for '%s': %s", job.get("title", "?"), e)
                result = {"score": 0, "keywords": "", "reasoning": f"Unhandled error: {e}"}

            result["url"] = job["url"]
            if result["score"] == 0:
                errors += 1

            results.append(result)

            log.info(
                "[%d/%d] score=%d  %s",
                completed, len(jobs), result["score"], job.get("title", "?")[:60],
            )

    # Write scores to DB
    now = datetime.now(timezone.utc).isoformat()
    for r in results:
        conn.execute(
            "UPDATE jobs SET fit_score = ?, score_reasoning = ?, scored_at = ? WHERE url = ?",
            (r["score"], f"{r['keywords']}\n{r['reasoning']}", now, r["url"]),
        )
        job = next((item for item in jobs if item["url"] == r["url"]), {})
        if r["score"] == 0:
            set_stage_state(
                conn,
                r["url"],
                "score",
                "failed",
                attempt_count=1,
                started_at=job.get("_score_started_at"),
                finished_at=now,
                error_code="SCORE_FAILED",
                error_message=r["reasoning"] or "Scoring failed",
                retryable=True,
                next_action=f"jobhunter retry score {r['url']}",
            )
            record_job_event(
                conn,
                r["url"],
                "score",
                "stage_failed",
                level="error",
                message=r["reasoning"] or "Scoring failed",
            )
        else:
            set_stage_state(
                conn,
                r["url"],
                "score",
                "succeeded",
                attempt_count=1,
                started_at=job.get("_score_started_at"),
                finished_at=now,
            )
            record_job_event(
                conn,
                r["url"],
                "score",
                "stage_succeeded",
                message=f"Fit score {r['score']}/10",
                payload={"keywords": r["keywords"]},
            )
    conn.commit()

    elapsed = time.time() - t0
    log.info("Done: %d scored in %.1fs (%.1f jobs/sec)", len(results), elapsed, len(results) / elapsed if elapsed > 0 else 0)

    # Score distribution
    dist = conn.execute("""
        SELECT fit_score, COUNT(*) FROM jobs
        WHERE fit_score IS NOT NULL
        GROUP BY fit_score ORDER BY fit_score DESC
    """).fetchall()
    distribution = [(row[0], row[1]) for row in dist]

    return {
        "scored": len(results),
        "errors": errors,
        "elapsed": elapsed,
        "distribution": distribution,
    }
