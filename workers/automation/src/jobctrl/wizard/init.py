"""JobCtrl first-time setup wizard.

Interactive flow that creates ~/.jobctrl/ with:
  - resume.txt (and optionally resume.pdf)
  - candidate profile in jobctrl.db
  - discovery settings in jobctrl.db
  - .env (LLM provider config)
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import stat
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from rich.console import Console
from rich.markup import escape
from rich.panel import Panel
from rich.prompt import Confirm, Prompt

from jobctrl.config import (
    APP_DIR,
    DB_PATH,
    ENV_PATH,
    RESUME_PATH,
    RESUME_PDF_PATH,
    _apply_profile_target_search,
    _load_profile_target_search,
    _update_discovery_search_config,
    ConfigFileError,
    config_file_lock,
    ensure_dirs,
    load_discovery_control_settings,
    load_saved_search_settings,
    save_discovery_automation_settings,
)
from jobctrl.database import init_db
from jobctrl.domain.errors import ConfigurationError
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.profile import get_profile_repository

console = Console()


class WizardSearchFilterConflict(ConfigurationError):
    """A saved literal filter excludes every effective wizard search."""

    def __init__(self, key: str, saved_value: object, context_json: str) -> None:
        self.key = key
        self.saved_json = json.dumps(saved_value, ensure_ascii=False, sort_keys=True)
        self.context_json = context_json
        target = "titles" if key == "tiers" else "locations"
        super().__init__(
            f"The saved Discovery {key} filter excludes all selected {target}. "
            "Discovery settings are unchanged. Retry jobctrl init to review this filter."
        )


# ---------------------------------------------------------------------------
# Resume
# ---------------------------------------------------------------------------

def _file_revision(path: Path) -> tuple[int, ...] | None:
    """Capture a file's identity and version without reading its contents."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ConfigurationError(f"Cannot inspect {path.name}; retry setup after checking access.") from exc
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _check_file_revisions(revisions: dict[Path, tuple[int, ...] | None], *, resource: str) -> None:
    for path, revision in revisions.items():
        if _file_revision(path) != revision:
            raise ConfigurationError(f"{resource} changed during setup; it was not replaced. Retry jobctrl init.")
        if revision is not None and not stat.S_ISREG(revision[2]):
            raise ConfigurationError(f"{path.name} is not a regular file; update it manually.")


def _replace_wizard_files(
    updates: dict[Path, tuple[bytes, int]], revisions: dict[Path, tuple[int, ...] | None], *, resource: str,
) -> None:
    """Check for changes during prompts and serialize cooperating JobCtrl writers.

    External editors do not take this lock, so the check is not a filesystem
    compare-and-swap against an editor writing during the final replacement.
    """
    staged: dict[Path, Path] = {}
    saved: list[Path] = []
    try:
        # This lock also serializes concurrent wizard writers in this directory.
        with config_file_lock(path=APP_DIR / "config.json"):
            _check_file_revisions(revisions, resource=resource)
            for path, (contents, mode) in updates.items():
                descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
                staged[path] = Path(name)
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(contents)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(name, mode)
            _check_file_revisions(revisions, resource=resource)
            for path, temporary in staged.items():
                if revisions[path] is None:
                    # Creating a missing file must not replace a concurrent creation.
                    try:
                        os.link(temporary, path)
                    except FileExistsError:
                        raise ConfigurationError(
                            f"{resource} changed during setup; it was not replaced. Retry jobctrl init."
                        ) from None
                    saved.append(path)
                    temporary.unlink()
                else:
                    os.replace(temporary, path)
                    saved.append(path)
    except (OSError, ConfigFileError, ConfigurationError) as exc:
        detail = f" {', '.join(path.name for path in saved)} already saved." if saved else ""
        if isinstance(exc, ConfigurationError):
            raise ConfigurationError(f"{exc}{detail}") from exc
        raise ConfigurationError(f"Could not save {resource}; check file access and retry setup.{detail}") from exc
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)


@dataclass(frozen=True)
class PendingResume:
    check: Callable[[], None]
    save: Callable[[], None]


def _setup_resume() -> PendingResume | None:
    """Select resume files, but do not save them before Discovery is accepted."""
    console.print(Panel("[bold]Step 1: Resume[/bold]\nPoint to your master resume file (.txt or .pdf)."))
    revisions = {path: _file_revision(path) for path in (RESUME_PATH, RESUME_PDF_PATH)}
    existing = [path.name for path, revision in revisions.items() if revision is not None]
    if existing:
        console.print(f"[dim]Existing resume files: {', '.join(existing)}. Unselected files will be retained.[/dim]")
        if not Confirm.ask("Replace or add a resume file?", default=False):
            console.print("[dim]Existing resume files retained.[/dim]")
            return None

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

        sources = {RESUME_PATH if suffix == ".txt" else RESUME_PDF_PATH: src}
        if suffix == ".pdf":
            txt_path_str = Prompt.ask("Plain-text version of your resume (.txt)", default="")
            if txt_path_str.strip():
                txt_src = Path(txt_path_str.strip().strip('"').strip("'")).expanduser().resolve()
                if txt_src.exists():
                    sources[RESUME_PATH] = txt_src
                else:
                    console.print("[yellow]File not found, skipping plain-text copy.[/yellow]")
        try:
            updates = {path: (source.read_bytes(), stat.S_IMODE(source.stat().st_mode)) for path, source in sources.items()}
        except OSError:
            console.print("[red]Could not read the selected resume file.[/red] Choose a readable file.")
            continue
        selected_revisions = {path: revisions[path] for path in updates}

        def check_resume() -> None:
            _check_file_revisions(selected_revisions, resource="Resume")

        def save_resume() -> None:
            _replace_wizard_files(updates, selected_revisions, resource="Resume")
            for path in updates:
                console.print(f"[green]Copied to {path}[/green]")

        console.print("[dim]The selected resume will be saved after Discovery is accepted.[/dim]")
        return PendingResume(check=check_resume, save=save_resume)


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
        "[dim]This is the canonical resume JobCtrl tailors and renders to PDF. "
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
    # Compatibility section only. Metrics are derived from each achievement
    # bullet when the canonical Profile aggregate is constructed.
    profile["resume_constraints"] = {"real_metrics": []}


def _setup_profile() -> dict:
    """Walk through profile questions and return a nested profile dict."""
    console.print(Panel("[bold]Step 2: Profile[/bold]\nTell JobCtrl about yourself. This powers scoring, tailoring, and auto-fill."))

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
    console.print("[dim]These facts help preserve resume structure during tailoring.[/dim]")
    companies = Prompt.ask("Companies to always keep (comma-separated)", default="")
    projects = Prompt.ask("Projects to always keep (comma-separated)", default="")
    school = Prompt.ask("School name(s) to preserve", default="")
    profile["resume_facts"] = {
        "preserved_companies": _split_csv(companies),
        "preserved_projects": _split_csv(projects),
        "preserved_school": school.strip(),
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
    repository.create_if_absent(LOCAL_TENANT, aggregate)
    console.print(f"\n[green]Profile saved to SQLite at {DB_PATH}[/green]")
    return profile


# ---------------------------------------------------------------------------
# Search config
# ---------------------------------------------------------------------------

def _setup_searches(
    *, expected_profile_target: dict | None = None, check_pending_resume: Callable[[], None] | None = None,
) -> None:
    """Save discovery search settings from user input."""
    console.print(Panel(
        "[bold]Step 3: Job Search Config[/bold]\nDefine what you're looking for. "
        "This replaces saved Discovery location and title rows; other settings are retained."
    ))

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
    approved_filters: dict[str, str] = {}
    approved_context: str | None = None

    def verified_profile_target() -> dict:
        target = _load_profile_target_search()
        if expected_profile_target is not None and target != expected_profile_target:
            raise ConfigurationError(
                "Your Profile changed during setup. Discovery settings are unchanged; retry jobctrl init."
            )
        return target

    def update_existing(current: dict) -> dict:
        if check_pending_resume is not None:
            check_pending_resume()
        # The wizard asks for locations and titles, not board, lookback,
        # country, or other saved settings. Preserve those existing choices.
        defaults = dict(current.get("defaults") or {})
        defaults.update({"location": location, "distance": distance})
        updated = {**current, "defaults": defaults, "locations": search_cfg["locations"], "queries": search_cfg["queries"]}
        target = None
        context_json = ""
        if expected_profile_target is not None or current.get("tiers") or current.get("location_labels") or approved_filters:
            # This read happens under the same SQLite write lock as the
            # settings update, so profile changes cannot race the decision.
            target = verified_profile_target()
            context_json = json.dumps({"settings": current, "target": target}, ensure_ascii=False, sort_keys=True)
            if approved_context is not None and context_json != approved_context:
                raise ConfigurationError(
                    "Saved Discovery settings or Profile targets changed while awaiting confirmation. "
                    "Discovery settings are unchanged; retry jobctrl init."
                )
        for key, approved_json in approved_filters.items():
            current_json = json.dumps(current.get(key), ensure_ascii=False, sort_keys=True)
            if current_json != approved_json:
                raise ConfigurationError(
                    "Saved Discovery filters changed while awaiting confirmation. "
                    "Discovery settings are unchanged; retry jobctrl init."
                )
            updated[key] = []
        tiers = updated.get("tiers")
        labels = updated.get("location_labels")
        if tiers or labels:
            # The profile may override wizard rows. Evaluate the same literal
            # effective values as source planning while the writer lock is held.
            effective = _apply_profile_target_search(updated, target)
            if tiers and (
                not isinstance(tiers, list)
                or not any(query.get("tier") in tiers for query in effective.get("queries", []))
            ):
                raise WizardSearchFilterConflict("tiers", tiers, context_json)
            if labels and not any(place.get("label") in labels for place in effective.get("locations", [])):
                raise WizardSearchFilterConflict("location_labels", labels, context_json)
        return updated

    first_use_remote = False

    def update_first_use(_current: dict) -> dict:
        nonlocal first_use_remote
        if check_pending_resume is not None:
            check_pending_resume()
        if approved_filters:
            raise ConfigurationError(
                "Saved Discovery settings changed while awaiting confirmation. "
                "Discovery settings are unchanged; retry jobctrl init."
            )
        if expected_profile_target is not None:
            verified_profile_target()
        if distance == 0:
            first_use_remote = True
            return {**search_cfg, "boards": ["linkedin", "zip_recruiter"]}
        return search_cfg

    init_db(DB_PATH)
    while True:
        try:
            _update_discovery_search_config(update_existing, first_use_update=update_first_use)
            break
        except WizardSearchFilterConflict as exc:
            console.print(f"[yellow]{escape(str(exc))}[/yellow]")
            console.print(f"Saved {exc.key} filter: {escape(exc.saved_json)}")
            if not Confirm.ask(f"Clear the saved {exc.key} filter and apply these wizard targets?", default=False):
                raise
            approved_filters[exc.key] = exc.saved_json
            approved_context = exc.context_json
    if first_use_remote:
        console.print(
            "[dim]Remote searches start with LinkedIn and ZipRecruiter: "
            "Indeed cannot combine Remote with the selected lookback.[/dim]"
        )
    console.print(f"[green]Discovery settings saved to SQLite at {DB_PATH}[/green]")


# ---------------------------------------------------------------------------
# AI Features
# ---------------------------------------------------------------------------

def _read_env_for_update() -> tuple[tuple[int, ...] | None, str]:
    revision = _file_revision(ENV_PATH)
    if revision is None:
        return None, "# JobCtrl configuration\n\n"
    if not stat.S_ISREG(revision[2]):
        raise ConfigurationError(f"{ENV_PATH.name} is not a regular file; update it manually.")
    try:
        contents = ENV_PATH.read_bytes().decode("utf-8")
    except (OSError, UnicodeError) as exc:
        raise ConfigurationError(f"Cannot read {ENV_PATH.name}; update it manually or retry setup.") from exc
    if _file_revision(ENV_PATH) != revision:
        raise ConfigurationError("AI configuration changed during setup; retry jobctrl init.")
    return revision, contents


def _save_env_updates(revision: tuple[int, ...] | None, contents: str, updates: dict[str, str]) -> None:
    """Update only the chosen keys, preserving all other .env text."""
    from dotenv.parser import parse_stream

    # The dotenv parser removes a leading BOM and associates blank lines
    # before a binding with that binding. Retain both when changing a key.
    rendered: list[str] = ["\ufeff"] if contents.startswith("\ufeff") else []
    contents = contents.removeprefix("\ufeff")
    seen: set[str] = set()
    for binding in parse_stream(io.StringIO(contents)):
        original = binding.original.string
        if binding.key in updates:
            key = binding.key
            value = updates[key].replace("\\", "\\\\").replace("'", "\\'")
            stripped = original.lstrip()
            whitespace = original[: len(original) - len(stripped)]
            prefix = "export " if stripped.startswith(("export ", "export\t")) else ""
            ending = "\r\n" if original.endswith("\r\n") else "\n" if original.endswith("\n") else "\r" if original.endswith("\r") else ""
            rendered.append(f"{whitespace}{prefix}{key}='{value}'{ending}")
            seen.add(key)
        else:
            rendered.append(original)
    output = "".join(rendered)
    for key, raw_value in updates.items():
        if key in seen:
            continue
        if output and not output.endswith(("\n", "\r")):
            output += "\n"
        value = raw_value.replace("\\", "\\\\").replace("'", "\\'")
        output += f"{key}='{value}'\n"
    _replace_wizard_files({ENV_PATH: (output.encode("utf-8"), 0o600)}, {ENV_PATH: revision}, resource="AI configuration")


def _setup_ai_features() -> None:
    """Ask about AI scoring/tailoring — optional LLM configuration."""
    console.print(Panel(
        "[bold]Step 4: AI Features (optional)[/bold]\n"
        "An LLM powers job scoring, resume tailoring, and cover letters.\n"
        "Without this, you can still discover and enrich jobs."
    ))

    if _file_revision(ENV_PATH) is not None:
        console.print("[dim]Existing .env settings and other providers will be retained.[/dim]")
        if not Confirm.ask("Add or update an AI provider credential?", default=False):
            console.print("[dim]Existing AI configuration retained.[/dim]")
            return
    elif not Confirm.ask("Enable AI scoring and resume tailoring?", default=True):
        console.print("[dim]Discovery-only mode. You can configure AI later with [bold]jobctrl init[/bold].[/dim]")
        return

    revision, contents = _read_env_for_update()

    console.print("Supported providers: [bold]Google[/bold], Claude, or Codex CLI")
    provider = Prompt.ask(
        "Provider",
        choices=["google", "claude", "codex"],
        default="google",
    )

    updates: dict[str, str] = {}

    if provider == "google":
        api_key = Prompt.ask("Gemini API key (from aistudio.google.com)", password=True)
        updates["GEMINI_API_KEY"] = api_key
    elif provider == "claude":
        api_key = Prompt.ask("Anthropic API key", password=True)
        updates["ANTHROPIC_API_KEY"] = api_key
    elif provider == "codex":
        codex_home = APP_DIR / "codex_home"
        console.print(
            "[dim]After this wizard, authenticate the isolated Codex CLI with "
            f"`CODEX_HOME={codex_home} codex login` or run `jobctrl setup --launch-logins`.[/dim]"
        )

    if updates or revision is None:
        _save_env_updates(revision, contents, updates)
        console.print(f"[green]AI configuration saved to {ENV_PATH}[/green]")


# ---------------------------------------------------------------------------
# Auto-Apply
# ---------------------------------------------------------------------------

def _setup_auto_apply(*, preserve_existing: bool = False) -> None:
    """Configure autonomous job application (requires a Claude apply runtime)."""
    console.print(Panel(
        "[bold]Step 5: Apply automation (optional)[/bold]\n"
        "By default, JobCtrl does not start a standing apply loop and live "
        "submissions require Apply Review approval. You can opt into a worker-"
        "maintained loop for eligible prepared jobs."
    ))

    if preserve_existing and not Confirm.ask("Change the saved Apply automation settings?", default=False):
        console.print("[dim]Existing Apply automation settings retained.[/dim]")
        return

    saved_automation = load_discovery_control_settings().get("automation")
    expected_automation = dict(saved_automation) if isinstance(saved_automation, dict) else {}
    if not Confirm.ask("Enable the standing auto-apply loop?", default=False):
        save_discovery_automation_settings(
            auto_apply=False,
            # Declining the loop is not a decision to change the approval setting.
            apply_approval_required=None,
            expected_automation=expected_automation,
            initialize_approval_default=not preserve_existing,
        )
        console.print("[dim]Auto apply is off. You can start apply runs manually after reviewing materials.[/dim]")
        return

    approval_required = Confirm.ask(
        "Require Apply Review approval before live submit?",
        default=True,
    )
    save_discovery_automation_settings(
        auto_apply=True,
        apply_approval_required=approval_required,
        expected_automation=expected_automation,
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
    from jobctrl.infrastructure.setup_probes import resolve_claude_apply_binary

    claude_runtime = resolve_claude_apply_binary()
    if shutil.which(claude_runtime) or Path(claude_runtime).expanduser().exists():
        console.print(f"[green]Claude apply runtime detected:[/green] {claude_runtime}")
    else:
        console.print(
            "[yellow]Claude apply runtime was not found.[/yellow]\n"
            "Run [bold]jobctrl setup[/bold] after dependency sync or set [bold]JOBCTRL_CLAUDE_BIN[/bold]."
        )

    # Optional: retain a CapSolver key for future owned CAPTCHA tooling.
    console.print(
        "\n[dim]CAPTCHA challenges currently fail closed during apply runs. "
        "You may still store a CapSolver key for future owned CAPTCHA tooling.[/dim]"
    )
    if Confirm.ask("Configure CapSolver API key? (optional)", default=False):
        revision, contents = _read_env_for_update()
        capsolver_key = Prompt.ask("CapSolver API key", password=True)
        _save_env_updates(revision, contents, {"CAPSOLVER_API_KEY": capsolver_key})
        console.print("[green]CapSolver key saved.[/green]")
    else:
        console.print("[dim]Skipped. CAPTCHA challenges will fail closed.[/dim]")


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

def run_wizard() -> None:
    """Run the full interactive setup wizard."""
    # Re-running setup must not modify profile or search data before the
    # existing search authority has been checked.
    saved_settings = load_saved_search_settings()
    console.print()
    console.print(
        Panel.fit(
            "[bold green]JobCtrl Setup Wizard[/bold green]\n\n"
            "This will create your configuration at:\n"
            f"  [cyan]{APP_DIR}[/cyan]\n\n"
            "You can re-run this anytime with [bold]jobctrl init[/bold].",
            border_style="green",
        )
    )

    ensure_dirs()
    console.print(f"[dim]Created {APP_DIR}[/dim]\n")

    # Step 1: Resume
    pending_resume = _setup_resume()
    console.print()

    # Step 2: Profile
    if "profile_version" in saved_settings["confirmed_targets"]:
        console.print("[dim]Existing Profile retained. Edit it in the web app to change Profile information.[/dim]")
    else:
        _setup_profile()
    console.print()

    # Step 3: Search config
    target = _load_profile_target_search()
    profile_version = target.get("profile_version")
    if profile_version is None:
        raise ConfigurationError(
            "Your Profile changed during setup. Discovery settings are unchanged; retry jobctrl init."
        )
    console.print(
        "[dim]Saved Profile target roles and location/work-model rows take precedence over "
        "the corresponding Discovery rows entered next. Edit Profile in the web app to change active targets.[/dim]"
    )
    _setup_searches(
        expected_profile_target=target,
        check_pending_resume=pending_resume.check if pending_resume is not None else None,
    )
    if pending_resume is not None:
        pending_resume.save()
    console.print()

    # Step 4: AI features (optional LLM)
    _setup_ai_features()
    console.print()

    # Step 5: Auto-apply (Claude runtime detection)
    _setup_auto_apply(
        preserve_existing="profile_version" in saved_settings["confirmed_targets"] or "automation" in saved_settings,
    )
    console.print()

    # Done — show tier status
    from jobctrl.config import get_tier, TIER_LABELS, TIER_COMMANDS

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
        unlock_hint = "\n[dim]To unlock Tier 2: configure an LLM provider (re-run [bold]jobctrl init[/bold]).[/dim]"
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
