"""JobCtl first-time setup wizard.

Interactive flow that creates ~/.jobctl/ with:
  - resume.txt (and optionally resume.pdf)
  - candidate profile in jobctl.db
  - discovery settings in jobctl.db
  - .env (LLM provider config)
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt

from jobctl.config import (
    APP_DIR,
    DB_PATH,
    ENV_PATH,
    RESUME_PATH,
    RESUME_PDF_PATH,
    ensure_dirs,
)
from jobctl.database import init_db
from jobctl.domain.profile.aggregate import Profile
from jobctl.domain.tenant import LOCAL_TENANT
from jobctl.infrastructure.profile import get_profile_repository
from jobctl.llm import DEFAULT_GEMINI_MODEL

console = Console()


# ---------------------------------------------------------------------------
# Resume
# ---------------------------------------------------------------------------

def _setup_resume() -> None:
    """Prompt for resume file and copy into APP_DIR."""
    console.print(Panel("[bold]Step 1: Resume[/bold]\nPoint to your master resume file (.txt or .pdf)."))

    while True:
        path_str = Prompt.ask("Resume file path")
        src = Path(path_str.strip().strip('"').strip("'")).expanduser().resolve()

        if not src.exists():
            console.print(f"[red]File not found:[/red] {src}")
            continue

        suffix = src.suffix.lower()
        if suffix not in (".txt", ".pdf"):
            console.print("[red]Unsupported format.[/red] Provide a .txt or .pdf file.")
            continue

        if suffix == ".txt":
            shutil.copy2(src, RESUME_PATH)
            console.print(f"[green]Copied to {RESUME_PATH}[/green]")
        elif suffix == ".pdf":
            shutil.copy2(src, RESUME_PDF_PATH)
            console.print(f"[green]Copied to {RESUME_PDF_PATH}[/green]")

            # Also ask for a plain-text version for LLM consumption
            txt_path_str = Prompt.ask(
                "Plain-text version of your resume (.txt)",
                default="",
            )
            if txt_path_str.strip():
                txt_src = Path(txt_path_str.strip().strip('"').strip("'")).expanduser().resolve()
                if txt_src.exists():
                    shutil.copy2(txt_src, RESUME_PATH)
                    console.print(f"[green]Copied to {RESUME_PATH}[/green]")
                else:
                    console.print("[yellow]File not found, skipping plain-text copy.[/yellow]")
        break


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------

def _split_csv(value: str) -> list[str]:
    """Split comma-separated prompt input into clean values."""
    return [item.strip() for item in value.split(",") if item.strip()]


def _slugify_id(prefix: str, text: str, index: int) -> str:
    """Create a stable profile entry id from user-provided text."""
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return f"{prefix}_{slug or index}"


def _prompt_required(label: str, *, default: str | None = None) -> str:
    """Prompt until the user enters a non-empty value."""
    while True:
        value = Prompt.ask(label, default=default or "").strip()
        if value:
            return value
        console.print("[red]This field is required.[/red]")


def _prompt_bullets(label: str) -> list[str]:
    """Prompt for semicolon-separated resume bullets."""
    while True:
        raw = Prompt.ask(label)
        bullets = [item.strip() for item in raw.split(";") if item.strip()]
        if bullets:
            return bullets
        console.print("[red]Provide at least one bullet.[/red]")


def _setup_structured_resume(profile: dict) -> None:
    """Collect the mandatory structured resume block used for tailoring."""
    console.print("\n[bold cyan]Structured Resume Template[/bold cyan]")
    console.print(
        "[dim]This is the canonical resume JobCtl tailors and renders to PDF. "
        "You can edit the profile later in the local UI.[/dim]"
    )

    baseline = _prompt_required(
        "Baseline executive profile / summary",
        default="Software engineer with experience building reliable production systems.",
    )

    experience_entries: list[dict] = []
    while True:
        idx = len(experience_entries) + 1
        console.print(f"\n[bold]Experience entry {idx}[/bold]")
        title = _prompt_required("Title")
        company = _prompt_required("Company")
        default_id = _slugify_id("experience", f"{company}_{title}", idx)
        entry_id = _prompt_required("Entry id", default=default_id)
        experience_entries.append({
            "id": entry_id,
            "date_range": _prompt_required("Date range", default="Jan 2022 -- Present"),
            "title": title,
            "company": company,
            "location": Prompt.ask("Location", default="Remote"),
            "bullets": _prompt_bullets("Bullets (separate with semicolons)"),
        })
        if not Confirm.ask("Add another experience entry?", default=False):
            break

    education_entries: list[dict] = []
    if Confirm.ask("Add an education entry?", default=True):
        while True:
            idx = len(education_entries) + 1
            console.print(f"\n[bold]Education entry {idx}[/bold]")
            degree = _prompt_required("Degree or credential")
            institution = _prompt_required("Institution")
            default_id = _slugify_id("education", f"{institution}_{degree}", idx)
            education_entries.append({
                "id": _prompt_required("Entry id", default=default_id),
                "date": Prompt.ask("Date", default=""),
                "degree": degree,
                "institution": institution,
                "location": Prompt.ask("Location", default=""),
            })
            if not Confirm.ask("Add another education entry?", default=False):
                break

    skill_categories: list[dict] = []
    while True:
        idx = len(skill_categories) + 1
        console.print(f"\n[bold]Skill category {idx}[/bold]")
        label = _prompt_required("Category label", default="Languages" if idx == 1 else "Tools")
        items = _split_csv(_prompt_required("Items (comma-separated)"))
        if not items:
            console.print("[red]Provide at least one skill.[/red]")
            continue
        default_id = _slugify_id("skills", label, idx)
        skill_categories.append({
            "id": _prompt_required("Category id", default=default_id),
            "label": label,
            "items": items,
        })
        if not Confirm.ask("Add another skill category?", default=idx == 1):
            break

    profile["resume"] = {
        "executive_profile": {"baseline_text": baseline},
        "experience_entries": experience_entries,
        "education_entries": education_entries,
        "skill_categories": skill_categories,
        "tailoring_rules": {
            "required_experience_entry_ids": [entry["id"] for entry in experience_entries],
            "required_education_entry_ids": [entry["id"] for entry in education_entries],
            "required_skill_category_ids": [category["id"] for category in skill_categories],
            "required_bullets_by_experience_id": {},
            "required_skills_by_category_id": {},
            "max_experience_bullets": 4,
            "tailoring_policy": {
                "mode": "balanced",
                "allow_title_reframing": False,
                "allow_achievement_rewriting": True,
                "allow_skill_reordering": True,
                "allow_summary_rewrite": True,
                "allow_minor_inference": False,
                "claim_mode": "evidence_reframing",
                "auto_approvable_claim_modes": ["verified_only", "evidence_reframing"],
                "allow_adjacent_achievement_drafts": False,
            },
            "writing_style": {
                "tone": "direct",
                "bullet_style": "balanced",
                "verbosity": "balanced",
                "keyword_density": "natural",
                "avoid_first_person": True,
            },
            "revision_gates": {
                "min_fit_score": 8,
                "must_have_coverage": 0.85,
                "max_revision_attempts": 1,
            },
            "custom_tailoring_prompt": "",
        },
    }
    profile["resume_constraints"] = {
        "real_metrics": profile.get("resume_facts", {}).get("real_metrics", []),
    }


def _setup_profile() -> dict:
    """Walk through profile questions and return a nested profile dict."""
    console.print(Panel("[bold]Step 2: Profile[/bold]\nTell JobCtl about yourself. This powers scoring, tailoring, and auto-fill."))

    profile: dict = {}

    # -- Personal --
    console.print("\n[bold cyan]Personal Information[/bold cyan]")
    full_name = Prompt.ask("Full name")
    profile["personal"] = {
        "full_name": full_name,
        "preferred_name": Prompt.ask("Preferred/nickname (leave blank to use first name)", default=""),
        "email": Prompt.ask("Email address"),
        "phone": Prompt.ask("Phone number", default=""),
        "city": Prompt.ask("City"),
        "province_state": Prompt.ask("Province/State (e.g. Ontario, California)", default=""),
        "country": Prompt.ask("Country"),
        "postal_code": Prompt.ask("Postal/ZIP code", default=""),
        "address": Prompt.ask("Street address (optional, used for form auto-fill)", default=""),
        "linkedin_url": Prompt.ask("LinkedIn URL", default=""),
        "github_url": Prompt.ask("GitHub URL (optional)", default=""),
        "portfolio_url": Prompt.ask("Portfolio URL (optional)", default=""),
        "website_url": Prompt.ask("Personal website URL (optional)", default=""),
        "password": Prompt.ask("Job site password (used for login walls during auto-apply)", password=True, default=""),
    }

    # -- Work Authorization --
    console.print("\n[bold cyan]Work Authorization[/bold cyan]")
    profile["work_authorization"] = {
        "legally_authorized_to_work": Confirm.ask("Are you legally authorized to work in your target country?"),
        "require_sponsorship": Confirm.ask("Will you now or in the future need sponsorship?"),
        "work_permit_type": Prompt.ask("Work permit type (e.g. Citizen, PR, Open Work Permit — leave blank if N/A)", default=""),
    }

    # -- Compensation --
    console.print("\n[bold cyan]Compensation[/bold cyan]")
    salary = Prompt.ask("Expected annual salary (number)", default="")
    salary_currency = Prompt.ask("Currency", default="USD")
    salary_range = Prompt.ask("Acceptable range (e.g. 80000-120000)", default="")
    range_parts = salary_range.split("-") if "-" in salary_range else [salary, salary]
    profile["compensation"] = {
        "salary_expectation": salary,
        "salary_currency": salary_currency,
        "salary_range_min": range_parts[0].strip(),
        "salary_range_max": range_parts[1].strip() if len(range_parts) > 1 else range_parts[0].strip(),
    }

    # -- Experience --
    console.print("\n[bold cyan]Experience[/bold cyan]")
    current_title = Prompt.ask("Current/most recent job title", default="")
    target_role = Prompt.ask("Target role (what you're applying for, e.g. 'Senior Backend Engineer')", default=current_title)
    profile["experience"] = {
        "years_of_experience_total": Prompt.ask("Years of professional experience", default=""),
        "education_level": Prompt.ask("Highest education (e.g. Bachelor's, Master's, PhD, Self-taught)", default=""),
        "current_title": current_title,
        "current_job_title": current_title,
        "current_company": Prompt.ask("Current/most recent company", default=""),
        "target_role": target_role,
    }

    # -- Skills Boundary --
    console.print("\n[bold cyan]Skills[/bold cyan] (comma-separated)")
    langs = Prompt.ask("Programming languages", default="")
    frameworks = Prompt.ask("Frameworks & libraries", default="")
    tools = Prompt.ask("Tools & platforms (e.g. Docker, AWS, Git)", default="")
    profile["skills_boundary"] = {
        "programming_languages": _split_csv(langs),
        "frameworks": _split_csv(frameworks),
        "tools": _split_csv(tools),
    }

    # -- Resume Facts (preserved truths for tailoring) --
    console.print("\n[bold cyan]Resume Facts[/bold cyan]")
    console.print("[dim]These are preserved exactly during resume tailoring — the AI will never change them.[/dim]")
    companies = Prompt.ask("Companies to always keep (comma-separated)", default="")
    projects = Prompt.ask("Projects to always keep (comma-separated)", default="")
    school = Prompt.ask("School name(s) to preserve", default="")
    metrics = Prompt.ask("Real metrics to preserve (e.g. '99.9% uptime, 50k users')", default="")
    profile["resume_facts"] = {
        "preserved_companies": _split_csv(companies),
        "preserved_projects": _split_csv(projects),
        "preserved_school": school.strip(),
        "real_metrics": _split_csv(metrics),
    }

    _setup_structured_resume(profile)

    # -- EEO Voluntary (defaults) --
    profile["eeo_voluntary"] = {
        "gender": "Decline to self-identify",
        "race_ethnicity": "Decline to self-identify",
        "veteran_status": "Decline to self-identify",
        "disability_status": "Decline to self-identify",
    }

    # -- Availability --
    profile["availability"] = {
        "earliest_start_date": Prompt.ask("Earliest start date", default="Immediately"),
    }

    # Save through the typed repository so invariants are enforced and
    # ProfileUpdated is published exactly once.
    repository = get_profile_repository()
    aggregate = Profile.from_dict(LOCAL_TENANT, profile)
    repository.save(LOCAL_TENANT, aggregate)
    console.print(f"\n[green]Profile saved to SQLite at {DB_PATH}[/green]")
    return profile


# ---------------------------------------------------------------------------
# Search config
# ---------------------------------------------------------------------------

def _setup_searches() -> None:
    """Save discovery search settings from user input."""
    console.print(Panel("[bold]Step 3: Job Search Config[/bold]\nDefine what you're looking for."))

    location = Prompt.ask("Target location (e.g. 'Remote', 'Canada', 'New York, NY')", default="Remote")
    distance_str = Prompt.ask("Search radius in miles (0 for remote-only)", default="0")
    try:
        distance = int(distance_str)
    except ValueError:
        distance = 0

    roles_raw = Prompt.ask(
        "Target job titles (comma-separated, e.g. 'Backend Engineer, Full Stack Developer')"
    )
    roles = [r.strip() for r in roles_raw.split(",") if r.strip()]

    if not roles:
        console.print("[yellow]No roles provided. Using a default set.[/yellow]")
        roles = ["Software Engineer"]

    search_cfg = {
        "boards": ["indeed", "linkedin", "zip_recruiter"],
        "defaults": {
            "location": location,
            "distance": distance,
            "hours_old": 72,
            "results_per_site": 50,
        },
        "locations": [
            {
                "location": location,
                "remote": distance == 0,
            }
        ],
        "queries": [{"query": role, "tier": min(index + 1, 3)} for index, role in enumerate(roles)],
    }
    conn = init_db(DB_PATH)
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT INTO discovery_settings (
            tenant_id, search_config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
            search_config_json = excluded.search_config_json,
            updated_at = excluded.updated_at
        """,
        (str(LOCAL_TENANT), json.dumps(search_cfg, sort_keys=True), now, now),
    )
    conn.commit()
    console.print(f"[green]Discovery settings saved to SQLite at {DB_PATH}[/green]")


# ---------------------------------------------------------------------------
# AI Features
# ---------------------------------------------------------------------------

def _setup_ai_features() -> None:
    """Ask about AI scoring/tailoring — optional LLM configuration."""
    console.print(Panel(
        "[bold]Step 4: AI Features (optional)[/bold]\n"
        "An LLM powers job scoring, resume tailoring, and cover letters.\n"
        "Without this, you can still discover and enrich jobs."
    ))

    if not Confirm.ask("Enable AI scoring and resume tailoring?", default=True):
        console.print("[dim]Discovery-only mode. You can configure AI later with [bold]jobctl init[/bold].[/dim]")
        return

    console.print("Supported providers: [bold]Gemini[/bold] (recommended, free tier), OpenAI, local (Ollama/llama.cpp)")
    provider = Prompt.ask(
        "Provider",
        choices=["gemini", "openai", "local"],
        default="gemini",
    )

    env_lines = ["# JobCtl configuration", ""]

    if provider == "gemini":
        api_key = Prompt.ask("Gemini API key (from aistudio.google.com)")
        model = Prompt.ask("Model", default=DEFAULT_GEMINI_MODEL)
        env_lines.append(f"GEMINI_API_KEY={api_key}")
        env_lines.append(f"LLM_MODEL={model}")
    elif provider == "openai":
        api_key = Prompt.ask("OpenAI API key")
        model = Prompt.ask("Model", default="gpt-4o-mini")
        env_lines.append(f"OPENAI_API_KEY={api_key}")
        env_lines.append(f"LLM_MODEL={model}")
    elif provider == "local":
        url = Prompt.ask("Local LLM endpoint URL", default="http://localhost:8080/v1")
        model = Prompt.ask("Model name", default="local-model")
        env_lines.append(f"LLM_URL={url}")
        env_lines.append(f"LLM_MODEL={model}")

    env_lines.append("")
    ENV_PATH.write_text("\n".join(env_lines), encoding="utf-8")
    console.print(f"[green]AI configuration saved to {ENV_PATH}[/green]")


# ---------------------------------------------------------------------------
# Auto-Apply
# ---------------------------------------------------------------------------

def _setup_auto_apply() -> None:
    """Configure autonomous job application (requires a Claude apply runtime)."""
    console.print(Panel(
        "[bold]Step 5: Apply automation (optional)[/bold]\n"
        "By default, JobCtl does not start a standing apply loop and live "
        "submissions require Apply Review approval. You can opt into a worker-"
        "maintained loop for eligible prepared jobs."
    ))

    if not Confirm.ask("Enable the standing auto-apply loop?", default=False):
        _update_dashboard_settings(auto_apply=False, apply_approval_required=True)
        console.print("[dim]Auto apply is off. You can start apply runs manually after reviewing materials.[/dim]")
        return

    approval_required = Confirm.ask(
        "Require Apply Review approval before live submit?",
        default=True,
    )
    _update_dashboard_settings(
        auto_apply=True,
        apply_approval_required=approval_required,
    )
    if approval_required:
        console.print(
            "[dim]Auto apply will poll eligible jobs, but live submissions park "
            "until Apply Review approves them.[/dim]"
        )
    else:
        console.print(
            "[yellow]Autonomous submit mode enabled: eligible live applications "
            "may be submitted without human review. Min score, spend budget, "
            "at-most-once, dry-run, and CAPTCHA fail-closed safeguards still apply.[/yellow]"
        )

    # Check for the apply runtime. A system Claude CLI is accepted, but setup
    # can also use the pinned Claude Agent SDK bundled binary.
    from jobctl.infrastructure.setup_probes import resolve_claude_apply_binary

    claude_runtime = resolve_claude_apply_binary()
    if shutil.which(claude_runtime) or Path(claude_runtime).expanduser().exists():
        console.print(f"[green]Claude apply runtime detected:[/green] {claude_runtime}")
    else:
        console.print(
            "[yellow]Claude apply runtime was not found.[/yellow]\n"
            "Run [bold]jobctl setup[/bold] after dependency sync or set [bold]JOBCTL_CLAUDE_BIN[/bold]."
        )

    # Optional: retain a CapSolver key for future owned CAPTCHA tooling.
    console.print(
        "\n[dim]CAPTCHA challenges currently fail closed during apply runs. "
        "You may still store a CapSolver key for future owned CAPTCHA tooling.[/dim]"
    )
    if Confirm.ask("Configure CapSolver API key? (optional)", default=False):
        capsolver_key = Prompt.ask("CapSolver API key")
        # Append to existing .env or create
        if ENV_PATH.exists():
            existing = ENV_PATH.read_text(encoding="utf-8")
            if "CAPSOLVER_API_KEY" not in existing:
                ENV_PATH.write_text(
                    existing.rstrip() + f"\nCAPSOLVER_API_KEY={capsolver_key}\n",
                    encoding="utf-8",
                )
        else:
            ENV_PATH.write_text(f"# JobCtl configuration\nCAPSOLVER_API_KEY={capsolver_key}\n", encoding="utf-8")
        console.print("[green]CapSolver key saved.[/green]")
    else:
        console.print("[dim]Skipped. CAPTCHA challenges will fail closed.[/dim]")


def _update_dashboard_settings(**patch: object) -> None:
    path = APP_DIR / "dashboard.json"
    if path.exists():
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            current = {}
        if not isinstance(current, dict):
            current = {}
    else:
        current = {}
    current.update(patch)
    path.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

def run_wizard() -> None:
    """Run the full interactive setup wizard."""
    console.print()
    console.print(
        Panel.fit(
            "[bold green]JobCtl Setup Wizard[/bold green]\n\n"
            "This will create your configuration at:\n"
            f"  [cyan]{APP_DIR}[/cyan]\n\n"
            "You can re-run this anytime with [bold]jobctl init[/bold].",
            border_style="green",
        )
    )

    ensure_dirs()
    console.print(f"[dim]Created {APP_DIR}[/dim]\n")

    # Step 1: Resume
    _setup_resume()
    console.print()

    # Step 2: Profile
    _setup_profile()
    console.print()

    # Step 3: Search config
    _setup_searches()
    console.print()

    # Step 4: AI features (optional LLM)
    _setup_ai_features()
    console.print()

    # Step 5: Auto-apply (Claude runtime detection)
    _setup_auto_apply()
    console.print()

    # Done — show tier status
    from jobctl.config import get_tier, TIER_LABELS, TIER_COMMANDS

    tier = get_tier()

    tier_lines: list[str] = []
    for t in range(1, 4):
        label = TIER_LABELS[t]
        cmds = ", ".join(f"[bold]{c}[/bold]" for c in TIER_COMMANDS[t])
        if t <= tier:
            tier_lines.append(f"  [green]✓ Tier {t} — {label}[/green]  ({cmds})")
        elif t == tier + 1:
            tier_lines.append(f"  [yellow]→ Tier {t} — {label}[/yellow]  ({cmds})")
        else:
            tier_lines.append(f"  [dim]✗ Tier {t} — {label}  ({cmds})[/dim]")

    unlock_hint = ""
    if tier == 1:
        unlock_hint = "\n[dim]To unlock Tier 2: configure an LLM provider (re-run [bold]jobctl init[/bold]).[/dim]"
    elif tier == 2:
        unlock_hint = "\n[dim]To unlock Tier 3: configure a Claude apply runtime + Chrome.[/dim]"

    console.print(
        Panel.fit(
            "[bold green]Setup complete![/bold green]\n\n"
            f"[bold]Your tier: Tier {tier} — {TIER_LABELS[tier]}[/bold]\n\n"
            + "\n".join(tier_lines)
            + unlock_hint,
            border_style="green",
        )
    )
