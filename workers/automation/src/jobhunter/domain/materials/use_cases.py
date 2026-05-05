"""Materials Generation use cases — application-layer orchestration.

See ddd-target.md §3.5 (use cases own transaction boundaries) and §4.5.

Three use cases live here:

  ``TailorResumeUseCase``        — given a profile snapshot + job dict,
                                    builds the prompt, calls the LLM,
                                    validates, judges, persists a new
                                    or updated MaterialsSet, and publishes
                                    ``ResumeApproved`` / ``ResumeFailed``.
  ``GenerateCoverLetterUseCase`` — given an approved MaterialsSet's
                                    tailored resume text + a job dict,
                                    generates the cover letter, validates,
                                    persists it onto the existing
                                    aggregate, and publishes
                                    ``CoverLetterGenerated``.
  ``RenderPdfUseCase``           — given a MaterialsSet with text
                                    artifacts, renders the appropriate
                                    PDFs via the ``PdfRendererPort``,
                                    appends them to the aggregate, and
                                    publishes ``PdfRendered``.

All three accept their dependencies as constructor arguments so tests
can swap fakes without monkey-patching.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jobhunter.domain.events import (
    CoverLetterGeneratedPayload,
    PdfRenderedPayload,
    ResumeApprovedPayload,
    ResumeFailedPayload,
    create_cover_letter_generated,
    create_pdf_rendered,
    create_resume_approved,
    create_resume_failed,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.aggregate import (
    MaterialsLifecycle,
    MaterialsSet,
    MaterialsSetFactory,
)
from jobhunter.domain.materials.entities import Artifact
from jobhunter.domain.materials.services import (
    BANNED_WORDS,
    ContentValidator,
    LLM_LEAK_PHRASES,
    ResumeAssembler,
    normalize_profile_list,
    sanitize_text,
)
from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.ports.llm import LlmMessage, LlmPort
from jobhunter.domain.ports.materials import MaterialsRepository, PdfRendererPort
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.resume_profile import (
    get_custom_tailoring_prompt,
    get_education_entries,
    get_experience_entries,
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
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_filename_prefix(job: dict) -> str:
    safe_title = re.sub(r"[^\w\s-]", "", job.get("title", ""))[:50].strip().replace(" ", "_")
    safe_site = re.sub(r"[^\w\s-]", "", job.get("site", ""))[:20].strip().replace(" ", "_")
    return f"{safe_site}_{safe_title}"


def _build_job_blob(job: dict) -> str:
    return (
        f"TITLE: {job.get('title', '')}\n"
        f"COMPANY: {job.get('site', '')}\n"
        f"LOCATION: {job.get('location') or 'N/A'}\n\n"
        f"DESCRIPTION:\n{(job.get('full_description') or '')[:6000]}"
    )


def _strip_preamble(text: str) -> str:
    """Remove LLM preamble before 'Dear Hiring Manager,' if present."""
    dear_idx = text.lower().find("dear")
    if dear_idx > 0:
        return text[dear_idx:]
    return text


def _extract_json(raw: str) -> dict:
    """Robustly extract JSON from LLM response (handles fences, preamble)."""
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    if "```" in raw:
        for part in raw.split("```")[1::2]:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            try:
                return json.loads(part)
            except json.JSONDecodeError:
                continue
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError("No valid JSON found in LLM response")


# ---------------------------------------------------------------------------
# Prompt builders (snapshot-driven)
# ---------------------------------------------------------------------------


def build_master_tailor_prompt(snapshot: ProfileSnapshot) -> str:
    """Build the master-resume tailoring prompt from the snapshot."""
    profile = snapshot.as_dict()
    require_resume_master(profile)
    resume = get_resume_master(profile)
    constraints = get_resume_constraints(profile)
    required_experience_ids = get_required_experience_entry_ids(profile)
    required_skill_ids = get_required_skill_category_ids(profile)
    all_experience_entries = get_experience_entries(profile)
    all_skill_categories = get_skill_categories(profile)
    experience_entries = [
        entry for entry in all_experience_entries
        if not required_experience_ids or entry.get("id") in required_experience_ids
    ] or all_experience_entries
    skill_categories = [
        category for category in all_skill_categories
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


def build_judge_prompt(snapshot: ProfileSnapshot) -> str:
    """Build the LLM judge prompt from the snapshot."""
    profile = snapshot.as_dict()
    boundary = profile.get("skills_boundary", {})
    resume_facts = profile.get("resume_facts", {})

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


def build_cover_letter_prompt(snapshot: ProfileSnapshot) -> str:
    """Build the cover-letter system prompt from the snapshot."""
    profile = snapshot.as_dict()
    personal = profile.get("personal", {})
    boundary = profile.get("skills_boundary", {})
    resume_facts = profile.get("resume_facts", {})

    sign_off_name = personal.get("preferred_name") or personal.get("full_name", "")

    all_skills: list[str] = []
    for items in boundary.values():
        all_skills.extend(normalize_profile_list(items))
    skills_str = ", ".join(all_skills) if all_skills else "the tools listed in the resume"

    real_metrics = normalize_profile_list(resume_facts.get("real_metrics", []))
    preserved_projects = normalize_profile_list(resume_facts.get("preserved_projects", []))

    projects_hint = ""
    if preserved_projects:
        projects_hint = f"\nKnown projects to reference: {', '.join(preserved_projects)}"
    metrics_hint = ""
    if real_metrics:
        metrics_hint = f"\nReal metrics to use: {', '.join(real_metrics)}"

    all_banned = ", ".join(f'"{w}"' for w in BANNED_WORDS)
    leak_banned = ", ".join(f'"{p}"' for p in LLM_LEAK_PHRASES)

    return f"""Write a cover letter for {sign_off_name}. The goal is to get an interview.

STRUCTURE: 3 short paragraphs. Under 250 words. Every sentence must earn its place.

PARAGRAPH 1 (2-3 sentences): Open with a specific thing YOU built that solves THEIR problem. Not "I'm excited about this role." Not "This role aligns with my experience." Start with the work.

PARAGRAPH 2 (3-4 sentences): Pick 2 achievements from the resume that are MOST relevant to THIS job. Use numbers. Frame as solving their problem, not listing your accomplishments.{projects_hint}{metrics_hint}

PARAGRAPH 3 (1-2 sentences): One specific thing about the company from the job description (a product, a technical challenge, a team structure). Then close. "Happy to walk through any of this in more detail." or "Let's discuss." Nothing else.

BANNED WORDS AND PHRASES (automated validator rejects ANY of these — do not use even once):
{all_banned}

ALSO BANNED (meta-commentary the validator catches):
{leak_banned}

BANNED PUNCTUATION: No em dashes (—) or en dashes (–). Use commas or periods.

VOICE:
- Write like a real engineer emailing someone they respect. Not formal, not casual. Just direct.
- NEVER narrate or explain what you're doing. BAD: "This demonstrates my commitment to X." GOOD: Just state the fact and move on.
- NEVER hedge. BAD: "might address some of your challenges." GOOD: "solves the same problem your team is facing."
- Every sentence should contain either a number, a tool name, or a specific outcome. If it doesn't, cut it.
- Read it out loud. If it sounds like a robot wrote it, rewrite it.

FABRICATION = INSTANT REJECTION:
The candidate's real tools are ONLY: {skills_str}.
Do NOT mention ANY tool not in this list. If the job asks for tools not listed, talk about the work you did, not the tools.

Sign off: just "{sign_off_name}"

Output ONLY the letter text. No subject lines. No "Here is the cover letter:" preamble. No notes after the sign-off.
Start DIRECTLY with "Dear Hiring Manager," and end with the name."""


# ---------------------------------------------------------------------------
# TailorResumeUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TailorOutcome:
    """Result of a single :meth:`TailorResumeUseCase.execute` call.

    ``status`` mirrors the legacy report.status vocabulary so callers
    that rely on it for telemetry don't need to be touched:

      * ``approved``                    — validator + judge passed.
      * ``approved_with_judge_warning`` — validator passed; judge failed
                                          on the last attempt.
      * ``failed_validation``           — validator never passed.
      * ``exhausted_retries``           — no parseable JSON in any attempt.
      * ``error``                       — unhandled exception during the
                                          run; ``error`` is populated.
    """

    materials: MaterialsSet | None
    status: str
    attempts: int
    text_path: str | None = None
    pdf_path: str | None = None
    report: dict = field(default_factory=dict)
    error: str = ""


class TailorResumeUseCase:
    """Tailor one job's resume — full LLM ⇒ validate ⇒ judge ⇒ persist flow.

    Owns the transaction boundary: the use case loads the previous
    aggregate (if any), constructs the next generation when re-tailoring,
    persists the result, and publishes ``ResumeApproved`` / ``ResumeFailed``.
    """

    def __init__(
        self,
        *,
        repository: MaterialsRepository,
        llm: LlmPort,
        validator: ContentValidator,
        assembler: ResumeAssembler,
        publisher: EventPublisher | None = None,
        max_retries: int = 3,
    ) -> None:
        self._repository = repository
        self._llm = llm
        self._validator = validator
        self._assembler = assembler
        self._publisher = publisher
        self._max_retries = max_retries

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def execute(
        self,
        *,
        job: dict,
        profile_snapshot: ProfileSnapshot,
        tailored_dir: Path,
        validation_mode: str = "normal",
        tenant_id: TenantId = LOCAL_TENANT,
        retailor: bool = False,
    ) -> TailorOutcome:
        job_id = JobId(str(job["url"]))
        previous = self._repository.load(tenant_id, job_id)

        # Decide which generation we're writing.
        if previous is None:
            materials = MaterialsSetFactory.initial(
                tenant_id=tenant_id,
                job_id=job_id,
                created_at=_utc_now(),
            )
            superseded = None
        elif retailor:
            superseded, materials = MaterialsSetFactory.next_generation(
                previous,
                created_at=_utc_now(),
            )
        else:
            # Re-saving the same generation (typical when a previous run
            # crashed mid-flight and left the aggregate in
            # ``resume_in_progress``).
            superseded = None
            materials = previous

        # Persist the superseded predecessor first so its artifacts carry
        # ``superseded_at`` and the queue selectors stop picking them.
        if superseded is not None:
            self._repository.save(superseded)

        report, parsed_payload, validation, verdict = self._run_attempts(
            job=job,
            profile_snapshot=profile_snapshot,
            validation_mode=validation_mode,
        )
        attempts = report["attempts"]

        if not parsed_payload:
            # Nothing to persist beyond the empty aggregate; surface the
            # failure to the caller and emit ``ResumeFailed`` so downstream
            # observers see the attempt counter advance.
            self._repository.save(materials)
            self._publish_failed(materials, validation_errors=("exhausted_retries",), attempt=attempts)
            return TailorOutcome(
                materials=materials,
                status="exhausted_retries",
                attempts=attempts,
                report=report,
                error="No parseable JSON in any attempt",
            )

        # Assemble the rendered resume text from the last successful payload.
        tailored_text = self._assembler.assemble_resume_text(parsed_payload, profile_snapshot)
        prefix = _safe_filename_prefix(job)
        tailored_dir.mkdir(parents=True, exist_ok=True)
        text_path = tailored_dir / f"{prefix}.txt"

        # Always write the raw text so callers can inspect it (mirrors
        # legacy behaviour that wrote even rejected attempts so the user
        # can compare).
        text_path.write_text(tailored_text, encoding="utf-8")

        try:
            size_bytes = text_path.stat().st_size
        except OSError:
            size_bytes = None

        artifact = Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(text_path),
            created_at=_utc_now(),
            render_format=RenderFormat.TEXT,
            size_bytes=size_bytes,
            metadata={
                "validation_mode": validation_mode,
                "attempts": attempts,
            },
        )
        materials = materials.with_resume_attempt(
            artifact,
            validation=validation,
            verdict=verdict,
            updated_at=_utc_now(),
        )
        self._repository.save(materials)

        status = self._derive_status(report, validation, verdict)
        if materials.is_resume_approved:
            self._publish_approved(materials)
        else:
            self._publish_failed(
                materials,
                validation_errors=tuple(validation.errors),
                attempt=attempts,
            )

        # Write a JOB.txt + REPORT.json next to the tailored resume so
        # the legacy file layout downstream consumers know stays intact.
        try:
            job_path = tailored_dir / f"{prefix}_JOB.txt"
            job_path.write_text(
                "\n".join(
                    [
                        f"Title: {job.get('title', '')}",
                        f"Company: {job.get('site', '')}",
                        f"Location: {job.get('location', 'N/A')}",
                        f"Score: {job.get('fit_score', 'N/A')}",
                        f"URL: {job.get('url', '')}",
                        "",
                        str(job.get("full_description", "")),
                    ]
                ),
                encoding="utf-8",
            )
            (tailored_dir / f"{prefix}_REPORT.json").write_text(
                json.dumps(report, indent=2, default=str),
                encoding="utf-8",
            )
        except OSError as exc:
            log.debug("Failed to write tailor side files for %s: %s", prefix, exc)

        return TailorOutcome(
            materials=materials,
            status=status,
            attempts=attempts,
            text_path=str(text_path),
            report=report,
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _run_attempts(
        self,
        *,
        job: dict,
        profile_snapshot: ProfileSnapshot,
        validation_mode: str,
    ) -> tuple[dict, dict | None, ValidationResult, JudgeVerdict | None]:
        """Run the LLM ⇒ validate ⇒ judge attempt loop.

        Returns the legacy-shaped ``report`` dict + the last successful
        payload (or ``None`` if every attempt failed to parse) + the last
        :class:`ValidationResult` and :class:`JudgeVerdict`.
        """
        tailor_prompt_base = build_master_tailor_prompt(profile_snapshot)
        report: dict = {
            "attempts": 0,
            "validator": None,
            "judge": None,
            "status": "pending",
            "validation_mode": validation_mode,
            "system_prompt": tailor_prompt_base,
            "job_text": _build_job_blob(job),
            "attempt_history": [],
        }
        avoid_notes: list[str] = []
        last_payload: dict | None = None
        last_validation: ValidationResult = ValidationResult.failure(("no attempt yet",))
        last_verdict: JudgeVerdict | None = None

        for attempt in range(self._max_retries + 1):
            report["attempts"] = attempt + 1

            prompt = tailor_prompt_base
            if avoid_notes:
                prompt += "\n\n## AVOID THESE ISSUES (from previous attempt):\n" + "\n".join(
                    f"- {n}" for n in avoid_notes[-5:]
                )
            attempt_record: dict[str, Any] = {
                "attempt": attempt + 1,
                "avoid_notes": list(avoid_notes[-5:]),
                "system_prompt": prompt,
            }

            messages = [
                LlmMessage(role="system", content=prompt),
                LlmMessage(
                    role="user",
                    content=(
                        "ORIGINAL RESUME:\n"
                        + (profile_snapshot.as_dict().get("resume", {}).get("executive_profile", {}).get("baseline_text", "") or "")
                        + "\n\n---\n\nTARGET JOB:\n"
                        + report["job_text"]
                        + "\n\nReturn the JSON:"
                    ),
                ),
            ]
            raw = self._llm.chat(messages, max_tokens=150000, temperature=0.4)
            attempt_record["raw_response"] = raw

            try:
                payload = _extract_json(raw)
            except ValueError:
                attempt_record["parse_error"] = "Output was not valid JSON. Return ONLY a JSON object, nothing else."
                attempt_record["status"] = "parse_error"
                report["attempt_history"].append(attempt_record)
                avoid_notes.append("Output was not valid JSON. Return ONLY a JSON object, nothing else.")
                continue
            attempt_record["parsed_json"] = payload

            validation = self._validator.validate_json_fields(
                payload, profile_snapshot, mode=validation_mode
            )
            report["validator"] = validation.to_dict()
            attempt_record["validator"] = validation.to_dict()
            last_validation = validation
            last_payload = payload

            if not validation.passed:
                avoid_notes.extend(validation.errors)
                attempt_record["status"] = "failed_validation"
                if attempt < self._max_retries:
                    report["attempt_history"].append(attempt_record)
                    continue
                report["status"] = "failed_validation"
                report["attempt_history"].append(attempt_record)
                return report, last_payload, last_validation, last_verdict

            if validation_mode == "lenient":
                last_verdict = JudgeVerdict.passed(score=1.0, notes="judge skipped (lenient)")
                report["judge"] = {"verdict": "SKIPPED", "passed": True, "issues": "none"}
                report["status"] = "approved"
                attempt_record["judge"] = report["judge"]
                attempt_record["status"] = "approved"
                report["attempt_history"].append(attempt_record)
                return report, last_payload, last_validation, last_verdict

            tailored_text = self._assembler.assemble_resume_text(payload, profile_snapshot)
            verdict = self._judge_resume(
                profile_snapshot=profile_snapshot,
                tailored_text=tailored_text,
                job_title=job.get("title", ""),
            )
            last_verdict = verdict
            report["judge"] = {
                "passed": verdict.approved,
                "verdict": "PASS" if verdict.approved else "FAIL",
                "issues": verdict.notes or "none",
                "score": verdict.score,
            }
            attempt_record["judge"] = report["judge"]

            if not verdict.approved:
                avoid_notes.append(f"Judge rejected: {verdict.notes}")
                attempt_record["status"] = "judge_rejected"
                if attempt < self._max_retries:
                    report["attempt_history"].append(attempt_record)
                    continue
                report["status"] = "approved_with_judge_warning"
                report["attempt_history"].append(attempt_record)
                return report, last_payload, last_validation, last_verdict

            report["status"] = "approved"
            attempt_record["status"] = "approved"
            report["attempt_history"].append(attempt_record)
            return report, last_payload, last_validation, last_verdict

        report["status"] = "exhausted_retries"
        return report, last_payload, last_validation, last_verdict

    def _judge_resume(
        self,
        *,
        profile_snapshot: ProfileSnapshot,
        tailored_text: str,
        job_title: str,
    ) -> JudgeVerdict:
        judge_prompt = build_judge_prompt(profile_snapshot)
        messages = [
            LlmMessage(role="system", content=judge_prompt),
            LlmMessage(
                role="user",
                content=(
                    f"JOB TITLE: {job_title}\n\n"
                    f"TAILORED RESUME:\n{tailored_text}\n\n"
                    "Judge this tailored resume:"
                ),
            ),
        ]
        try:
            response = self._llm.chat(messages, max_tokens=150000, temperature=0.1)
        except Exception as exc:  # noqa: BLE001
            log.error("Judge LLM error: %s", exc)
            return JudgeVerdict.failed(notes=f"judge error: {exc}")

        passed = "VERDICT: PASS" in response.upper()
        issues = "none"
        if "ISSUES:" in response.upper():
            issues_idx = response.upper().index("ISSUES:")
            issues = response[issues_idx + 7:].strip()
        return JudgeVerdict(approved=passed, score=1.0 if passed else 0.0, notes=issues)

    def _derive_status(
        self,
        report: dict,
        validation: ValidationResult,
        verdict: JudgeVerdict | None,
    ) -> str:
        status = report.get("status", "pending")
        if status in {"approved", "approved_with_judge_warning"}:
            return status
        if validation.passed:
            if verdict is not None and not verdict.approved:
                return "approved_with_judge_warning"
            return "approved"
        return status

    def _publish_approved(self, materials: MaterialsSet) -> None:
        if self._publisher is None or materials.tailored_resume is None:
            return
        try:
            event = create_resume_approved(
                materials.tenant_id,
                ResumeApprovedPayload(
                    job_id=str(materials.job_id),
                    artifact_id=materials.tailored_resume.artifact_id,
                    generation=materials.generation,
                    approved_at=materials.updated_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish ResumeApproved for %s", materials.job_id)

    def _publish_failed(
        self,
        materials: MaterialsSet,
        *,
        validation_errors: tuple[str, ...],
        attempt: int,
    ) -> None:
        if self._publisher is None:
            return
        try:
            event = create_resume_failed(
                materials.tenant_id,
                ResumeFailedPayload(
                    job_id=str(materials.job_id),
                    validation_errors=tuple(validation_errors),
                    attempt_number=attempt,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish ResumeFailed for %s", materials.job_id)


# ---------------------------------------------------------------------------
# GenerateCoverLetterUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CoverLetterOutcome:
    materials: MaterialsSet | None
    status: str
    text_path: str | None = None
    pdf_path: str | None = None
    error: str = ""


class GenerateCoverLetterUseCase:
    """Generate a cover letter for an approved resume's MaterialsSet.

    Loads the latest aggregate, requires the tailored resume to be
    approved (per §4.5), generates the cover letter (with retries),
    validates it, and persists the result back through the repository.
    """

    def __init__(
        self,
        *,
        repository: MaterialsRepository,
        llm: LlmPort,
        validator: ContentValidator,
        publisher: EventPublisher | None = None,
        max_retries: int = 3,
    ) -> None:
        self._repository = repository
        self._llm = llm
        self._validator = validator
        self._publisher = publisher
        self._max_retries = max_retries

    def execute(
        self,
        *,
        job: dict,
        profile_snapshot: ProfileSnapshot,
        cover_letter_dir: Path,
        validation_mode: str = "normal",
        tenant_id: TenantId = LOCAL_TENANT,
    ) -> CoverLetterOutcome:
        job_id = JobId(str(job["url"]))
        materials = self._repository.load(tenant_id, job_id)
        if materials is None:
            return CoverLetterOutcome(
                materials=None,
                status="error",
                error="No MaterialsSet exists for this job — tailor first",
            )
        if not materials.is_resume_approved:
            return CoverLetterOutcome(
                materials=materials,
                status="error",
                error="Cover letter requires an approved tailored resume",
            )

        # Read the resume text (the cover-letter prompt benefits from
        # seeing the tailored content). The §4.5 invariant guarantees
        # ``tailored_resume`` is not None at this point.
        assert materials.tailored_resume is not None
        resume_path = Path(materials.tailored_resume.path)
        if not resume_path.exists():
            return CoverLetterOutcome(
                materials=materials,
                status="error",
                error=f"Tailored resume missing on disk: {resume_path}",
            )
        try:
            resume_text = resume_path.read_text(encoding="utf-8")
        except OSError as exc:
            return CoverLetterOutcome(
                materials=materials,
                status="error",
                error=f"Could not read tailored resume {resume_path}: {exc}",
            )

        letter, validation = self._run_attempts(
            job=job,
            resume_text=resume_text,
            profile_snapshot=profile_snapshot,
            validation_mode=validation_mode,
        )

        prefix = _safe_filename_prefix(job)
        cover_letter_dir.mkdir(parents=True, exist_ok=True)
        cl_path = cover_letter_dir / f"{prefix}_CL.txt"
        cl_path.write_text(letter, encoding="utf-8")

        try:
            size_bytes = cl_path.stat().st_size
        except OSError:
            size_bytes = None

        artifact = Artifact.create(
            type=ArtifactType.COVER_LETTER,
            path=str(cl_path),
            created_at=_utc_now(),
            render_format=RenderFormat.TEXT,
            size_bytes=size_bytes,
            metadata={
                "validation_mode": validation_mode,
                "passed": validation.passed,
            },
        )
        materials = materials.with_cover_letter(
            artifact, validation=validation, updated_at=_utc_now()
        )
        self._repository.save(materials)

        if validation.passed:
            self._publish_generated(materials)
            return CoverLetterOutcome(
                materials=materials, status="ok", text_path=str(cl_path)
            )
        return CoverLetterOutcome(
            materials=materials,
            status="failed_validation",
            text_path=str(cl_path),
            error="; ".join(validation.errors),
        )

    def _run_attempts(
        self,
        *,
        job: dict,
        resume_text: str,
        profile_snapshot: ProfileSnapshot,
        validation_mode: str,
    ) -> tuple[str, ValidationResult]:
        cl_prompt_base = build_cover_letter_prompt(profile_snapshot)
        avoid_notes: list[str] = []
        letter = ""
        last_validation: ValidationResult = ValidationResult.failure(("no attempt yet",))
        for attempt in range(self._max_retries + 1):
            prompt = cl_prompt_base
            if avoid_notes:
                prompt += "\n\n## AVOID THESE ISSUES:\n" + "\n".join(
                    f"- {n}" for n in avoid_notes[-5:]
                )
            messages = [
                LlmMessage(role="system", content=prompt),
                LlmMessage(
                    role="user",
                    content=(
                        f"RESUME:\n{resume_text}\n\n---\n\n"
                        f"TARGET JOB:\n{_build_job_blob(job)}\n\n"
                        "Write the cover letter:"
                    ),
                ),
            ]
            raw = self._llm.chat(messages, max_tokens=1024, temperature=0.7)
            letter = sanitize_text(raw)
            letter = _strip_preamble(letter)

            validation = self._validator.validate_cover_letter(letter, mode=validation_mode)
            last_validation = validation
            if validation.passed:
                return letter, validation
            avoid_notes.extend(validation.errors)
            log.debug(
                "Cover letter attempt %d/%d failed: %s",
                attempt + 1, self._max_retries + 1, validation.errors,
            )

        return letter, last_validation

    def _publish_generated(self, materials: MaterialsSet) -> None:
        if self._publisher is None or materials.cover_letter is None:
            return
        try:
            event = create_cover_letter_generated(
                materials.tenant_id,
                CoverLetterGeneratedPayload(
                    job_id=str(materials.job_id),
                    artifact_id=materials.cover_letter.artifact_id,
                    generated_at=materials.updated_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception(
                "Failed to publish CoverLetterGenerated for %s", materials.job_id
            )


# ---------------------------------------------------------------------------
# RenderPdfUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RenderPdfOutcome:
    materials: MaterialsSet | None
    rendered: tuple[ArtifactType, ...]
    status: str
    error: str = ""


class RenderPdfUseCase:
    """Render the missing PDF artifacts for a MaterialsSet.

    Two PDFs are eligible:

      * resume PDF — rendered from the tailored payload via
        :class:`LatexPdfAdapter` when the tailored resume is approved.
      * cover-letter PDF — rendered from the cover-letter text via
        :class:`PlaywrightHtmlPdfAdapter` when the cover letter is
        approved.

    The use case skips any PDF that is already present, so re-runs are
    safe (each pass adds the missing PDFs without re-rendering).
    """

    def __init__(
        self,
        *,
        repository: MaterialsRepository,
        resume_renderer: PdfRendererPort,
        cover_letter_renderer: PdfRendererPort,
        publisher: EventPublisher | None = None,
    ) -> None:
        self._repository = repository
        self._resume_renderer = resume_renderer
        self._cover_letter_renderer = cover_letter_renderer
        self._publisher = publisher

    def execute(
        self,
        *,
        job_id: JobId,
        tailored_payload: dict | None = None,
        profile_dict: dict | None = None,
        tenant_id: TenantId = LOCAL_TENANT,
    ) -> RenderPdfOutcome:
        materials = self._repository.load(tenant_id, job_id)
        if materials is None:
            return RenderPdfOutcome(
                materials=None,
                rendered=(),
                status="error",
                error=f"No MaterialsSet for {job_id}",
            )

        rendered: list[ArtifactType] = []
        # Render resume PDF if missing and we have a payload to compile.
        if (
            materials.tailored_resume is not None
            and materials.tailored_resume.status is ArtifactStatus.APPROVED
            and (
                materials.resume_pdf is None
                or materials.resume_pdf.status is not ArtifactStatus.APPROVED
            )
            and tailored_payload is not None
            and profile_dict is not None
        ):
            text_path = Path(materials.tailored_resume.path)
            pdf_path = text_path.with_suffix(".pdf")
            try:
                pdf_artifact = self._resume_renderer.render_resume_to_pdf(
                    tailored_payload=tailored_payload,
                    profile_dict=profile_dict,
                    output_path=str(pdf_path),
                    created_at=_utc_now(),
                )
                materials = materials.with_resume_pdf(pdf_artifact, updated_at=_utc_now())
                rendered.append(ArtifactType.RESUME_PDF)
            except Exception as exc:  # noqa: BLE001
                log.error("Resume PDF render failed for %s: %s", job_id, exc)

        # Render cover-letter PDF if missing.
        if (
            materials.cover_letter is not None
            and materials.cover_letter.status is ArtifactStatus.APPROVED
            and (
                materials.cover_letter_pdf is None
                or materials.cover_letter_pdf.status is not ArtifactStatus.APPROVED
            )
        ):
            text_path = Path(materials.cover_letter.path)
            pdf_path = text_path.with_suffix(".pdf")
            try:
                cover_text = text_path.read_text(encoding="utf-8")
                pdf_artifact = self._cover_letter_renderer.render_cover_letter_to_pdf(
                    cover_letter_text=cover_text,
                    output_path=str(pdf_path),
                    created_at=_utc_now(),
                )
                materials = materials.with_cover_letter_pdf(pdf_artifact, updated_at=_utc_now())
                rendered.append(ArtifactType.COVER_LETTER_PDF)
            except Exception as exc:  # noqa: BLE001
                log.error("Cover letter PDF render failed for %s: %s", job_id, exc)

        if rendered:
            self._repository.save(materials)
            for artifact_type in rendered:
                self._publish_rendered(materials, artifact_type)
            return RenderPdfOutcome(
                materials=materials, rendered=tuple(rendered), status="ok"
            )

        return RenderPdfOutcome(
            materials=materials,
            rendered=(),
            status="noop",
        )

    def _publish_rendered(
        self, materials: MaterialsSet, artifact_type: ArtifactType
    ) -> None:
        if self._publisher is None:
            return
        artifact = materials.artifact_for(artifact_type)
        if artifact is None:
            return
        try:
            event = create_pdf_rendered(
                materials.tenant_id,
                PdfRenderedPayload(
                    job_id=str(materials.job_id),
                    artifact_type=artifact_type.value,
                    artifact_id=artifact.artifact_id,
                    rendered_at=artifact.created_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception(
                "Failed to publish PdfRendered for %s/%s", materials.job_id, artifact_type.value
            )


# ---------------------------------------------------------------------------
# Re-exports
# ---------------------------------------------------------------------------


__all__ = [
    "CoverLetterOutcome",
    "GenerateCoverLetterUseCase",
    "MaterialsLifecycle",
    "RenderPdfOutcome",
    "RenderPdfUseCase",
    "TailorOutcome",
    "TailorResumeUseCase",
    "build_cover_letter_prompt",
    "build_judge_prompt",
    "build_master_tailor_prompt",
]
