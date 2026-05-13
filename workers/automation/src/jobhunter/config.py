"""JobHunter configuration: paths, platform detection, user data."""

import logging
import os
import platform
import re
import shutil
from pathlib import Path

from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.domain.discovery.source_registry import (
    BROAD_BOARD_LEAD_POLICY,
    SMART_EXTRACT_EXPERIMENTAL_POLICY,
    WORKDAY_API_POLICY,
    SourceKind,
    SourcePriority,
    SourceRegistryEntry,
    SourceState,
)
from jobhunter.infrastructure.observability import source_validation_span

log = logging.getLogger(__name__)

# User data directory — all user-specific files live here
APP_DIR = Path(os.environ.get("JOBHUNTER_DIR", Path.home() / ".jobhunter"))

# Core paths
DB_PATH = APP_DIR / "jobhunter.db"
PROFILE_PATH = APP_DIR / "profile.json"
RESUME_PATH = APP_DIR / "resume.txt"
RESUME_PDF_PATH = APP_DIR / "resume.pdf"
RESUME_TEMPLATE_PATH = APP_DIR / "resume_template.tex"
RESUME_STYLE_PATH = APP_DIR / "resume_style.json"
SEARCH_CONFIG_PATH = APP_DIR / "searches.yaml"
ENV_PATH = APP_DIR / ".env"

# Generated output
TAILORED_DIR = APP_DIR / "tailored_resumes"
COVER_LETTER_DIR = APP_DIR / "cover_letters"
LOG_DIR = APP_DIR / "logs"

# Chrome worker isolation
CHROME_WORKER_DIR = APP_DIR / "chrome-workers"
APPLY_WORKER_DIR = APP_DIR / "apply-workers"

# Package-shipped config (YAML registries)
PACKAGE_DIR = Path(__file__).parent
CONFIG_DIR = PACKAGE_DIR / "config"

DEFAULT_JOBSPY_BOARDS = ("indeed", "linkedin", "zip_recruiter")


def get_chrome_path() -> str:
    """Auto-detect Chrome/Chromium executable path, cross-platform.

    Override with CHROME_PATH environment variable.
    """
    env_path = os.environ.get("CHROME_PATH")
    if env_path and Path(env_path).exists():
        return env_path

    system = platform.system()

    if system == "Windows":
        candidates = [
            Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
        ]
    elif system == "Darwin":
        candidates = [
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ]
    else:  # Linux
        candidates = []
        for name in ("google-chrome", "google-chrome-stable", "chromium-browser", "chromium"):
            found = shutil.which(name)
            if found:
                candidates.append(Path(found))

    for c in candidates:
        if c and c.exists():
            return str(c)

    # Fall back to PATH search
    for name in ("google-chrome", "google-chrome-stable", "chromium-browser", "chromium", "chrome"):
        found = shutil.which(name)
        if found:
            return found

    raise FileNotFoundError(
        "Chrome/Chromium not found. Install Chrome or set CHROME_PATH environment variable."
    )


def get_chrome_user_data() -> Path:
    """Default Chrome user data directory, cross-platform."""
    system = platform.system()
    if system == "Windows":
        return Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"
    elif system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "Google" / "Chrome"
    else:
        return Path.home() / ".config" / "google-chrome"


def ensure_dirs():
    """Create all required directories."""
    for d in [APP_DIR, TAILORED_DIR, COVER_LETTER_DIR, LOG_DIR, CHROME_WORKER_DIR, APPLY_WORKER_DIR]:
        d.mkdir(parents=True, exist_ok=True)


def load_search_config() -> dict:
    """Load search configuration from ~/.jobhunter/searches.yaml."""
    import yaml
    if not SEARCH_CONFIG_PATH.exists():
        # Fall back to package-shipped example
        example = CONFIG_DIR / "searches.example.yaml"
        if example.exists():
            return yaml.safe_load(example.read_text(encoding="utf-8"))
        return {}
    return yaml.safe_load(SEARCH_CONFIG_PATH.read_text(encoding="utf-8"))


def load_sites_config() -> dict:
    """Load sites.yaml configuration (sites list, manual_ats, blocked, etc.)."""
    import yaml
    path = CONFIG_DIR / "sites.yaml"
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def load_employers_config() -> dict:
    """Load the packaged Workday employer registry."""
    import yaml

    path = CONFIG_DIR / "employers.yaml"
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def resolve_jobspy_boards(search_cfg: dict | None = None, *, warn: bool = True) -> list[str]:
    """Return JobSpy board names, accepting legacy ``sites`` for one release.

    ``boards`` is the stable product key because it names JobSpy source boards.
    ``sites`` remains accepted as a compatibility alias and logs a warning
    instead of failing existing local configs.
    """
    cfg = search_cfg if search_cfg is not None else load_search_config()
    boards = _string_list(cfg.get("boards")) if isinstance(cfg, dict) else []
    legacy_sites = _string_list(cfg.get("sites")) if isinstance(cfg, dict) else []
    if boards:
        if legacy_sites and legacy_sites != boards and warn:
            log.warning(
                "Both JobSpy 'boards' and legacy 'sites' are configured; using 'boards'. "
                "Remove 'sites' after the compatibility window."
            )
        return boards
    if legacy_sites:
        if warn:
            log.warning(
                "searches.yaml key 'sites' is deprecated for JobSpy board selection; use 'boards'."
            )
        return legacy_sites
    return list(DEFAULT_JOBSPY_BOARDS)


def _source_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "source"


def _validated_source(entry: SourceRegistryEntry) -> SourceRegistryEntry:
    with source_validation_span(
        tenant_id=entry.tenant_id,
        source_id=entry.source_id,
        source_kind=entry.kind.value,
        policy_id=entry.policy.policy_id,
        state=entry.state.value,
        validation_result="ok",
    ):
        return entry


def _smart_extract_sources(sites_cfg: dict) -> list[SourceRegistryEntry]:
    entries: list[SourceRegistryEntry] = []
    base_urls = sites_cfg.get("base_urls", {}) if isinstance(sites_cfg.get("base_urls"), dict) else {}
    for item in sites_cfg.get("sites", []):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        url = str(item.get("url", "")).strip()
        if not name or not url:
            continue
        entries.append(
            _validated_source(
                SourceRegistryEntry(
                    tenant_id=LOCAL_TENANT,
                    source_id=f"smart_extract:{_source_slug(name)}",
                    kind=SourceKind.SMART_EXTRACT,
                    display_name=name,
                    owner="system",
                    priority=SourcePriority.FALLBACK,
                    state=SourceState.EXPERIMENTAL,
                    policy=SMART_EXTRACT_EXPERIMENTAL_POLICY,
                    adapter_config={
                        "name": name,
                        "url": url,
                        "type": item.get("type", "static"),
                        "base_url": base_urls.get(name),
                    },
                )
            )
        )
    return entries


def _workday_sources(employers_cfg: dict) -> list[SourceRegistryEntry]:
    entries: list[SourceRegistryEntry] = []
    employers = employers_cfg.get("employers", {}) if isinstance(employers_cfg, dict) else {}
    if not isinstance(employers, dict):
        return entries
    for key, employer in employers.items():
        if not isinstance(employer, dict):
            continue
        name = str(employer.get("name") or key).strip()
        if not name:
            continue
        entries.append(
            _validated_source(
                SourceRegistryEntry(
                    tenant_id=LOCAL_TENANT,
                    source_id=f"workday:{_source_slug(str(key))}",
                    kind=SourceKind.ATS_API,
                    display_name=name,
                    owner="system",
                    priority=SourcePriority.CANONICAL,
                    state=SourceState.ACTIVE,
                    policy=WORKDAY_API_POLICY,
                    adapter_config={
                        "tenant": employer.get("tenant"),
                        "site_id": employer.get("site_id"),
                        "base_url": employer.get("base_url"),
                    },
                )
            )
        )
    return entries


def _jobspy_sources(search_cfg: dict | None) -> list[SourceRegistryEntry]:
    entries: list[SourceRegistryEntry] = []
    for board in resolve_jobspy_boards(search_cfg, warn=False):
        entries.append(
            _validated_source(
                SourceRegistryEntry(
                    tenant_id=LOCAL_TENANT,
                    source_id=f"jobspy:{_source_slug(board)}",
                    kind=SourceKind.BROAD_BOARD,
                    display_name=f"JobSpy {board}",
                    owner="system",
                    priority=SourcePriority.LEAD_GENERATOR,
                    state=SourceState.EXPERIMENTAL,
                    policy=BROAD_BOARD_LEAD_POLICY,
                    adapter_config={"board": board},
                )
            )
        )
    return entries


def load_source_registry(
    *,
    search_cfg: dict | None = None,
    sites_cfg: dict | None = None,
    employers_cfg: dict | None = None,
) -> list[SourceRegistryEntry]:
    """Generate typed source registry entries from packaged YAML and JobSpy config."""
    active_search_cfg = search_cfg if search_cfg is not None else load_search_config()
    active_sites_cfg = sites_cfg if sites_cfg is not None else load_sites_config()
    active_employers_cfg = employers_cfg if employers_cfg is not None else load_employers_config()
    return [
        *_smart_extract_sources(active_sites_cfg),
        *_workday_sources(active_employers_cfg),
        *_jobspy_sources(active_search_cfg),
    ]


def is_manual_ats(url: str | None) -> bool:
    """Check if a URL routes through an ATS that requires manual application."""
    if not url:
        return False
    sites_cfg = load_sites_config()
    domains = sites_cfg.get("manual_ats", [])
    url_lower = url.lower()
    return any(domain in url_lower for domain in domains)


def load_blocked_sites() -> tuple[set[str], list[str]]:
    """Load blocked sites and URL patterns from sites.yaml.

    Returns:
        (blocked_site_names, blocked_url_patterns)
    """
    cfg = load_sites_config()
    blocked = cfg.get("blocked", {})
    sites = set(blocked.get("sites", []))
    patterns = blocked.get("url_patterns", [])
    return sites, patterns


def load_blocked_sso() -> list[str]:
    """Load blocked SSO domains from sites.yaml."""
    cfg = load_sites_config()
    return cfg.get("blocked_sso", [])


def load_base_urls() -> dict[str, str | None]:
    """Load site base URLs for URL resolution from sites.yaml."""
    cfg = load_sites_config()
    return cfg.get("base_urls", {})


# ---------------------------------------------------------------------------
# Default values — referenced across modules instead of magic numbers
# ---------------------------------------------------------------------------

DEFAULTS = {
    "min_score": 7,
    "max_apply_attempts": 3,
    "max_tailor_attempts": 5,
    "poll_interval": 60,
    "apply_timeout": 300,
    "viewport": "1280x900",
}

def load_env():
    """Load environment variables from ~/.jobhunter/.env if it exists."""
    from dotenv import load_dotenv
    if ENV_PATH.exists():
        load_dotenv(ENV_PATH)
    # Also try CWD .env as fallback
    load_dotenv()


# ---------------------------------------------------------------------------
# Tier system — feature gating by installed dependencies
# ---------------------------------------------------------------------------

TIER_LABELS = {
    1: "Discovery",
    2: "AI Scoring & Tailoring",
    3: "Full Auto-Apply",
}

TIER_COMMANDS: dict[int, list[str]] = {
    1: ["init", "discover", "enrich", "run", "status"],
    2: ["score", "tailor", "cover", "pdf"],
    3: ["apply"],
}


def get_tier() -> int:
    """Detect the current tier based on available dependencies.

    Tier 1 (Discovery):            Python + pip
    Tier 2 (AI Scoring & Tailoring): + LLM API key
    Tier 3 (Full Auto-Apply):       + Claude Code CLI + Chrome
    """
    load_env()

    has_llm = any(os.environ.get(k) for k in ("GEMINI_API_KEY", "OPENAI_API_KEY", "LLM_URL"))
    if not has_llm:
        return 1

    has_claude = shutil.which("claude") is not None
    try:
        get_chrome_path()
        has_chrome = True
    except FileNotFoundError:
        has_chrome = False

    if has_claude and has_chrome:
        return 3

    return 2


def check_tier(required: int, feature: str) -> None:
    """Raise SystemExit with a clear message if the current tier is too low.

    Args:
        required: Minimum tier needed (1, 2, or 3).
        feature: Human-readable description of the feature being gated.
    """
    current = get_tier()
    if current >= required:
        return

    from rich.console import Console
    _console = Console(stderr=True)

    missing: list[str] = []
    if required >= 2 and not any(os.environ.get(k) for k in ("GEMINI_API_KEY", "OPENAI_API_KEY", "LLM_URL")):
        missing.append("LLM API key — run [bold]jobhunter init[/bold] or set GEMINI_API_KEY")
    if required >= 3:
        if not shutil.which("claude"):
            missing.append("Claude Code CLI — install from [bold]https://claude.ai/code[/bold]")
        try:
            get_chrome_path()
        except FileNotFoundError:
            missing.append("Chrome/Chromium — install or set CHROME_PATH")

    _console.print(
        f"\n[red]'{feature}' requires {TIER_LABELS.get(required, f'Tier {required}')} (Tier {required}).[/red]\n"
        f"Current tier: {TIER_LABELS.get(current, f'Tier {current}')} (Tier {current})."
    )
    if missing:
        _console.print("\n[yellow]Missing:[/yellow]")
        for m in missing:
            _console.print(f"  - {m}")
    _console.print()
    raise SystemExit(1)
