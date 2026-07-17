"""JobCtrl configuration: paths, platform detection, user data."""

import json
import logging
import os
import platform
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
from collections.abc import Callable, Iterator, Mapping, MutableMapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from jobctrl.runtime import is_bundled_runtime, owned_env_path
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.domain.discovery.source_registry import (
    ATS_API_POLICY,
    BROAD_BOARD_LEAD_POLICY,
    SMART_EXTRACT_EXPERIMENTAL_POLICY,
    WORKDAY_API_POLICY,
    SourceKind,
    SourcePriority,
    SourceQualityPlaceholder,
    SourceRegistryEntry,
    SourceState,
)
from jobctrl.discovery.target_queries import build_target_role_queries
from jobctrl.infrastructure.observability import source_validation_span

log = logging.getLogger(__name__)

APP_DIRNAME = ".jobctrl"
DB_FILENAME = "jobctrl.db"
CONFIG_FILENAME = "config.json"
CONFIG_LOCK_DIRECTORY = ".config.lock"
CONFIG_LOCK_TIMEOUT_SECONDS = 30.0
CONFIG_LOCK_STALE_SECONDS = 15 * 60.0
CONFIG_LOCK_RETRY_SECONDS = 0.01
_LEGACY_TOKEN = "job" + "hunter"
_LEGACY_TOKENS = ("job" + "ctl", _LEGACY_TOKEN)

KEYCHAIN_SERVICE = "JobCtrl"
KEYCHAIN_SECURITY_BINARY = "/usr/bin/security"
KEYCHAIN_PROVIDER_KEYS = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "CAPSOLVER_API_KEY",
)
PROVIDER_CONFIGURATION_KEYS = (
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "ANTHROPIC_AWS_WORKSPACE_ID",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLOUD_ML_REGION",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "AWS_PROFILE",
    "AWS_REGION",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
)
KEYCHAIN_ACCOUNT_MAPPING = "key"
KEYCHAIN_REQUIRES_WORKER_RESTART = True
KEYCHAIN_LOOKUP_TIMEOUT_SECONDS = 2.0

KeychainFallbackStatus = Literal["explicit", "loaded", "missing", "unavailable", "unsupported"]
KeychainFallbackReason = Literal[
    "environment_precedence",
    "loaded",
    "item_not_found",
    "empty_value",
    "binary_missing",
    "command_failed",
    "timeout",
    "non_darwin",
]


@dataclass(frozen=True)
class KeychainFallbackDiagnostic:
    """Secret-free result for one optional macOS Keychain lookup."""

    key: str
    status: KeychainFallbackStatus
    reason: KeychainFallbackReason


_KEYCHAIN_FALLBACK_DIAGNOSTICS: tuple[KeychainFallbackDiagnostic, ...] | None = None


def _find_macos_security_binary(_name: str) -> str | None:
    """Return the trusted system Keychain CLI, never a PATH-resolved shim."""

    return KEYCHAIN_SECURITY_BINARY if os.access(KEYCHAIN_SECURITY_BINARY, os.X_OK) else None


def _is_confirmed_keychain_miss(returncode: int, stderr: str) -> bool:
    """Recognize only Apple's confirmed item-not-found result, never broad stderr fragments."""

    if returncode == 44:
        return True
    return (
        re.fullmatch(
            r"(?:security:\s*[^:\r\n]+:\s*)?"
            r"The specified item could not be found(?: in the keychain)?\.?",
            stderr.strip(),
            flags=re.IGNORECASE,
        )
        is not None
    )


def _keychain_account(key: str) -> str:
    """Apply the cross-runtime account convention guarded by parity tests."""

    if KEYCHAIN_ACCOUNT_MAPPING != "key":
        raise RuntimeError("unsupported Keychain account mapping")
    return key


class WorkspaceMigrationError(RuntimeError):
    """Raised when a legacy database schema migration cannot proceed safely."""


class ConfigFileError(RuntimeError):
    """Raised when config.json cannot be read or written without data loss."""


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _table_columns(conn: sqlite3.Connection, table_name: str) -> list[str]:
    return [str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table_name}")').fetchall()]


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


_JOB_LIFECYCLE_TABLES = {
    "deleted_jobs": {
        "current": "jobctrl_deleted_jobs",
        "create_sql": """
            CREATE TABLE IF NOT EXISTS jobctrl_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT,
                restored_at TEXT
            )
        """,
        "additive_columns": {
            "deleted_at": "TEXT NOT NULL DEFAULT ''",
            "reason": "TEXT",
            "restored_at": "TEXT",
        },
    },
    "hidden_jobs": {
        "current": "jobctrl_hidden_jobs",
        "create_sql": """
            CREATE TABLE IF NOT EXISTS jobctrl_hidden_jobs (
                job_url TEXT PRIMARY KEY,
                hidden_at TEXT NOT NULL,
                reason TEXT,
                unhidden_at TEXT
            )
        """,
        "additive_columns": {
            "hidden_at": "TEXT NOT NULL DEFAULT ''",
            "reason": "TEXT",
            "unhidden_at": "TEXT",
        },
    },
}


def _ensure_job_lifecycle_table_schema(conn: sqlite3.Connection, suffix: str) -> bool:
    spec = _JOB_LIFECYCLE_TABLES[suffix]
    current = str(spec["current"])
    changed = not _table_exists(conn, current)
    conn.execute(str(spec["create_sql"]))
    existing_columns = set(_table_columns(conn, current))
    for column, definition in dict(spec["additive_columns"]).items():
        if column in existing_columns:
            continue
        conn.execute(f'ALTER TABLE "{current}" ADD COLUMN "{column}" {definition}')
        existing_columns.add(column)
        changed = True
    return changed


def migrate_legacy_job_tables(conn: sqlite3.Connection) -> list[str]:
    """Move legacy tombstone rows to the JobCtrl schema names.

    The owner migration is intentionally one-way: if both names exist, rows are
    merged into the new table and the legacy table is dropped so new code has a
    single schema surface. Legacy-only tables are copied into a freshly created
    current table instead of renamed, because older schemas can be missing
    lifecycle columns used by the read model.
    """
    renamed: list[str] = []
    with conn:
        for suffix, spec in _JOB_LIFECYCLE_TABLES.items():
            legacy_tables = [f"{token}_{suffix}" for token in _LEGACY_TOKENS]
            current = str(spec["current"])
            existing_legacy_tables = [table for table in legacy_tables if _table_exists(conn, table)]
            current_exists = _table_exists(conn, current)
            if not existing_legacy_tables and not current_exists:
                continue

            for legacy in existing_legacy_tables:
                legacy_columns = _table_columns(conn, legacy)
                known_columns = {"job_url", *dict(spec["additive_columns"]).keys()}
                common_columns = [column for column in legacy_columns if column in known_columns]
                if "job_url" not in common_columns:
                    raise WorkspaceMigrationError(
                        f"cannot migrate legacy table {legacy}: missing job_url column for {current}"
                    )

            _assert_no_lifecycle_migration_conflicts(conn, current, existing_legacy_tables)
            _ensure_job_lifecycle_table_schema(conn, suffix)
            if not existing_legacy_tables:
                continue

            for legacy in existing_legacy_tables:
                legacy_columns = _table_columns(conn, legacy)
                current_columns = _table_columns(conn, current)
                common_columns = [column for column in legacy_columns if column in current_columns]
                columns = ", ".join(_quote_identifier(column) for column in common_columns)
                conn.execute(
                    f"INSERT INTO {_quote_identifier(current)} ({columns}) "
                    f"SELECT {columns} FROM {_quote_identifier(legacy)}"
                )
                conn.execute(f"DROP TABLE {_quote_identifier(legacy)}")
                if current not in renamed:
                    renamed.append(current)
    return renamed


def _assert_no_lifecycle_migration_conflicts(
    conn: sqlite3.Connection,
    current: str,
    legacy_tables: list[str],
) -> None:
    sources = ([current] if _table_exists(conn, current) else []) + legacy_tables
    seen: dict[str, str] = {}
    for source in sources:
        columns = _table_columns(conn, source)
        if "job_url" not in columns:
            raise WorkspaceMigrationError(
                f"cannot migrate lifecycle table {source}: missing job_url column"
            )
        for row in conn.execute(
            f"SELECT job_url FROM {_quote_identifier(source)} WHERE job_url IS NOT NULL"
        ):
            job_url = str(row[0])
            previous_source = seen.get(job_url)
            if previous_source is not None:
                raise WorkspaceMigrationError(
                    f"cannot migrate lifecycle tables for {current}: duplicate job_url in "
                    f"{previous_source} and {source}"
                )
            seen[job_url] = source


def resolve_default_workspace(home: Path | None = None) -> Path:
    """Resolve the local workspace directory.

    Legacy default-directory migration was a one-time rename bridge and is no
    longer performed during runtime startup.
    """
    if os.environ.get("JOBCTRL_DIR"):
        return Path(os.environ["JOBCTRL_DIR"]).expanduser()

    root = Path.home() if home is None else home
    return root / APP_DIRNAME


# User data directory — all user-specific files live here
APP_DIR = resolve_default_workspace()

# Core paths
DB_PATH = APP_DIR / DB_FILENAME
RESUME_PATH = APP_DIR / "resume.txt"
RESUME_PDF_PATH = APP_DIR / "resume.pdf"
RESUME_TEMPLATE_PATH = APP_DIR / "resume_template.tex"
RESUME_STYLE_PATH = APP_DIR / "resume_style.json"
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
TARGET_SEARCH_MIN_HOURS_OLD = 24 * 30
DISCOVERY_SETTINGS_TABLE = "discovery_settings"

DEFAULT_DISCOVERY_SEARCH_CONFIG: dict = {
    "boards": list(DEFAULT_JOBSPY_BOARDS),
    "defaults": {
        "hours_old": 72,
        "results_per_site": 50,
    },
    "queries": [{"query": "Software Engineer", "tier": 1}],
    "locations": [{"label": "remote", "location": "Remote", "remote": True}],
    "location_accept": ["Remote"],
    "location": {"accept_patterns": ["Remote"], "reject_patterns": []},
    "scheduling_enabled": False,
    "schedule_cron": "0 7 * * *",
    "role_filter": {"mode": "auto", "model": None},
    "max_parallel_families": 1,
    "crawl_user_agent": {
        "product": "JobCtrl",
        "contact": "https://github.com/ebarti/JobCtrl",
    },
}

# Contact & Outreach follow-up reminders (R6 Phase 4). Default-OFF, mirroring
# discovery ``scheduling_enabled``: any optional recurring reminder is disabled by
# default (fail-closed). Even when enabled, follow-ups are only SURFACED as due
# items in the UI — nothing is ever sent (INV-1: no auto-send, no transport).
DEFAULT_OUTREACH_FOLLOW_UP_CONFIG: dict = {
    "reminders_enabled": False,
}

_EUROPE_TARGET_MARKERS = (
    "spain",
    "españa",
    "europe",
    "european union",
    " eu",
    "eu ",
)

_REMOTE_EUROPE_LOCATION_ACCEPTS = (
    "Europe",
    "European Union",
    "EU",
    "EMEA",
)

_WORKDAY_HOST_ALIAS_SOURCE_RE = re.compile(r"^workday:(?P<employer>.+)-wd\d+-myworkdayjobs-com$")

_SPAIN_LOCATION_ACCEPTS = (
    "Spain",
    "España",
    "ES",
)

_AMERICA_LOCATION_REJECTS = (
    "United States",
    "USA",
    "US only",
    "U.S.",
    "Canada",
    "Canada only",
    "Mexico",
    "North America",
    "South America",
    "Latin America",
    "LATAM",
    "Americas",
)

_EUROPEAN_COUNTRY_ALIASES = {
    "albania": ("albania",),
    "andorra": ("andorra",),
    "austria": ("austria",),
    "belarus": ("belarus",),
    "belgium": ("belgium",),
    "bosnia and herzegovina": ("bosnia and herzegovina", "bosnia"),
    "bulgaria": ("bulgaria",),
    "croatia": ("croatia",),
    "cyprus": ("cyprus",),
    "czech republic": ("czech republic", "czechia"),
    "denmark": ("denmark",),
    "estonia": ("estonia",),
    "finland": ("finland",),
    "france": ("france",),
    "germany": ("germany",),
    "greece": ("greece",),
    "hungary": ("hungary",),
    "iceland": ("iceland",),
    "ireland": ("ireland",),
    "italy": ("italy",),
    "kosovo": ("kosovo",),
    "latvia": ("latvia",),
    "liechtenstein": ("liechtenstein",),
    "lithuania": ("lithuania",),
    "luxembourg": ("luxembourg",),
    "malta": ("malta",),
    "moldova": ("moldova",),
    "monaco": ("monaco",),
    "montenegro": ("montenegro",),
    "netherlands": ("netherlands", "the netherlands"),
    "north macedonia": ("north macedonia", "macedonia"),
    "norway": ("norway",),
    "poland": ("poland",),
    "portugal": ("portugal",),
    "romania": ("romania",),
    "san marino": ("san marino",),
    "serbia": ("serbia",),
    "slovakia": ("slovakia",),
    "slovenia": ("slovenia",),
    "spain": ("spain", "españa", "es"),
    "sweden": ("sweden",),
    "switzerland": ("switzerland",),
    "ukraine": ("ukraine",),
    "united kingdom": ("united kingdom", "uk", "great britain", "england", "scotland", "wales"),
    "vatican city": ("vatican city", "vatican"),
}

_INDEED_COUNTRY_BY_TARGET_COUNTRY = {
    "spain": "spain",
}

_AMERICA_ONLY_SOURCE_MARKERS = (
    "canada",
    "canadian",
    "job bank",
    "job-bank",
    "careerjet canada",
    "careerjet-canada",
    "randstad canada",
    "randstad-canada",
    "eluta",
    "jobbank.gc.ca",
    "careerjet.ca",
    "randstad.ca",
    "eluta.ca",
    "smart_extract:dice",
    "dice.com",
    "wellfound.com/role/l/software-engineer/canada",
)


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
            Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"))
            / "Google/Chrome/Application/chrome.exe",
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

    raise FileNotFoundError("Chrome/Chromium not found. Install Chrome or set CHROME_PATH environment variable.")


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
    """Load discovery search configuration from SQLite, then overlay target search."""
    search_cfg = _load_discovery_search_config_from_db()
    if search_cfg is None:
        search_cfg = _default_discovery_search_config()
    return effective_discovery_search_config(_apply_profile_target_search(search_cfg))


def effective_discovery_search_config(
    search_cfg: Mapping[str, object] | None = None,
) -> dict:
    """Normalize the SQLite-owned discovery settings for execution."""
    effective = json.loads(json.dumps(dict(search_cfg or _default_discovery_search_config())))

    role_filter = dict(effective.get("role_filter") or {})
    role_filter["mode"] = _role_filter_mode(role_filter.get("mode"))
    role_filter["model"] = str(role_filter.get("model") or "").strip() or None
    effective["role_filter"] = role_filter

    effective["max_parallel_families"] = min(
        4,
        max(1, _positive_int(effective.get("max_parallel_families")) or 1),
    )

    crawl_user_agent = dict(effective.get("crawl_user_agent") or {})
    crawl_user_agent["product"] = str(crawl_user_agent.get("product") or "").strip() or "JobCtrl"
    crawl_user_agent["contact"] = str(crawl_user_agent.get("contact") or "").strip()
    effective["crawl_user_agent"] = crawl_user_agent
    return effective


def _role_filter_mode(value: object) -> str:
    normalized = str(value or "auto").strip().lower()
    if normalized in {"deterministic", "0", "false", "no", "off", "disabled"}:
        return "deterministic"
    if normalized in {"llm", "1", "true", "yes", "on", "enabled"}:
        return "llm"
    return "auto"


def load_discovery_schedule_settings() -> tuple[bool, str]:
    """Return discovery schedule settings from the persisted search config."""
    search_cfg = _load_discovery_search_config_from_db()
    if search_cfg is None:
        search_cfg = _default_discovery_search_config()
    enabled = _bool_config(search_cfg.get("scheduling_enabled"), False)
    cron = str(search_cfg.get("schedule_cron") or "0 7 * * *").strip() or "0 7 * * *"
    return enabled, cron


def load_discovery_automation_settings() -> dict[str, object]:
    """Return the automation controls persisted with the Discovery page."""
    search_cfg = _load_discovery_search_config_from_db() or _default_discovery_search_config()
    automation = search_cfg.get("automation")
    automation = automation if isinstance(automation, dict) else {}
    raw_min_score = automation.get("min_fit_score")
    try:
        min_fit_score = min(10, max(0, int(raw_min_score)))
    except (TypeError, ValueError):
        min_fit_score = 7
    return {
        "min_fit_score": min_fit_score,
        "auto_apply": _bool_config(automation.get("auto_apply"), False),
        "apply_approval_required": _bool_config(
            automation.get("apply_approval_required"),
            True,
        ),
    }


def save_discovery_automation_settings(
    *,
    auto_apply: bool,
    apply_approval_required: bool,
) -> None:
    """Persist Apply automation choices with the SQLite-owned Discovery settings."""
    search_cfg = _load_discovery_search_config_from_db() or _default_discovery_search_config()
    raw_automation = search_cfg.get("automation")
    automation = dict(raw_automation) if isinstance(raw_automation, dict) else {}
    automation.update(
        {
            "auto_apply": bool(auto_apply),
            "apply_approval_required": bool(apply_approval_required),
        }
    )
    search_cfg["automation"] = automation
    _save_discovery_search_config_to_db(search_cfg)


def outreach_follow_up_reminders_enabled(config: dict | None = None) -> bool:
    """Whether the optional recurring outreach follow-up reminder is enabled.

    Default-OFF (fail-closed), mirroring discovery ``scheduling_enabled``. Even
    when enabled it only SURFACES due follow-ups; it never sends (INV-1). The
    surfaced due-follow-ups read model is always available regardless of this
    flag — the flag governs only an optional recurring re-notification.
    """
    cfg = config if config is not None else DEFAULT_OUTREACH_FOLLOW_UP_CONFIG
    return _bool_config(cfg.get("reminders_enabled"), False)


def _default_discovery_search_config() -> dict:
    return json.loads(json.dumps(DEFAULT_DISCOVERY_SEARCH_CONFIG))


def _bool_config(value: object, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "no", "off"}
    return default


def _ensure_discovery_settings_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {DISCOVERY_SETTINGS_TABLE} (
            tenant_id          TEXT PRIMARY KEY,
            search_config_json TEXT NOT NULL,
            created_at         TEXT NOT NULL,
            updated_at         TEXT NOT NULL
        )
        """
    )


def _load_discovery_search_config_from_db() -> dict | None:
    if not DB_PATH.exists():
        return None
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        _ensure_discovery_settings_table(conn)
        row = conn.execute(
            f"""
            SELECT search_config_json
            FROM {DISCOVERY_SETTINGS_TABLE}
            WHERE tenant_id = ?
            """,
            (str(LOCAL_TENANT),),
        ).fetchone()
        if row is None:
            conn.commit()
            return None
        loaded = json.loads(str(row["search_config_json"] or "{}"))
        if isinstance(loaded, dict):
            conn.commit()
            return loaded
    except Exception:
        log.debug("Failed to load discovery settings from SQLite", exc_info=True)
    finally:
        if conn is not None:
            conn.close()
    return None


def _save_discovery_search_config_to_db(search_cfg: dict) -> None:
    if not DB_PATH.exists():
        return
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(DB_PATH)
        _ensure_discovery_settings_table(conn)
        now = datetime_utc_now()
        conn.execute(
            f"""
            INSERT INTO {DISCOVERY_SETTINGS_TABLE} (
                tenant_id, search_config_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(tenant_id) DO UPDATE SET
                search_config_json = excluded.search_config_json,
                updated_at = excluded.updated_at
            """,
            (
                str(LOCAL_TENANT),
                json.dumps(search_cfg, sort_keys=True),
                now,
                now,
            ),
        )
        conn.commit()
    except Exception:
        log.debug("Failed to save discovery settings to SQLite", exc_info=True)
    finally:
        if conn is not None:
            conn.close()


def datetime_utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _apply_profile_target_search(search_cfg: dict, target: dict | None = None) -> dict:
    """Overlay profile target roles and locations onto the discovery search config."""
    target_search = target if target is not None else _load_profile_target_search()
    roles = target_search.get("roles", [])
    tracks = target_search.get("tracks", [])
    seniority = target_search.get("seniority", [])
    functions = target_search.get("functions", [])
    specializations = target_search.get("specializations", [])
    locations = target_search.get("locations", [])
    work_models = target_search.get("work_models", [])

    if not roles and not tracks and not seniority and not functions and not locations:
        return search_cfg

    next_cfg = dict(search_cfg)
    if roles or tracks or seniority or functions:
        target_queries = build_target_role_queries(
            roles,
            tracks=tracks,
            seniority=seniority,
            functions=functions,
            specializations=specializations,
        )
        if target_queries:
            next_cfg["queries"] = target_queries
            next_cfg["workday_max_tier"] = 1
            next_cfg["ats_max_tier"] = 1

    if locations:
        target_locations = _build_target_location_config(locations, work_models)
        next_cfg["locations"] = target_locations["locations"]
        next_cfg["location_labels"] = [item["label"] for item in target_locations["locations"]]
        next_cfg["location_accept"] = target_locations["accept"]
        next_cfg["location_accept_local"] = target_locations["local_accept"]
        location_cfg = dict(next_cfg.get("location") or {})
        location_cfg["accept_patterns"] = target_locations["accept"]
        location_cfg["local_accept_patterns"] = target_locations["local_accept"]
        next_cfg["location"] = location_cfg

        if target_locations["europe"]:
            defaults = dict(next_cfg.get("defaults") or {})
            defaults["hours_old"] = max(_positive_int(defaults.get("hours_old")), TARGET_SEARCH_MIN_HOURS_OLD)
            if target_locations["country_indeed"]:
                defaults.setdefault("country_indeed", target_locations["country_indeed"])
            next_cfg["defaults"] = defaults
            if target_locations["country"]:
                next_cfg["country"] = target_locations["country"]
            next_cfg["target_region"] = "europe"
            next_cfg["location_reject_non_remote"] = _dedupe_strings(
                [*_string_list(next_cfg.get("location_reject_non_remote")), *_AMERICA_LOCATION_REJECTS]
            )

    return next_cfg


def _build_target_location_config(locations: list[str], work_models: list[str]) -> dict:
    search_locations: list[dict] = []
    accept: list[str] = []
    local_accept: list[str] = []
    first_country = ""
    first_indeed_country = ""
    europe = False

    for index, raw_location in enumerate(locations):
        location = str(raw_location or "").strip()
        if not location:
            continue
        work_model = work_models[index] if index < len(work_models) else ""
        wants_remote, wants_local = _target_work_model_flags(work_model)
        country = _target_location_country(location)
        country_key = _country_key(country)
        is_european_country = _is_european_country(country_key)

        if wants_local:
            _append_search_location(search_locations, location=location, remote=False)
            accept.append(location)
            local_accept.append(location)

        if wants_remote:
            remote_country = _display_country(country) or location
            _append_search_location(search_locations, location=remote_country, remote=True)
            accept.extend(_country_location_accepts(country_key, remote_country))
            if is_european_country:
                _append_search_location(
                    search_locations,
                    location="European Union",
                    remote=True,
                    label="europe-remote",
                )
                accept.extend(_REMOTE_EUROPE_LOCATION_ACCEPTS)

        if is_european_country:
            europe = True
            first_country = first_country or (_display_country(country) or location)
            first_indeed_country = first_indeed_country or _INDEED_COUNTRY_BY_TARGET_COUNTRY.get(country_key, "")

    return {
        "locations": search_locations,
        "accept": _dedupe_strings(accept),
        "local_accept": _dedupe_strings(local_accept),
        "country": first_country,
        "country_indeed": first_indeed_country,
        "europe": europe,
    }


def _append_search_location(
    search_locations: list[dict],
    *,
    location: str,
    remote: bool,
    label: str | None = None,
) -> None:
    entry = {
        "label": label or _source_slug(location),
        "location": location,
        "remote": remote,
    }
    key = (entry["label"], entry["location"], entry["remote"])
    if key not in {(item["label"], item["location"], item["remote"]) for item in search_locations}:
        search_locations.append(entry)


def _target_work_model_flags(work_model: str) -> tuple[bool, bool]:
    target = str(work_model or "").lower()
    wants_remote = any(marker in target for marker in ("remote", "anywhere", "distributed"))
    wants_local = any(marker in target for marker in ("hybrid", "on-site", "onsite", "on site", "office"))
    if not wants_remote and not wants_local:
        wants_local = True
    return wants_remote, wants_local


def _target_location_country(location: str) -> str:
    parts = [part.strip() for part in str(location or "").split(",") if part.strip()]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    return parts[-1]


def _display_country(country: str) -> str:
    country_key = _country_key(country)
    if country_key == "spain":
        return "Spain"
    for canonical, aliases in _EUROPEAN_COUNTRY_ALIASES.items():
        if country_key == canonical or country_key in aliases:
            return canonical.title()
    return country.strip()


def _country_key(country: str) -> str:
    normalized = str(country or "").strip().lower()
    for canonical, aliases in _EUROPEAN_COUNTRY_ALIASES.items():
        if normalized == canonical or normalized in aliases:
            return canonical
    return normalized


def _positive_int(value: object) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return 0
    return result if result > 0 else 0


def _is_european_country(country_key: str) -> bool:
    return country_key in _EUROPEAN_COUNTRY_ALIASES


def _country_location_accepts(country_key: str, fallback: str) -> list[str]:
    if country_key == "spain":
        return list(_SPAIN_LOCATION_ACCEPTS)
    aliases = _EUROPEAN_COUNTRY_ALIASES.get(country_key)
    if aliases:
        return [alias.title() if len(alias) > 3 else alias.upper() for alias in aliases]
    return [fallback]


def _load_profile_target_search() -> dict[str, list[str]]:
    if not DB_PATH.exists():
        return _empty_target_search()
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'candidate_profiles'"
        ).fetchone()
        if table is None:
            return _empty_target_search()
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(candidate_profiles)").fetchall()}
        row = conn.execute(
            f"""
            SELECT {_profile_target_column(columns, "experience_target_role")},
                   {_profile_target_column(columns, "experience_target_track")},
                   {_profile_target_column(columns, "experience_target_seniority_floor")},
                   {_profile_target_column(columns, "experience_target_functions")},
                   {_profile_target_column(columns, "experience_target_specializations")},
                   {_profile_target_column(columns, "experience_target_locations")},
                   {_profile_target_column(columns, "experience_target_work_models")},
                   personal_city, personal_country
            FROM candidate_profiles
            WHERE tenant_id = ? AND profile_id = ?
            """,
            (str(LOCAL_TENANT), "default"),
        ).fetchone()
        if row is None:
            return _empty_target_search()
        roles = _split_target_text(row["experience_target_role"])
        locations = _split_target_text(row["experience_target_locations"])
        return {
            "roles": roles,
            "tracks": _split_target_text(row["experience_target_track"]),
            "seniority": _split_target_text(row["experience_target_seniority_floor"]),
            "functions": _split_target_text(row["experience_target_functions"]),
            "specializations": _split_target_text(row["experience_target_specializations"]),
            "locations": locations or _profile_home_location(row),
            "work_models": _split_target_text(row["experience_target_work_models"]),
        }
    except Exception:
        log.debug("Failed to load profile target-search preferences", exc_info=True)
        return _empty_target_search()
    finally:
        if conn is not None:
            conn.close()


def _empty_target_search() -> dict[str, list[str]]:
    return {
        "roles": [],
        "tracks": [],
        "seniority": [],
        "functions": [],
        "specializations": [],
        "locations": [],
        "work_models": [],
    }


def _profile_target_column(columns: set[str], column: str) -> str:
    if column in columns:
        return column
    return f"'' AS {column}"


def _split_target_text(value: object) -> list[str]:
    if value is None:
        return []
    cleaned = re.sub(r"^\s*Target (?:roles?|locations?):\s*", "", str(value), flags=re.IGNORECASE)
    return [item.strip() for item in re.split(r"[;\n]+", cleaned) if item.strip()]


def _profile_home_location(row: sqlite3.Row) -> list[str]:
    city = str(row["personal_city"] or "").strip()
    country = str(row["personal_country"] or "").strip()
    if city and country:
        return [f"{city}, {country}"]
    if country:
        return [country]
    if city:
        return [city]
    return []


def _target_location_is_remote(location: str, work_model: str) -> bool:
    target = f"{location} {work_model}".lower()
    return any(marker in target for marker in ("remote", "anywhere", "distributed"))


def _target_prefers_europe_from_values(locations: list[str]) -> bool:
    target = f" {' '.join(locations)} ".lower()
    return any(marker in target for marker in _EUROPE_TARGET_MARKERS)


def _target_prefers_europe(search_cfg: dict | None) -> bool:
    if not isinstance(search_cfg, dict):
        return False
    if str(search_cfg.get("target_region") or "").strip().lower() == "europe":
        return True
    defaults = search_cfg.get("defaults") if isinstance(search_cfg.get("defaults"), dict) else {}
    country = f"{search_cfg.get('country') or ''} {defaults.get('country_indeed') or ''}".lower()
    if any(marker.strip() in country for marker in ("spain", "españa", "europe")):
        return True
    locations = [
        str(item.get("location") or item.get("label") or "")
        for item in search_cfg.get("locations", [])
        if isinstance(item, dict)
    ]
    return _target_prefers_europe_from_values(locations)


def _dedupe_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = value.strip()
        key = normalized.lower()
        if normalized and key not in seen:
            result.append(normalized)
            seen.add(key)
    return result


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
    """Return JobStreaming board names, accepting legacy ``sites`` for one release.

    ``boards`` is the stable product key. The internal ``jobspy:`` source-id
    prefix remains a compatibility identifier after the provider migration.
    ``sites`` remains accepted as a compatibility alias and logs a warning
    instead of failing existing local configs.
    """
    cfg = search_cfg if search_cfg is not None else load_search_config()
    boards = _string_list(cfg.get("boards")) if isinstance(cfg, dict) else []
    legacy_sites = _string_list(cfg.get("sites")) if isinstance(cfg, dict) else []
    if boards:
        if legacy_sites and legacy_sites != boards and warn:
            log.warning(
                "Both JobStreaming 'boards' and legacy 'sites' are configured; using 'boards'. "
                "Remove 'sites' after the compatibility window."
            )
        return boards
    if legacy_sites:
        if warn:
            log.warning("Discovery settings key 'sites' is deprecated for JobStreaming board selection; use 'boards'.")
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
        adapter_config = {
            "name": name,
            "url": url,
            "type": item.get("type", "static"),
            "base_url": base_urls.get(name),
        }
        for optional_key in ("query_mode", "search_mode"):
            if item.get(optional_key):
                adapter_config[optional_key] = item[optional_key]
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
                    adapter_config=adapter_config,
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
                        "employer_key": str(key),
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
                    display_name=f"Broad board: {board}",
                    owner="system",
                    priority=SourcePriority.LEAD_GENERATOR,
                    state=SourceState.EXPERIMENTAL,
                    policy=BROAD_BOARD_LEAD_POLICY,
                    adapter_config={"board": board},
                )
            )
        )
    return entries


def _configured_sources(sites_cfg: dict) -> list[SourceRegistryEntry]:
    """Load explicit RFC-style source registry entries from ``sites.yaml``."""
    entries: list[SourceRegistryEntry] = []
    raw_sources = sites_cfg.get("sources", [])
    if not isinstance(raw_sources, list):
        return entries
    for item in raw_sources:
        if not isinstance(item, dict):
            continue
        source_id = str(item.get("id") or item.get("source_id") or "").strip()
        display_name = str(item.get("display_name") or item.get("name") or source_id).strip()
        if not source_id or not display_name:
            continue
        kind = _enum_value(SourceKind, item.get("kind"), SourceKind.EMPLOYER_CAREERS_PAGE)
        priority = _enum_value(
            SourcePriority,
            item.get("priority"),
            SourcePriority.CANONICAL if kind is SourceKind.ATS_API else SourcePriority.STANDARD,
        )
        state = _enum_value(SourceState, item.get("state"), SourceState.EXPERIMENTAL)
        seed_url = str(item.get("seed_url") or item.get("url") or "").strip()
        adapter_config = {
            key: value
            for key, value in {
                "name": display_name,
                "url": seed_url,
                "seed_url": seed_url,
                "ats_kind": item.get("ats_kind"),
                "board_token": item.get("board_token"),
                "site": item.get("site"),
                "board_name": item.get("board_name"),
                "company": item.get("company"),
            }.items()
            if value not in (None, "")
        }
        entries.append(
            _validated_source(
                SourceRegistryEntry(
                    tenant_id=LOCAL_TENANT,
                    source_id=source_id,
                    kind=kind,
                    display_name=display_name,
                    owner=str(item.get("owner") or "system"),
                    priority=priority,
                    state=state,
                    policy=_policy_for_local_source(kind, source_id),
                    adapter_config=adapter_config,
                )
            )
        )
    return entries


def _enum_value(enum_type, value: object, fallback):
    try:
        return enum_type(str(value))
    except (TypeError, ValueError):
        return fallback


def _policy_for_local_source(kind: SourceKind, source_id: str):
    if source_id.startswith("workday:"):
        return WORKDAY_API_POLICY
    if kind is SourceKind.BROAD_BOARD:
        return BROAD_BOARD_LEAD_POLICY
    if kind is SourceKind.ATS_API:
        return ATS_API_POLICY
    return SMART_EXTRACT_EXPERIMENTAL_POLICY


def _local_source_registry_rows() -> list[sqlite3.Row]:
    if not DB_PATH.exists():
        return []
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_registry_entries'"
        ).fetchone()
        if table is None:
            return []
        return list(
            conn.execute(
                """
                SELECT source_id, kind, display_name, owner, priority, state,
                       policy_id, seed_url
                FROM source_registry_entries
                WHERE tenant_id = ?
                ORDER BY created_at ASC, source_id ASC
                """,
                (str(LOCAL_TENANT),),
            )
        )
    except Exception:
        log.debug("Failed to load local source registry overrides", exc_info=True)
        return []
    finally:
        if conn is not None:
            conn.close()


def _adapter_config_from_row(row: sqlite3.Row) -> dict:
    seed_url = str(row["seed_url"] or "").strip()
    if not seed_url:
        return {}
    display_name = str(row["display_name"] or row["source_id"]).strip()
    source_type = "search" if _url_has_search_placeholder(seed_url) else "static"
    return {
        "name": display_name,
        "url": seed_url,
        "type": source_type,
        "base_url": seed_url,
    }


def _url_has_search_placeholder(url: str) -> bool:
    return "{query_encoded}" in url or "{query}" in url


def _row_overrides_adapter_config(row: sqlite3.Row, existing: SourceRegistryEntry | None) -> bool:
    if existing is None:
        return True
    return str(row["owner"] or "").strip().lower() != "system"


def _merge_local_source_registry(
    base_registry: list[SourceRegistryEntry],
) -> list[SourceRegistryEntry]:
    rows = _local_source_registry_rows()
    if not rows:
        return base_registry

    merged = {entry.source_id: entry for entry in base_registry}
    ordered_ids = [entry.source_id for entry in base_registry]
    for row in rows:
        source_id = str(row["source_id"] or "").strip()
        if not source_id:
            continue
        canonical_workday_id = _canonical_workday_source_id_for_alias(source_id)
        if canonical_workday_id and canonical_workday_id in merged:
            continue
        existing = merged.get(source_id)
        kind = _enum_value(SourceKind, row["kind"], existing.kind if existing else SourceKind.EMPLOYER_CAREERS_PAGE)
        priority = _enum_value(
            SourcePriority,
            row["priority"],
            existing.priority if existing else SourcePriority.STANDARD,
        )
        state = _enum_value(
            SourceState,
            row["state"],
            existing.state if existing else SourceState.EXPERIMENTAL,
        )
        adapter_config = dict(existing.adapter_config) if existing else {}
        if _row_overrides_adapter_config(row, existing):
            adapter_config.update(_adapter_config_from_row(row))
        display_name = str(row["display_name"] or (existing.display_name if existing else source_id))
        owner = str(row["owner"] or (existing.owner if existing else "user"))
        merged[source_id] = _validated_source(
            SourceRegistryEntry(
                tenant_id=LOCAL_TENANT,
                source_id=source_id,
                kind=kind,
                display_name=display_name,
                owner=owner,
                priority=priority,
                state=state,
                policy=existing.policy if existing else _policy_for_local_source(kind, source_id),
                adapter_config=adapter_config,
                quality=existing.quality if existing else SourceQualityPlaceholder(),
            )
        )
        if source_id not in ordered_ids:
            ordered_ids.append(source_id)
    return [merged[source_id] for source_id in ordered_ids]


def _canonical_workday_source_id_for_alias(source_id: str) -> str | None:
    match = _WORKDAY_HOST_ALIAS_SOURCE_RE.match(source_id)
    if not match:
        return None
    return f"workday:{match.group('employer')}"


def _filter_sources_for_target_region(
    registry: list[SourceRegistryEntry],
    search_cfg: dict | None,
) -> list[SourceRegistryEntry]:
    if not _target_prefers_europe(search_cfg):
        return registry
    return [entry for entry in registry if not _is_america_only_source(entry)]


def _is_america_only_source(entry: SourceRegistryEntry) -> bool:
    source_text = " ".join(
        str(value)
        for value in (
            entry.source_id,
            entry.display_name,
            entry.adapter_config.get("url"),
            entry.adapter_config.get("seed_url"),
            entry.adapter_config.get("base_url"),
        )
        if value
    ).lower()
    return any(marker in source_text for marker in _AMERICA_ONLY_SOURCE_MARKERS)


def load_source_registry(
    *,
    search_cfg: dict | None = None,
    sites_cfg: dict | None = None,
    employers_cfg: dict | None = None,
) -> list[SourceRegistryEntry]:
    """Generate registry entries from packaged YAML and broad-board config."""
    active_search_cfg = search_cfg if search_cfg is not None else load_search_config()
    active_sites_cfg = sites_cfg if sites_cfg is not None else load_sites_config()
    active_employers_cfg = employers_cfg if employers_cfg is not None else load_employers_config()
    registry = [
        *_configured_sources(active_sites_cfg),
        *_smart_extract_sources(active_sites_cfg),
        *_workday_sources(active_employers_cfg),
        *_jobspy_sources(active_search_cfg),
    ]
    return _filter_sources_for_target_region(
        _merge_local_source_registry(registry),
        active_search_cfg,
    )


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
    "apply_timeout": 900,
    "apply_max_budget_usd": 5.00,
    "viewport": "1280x900",
}


def get_gmail_mcp_dir() -> Path:
    """Return the first-party Gmail connector auth directory."""
    return Path(
        os.environ.get(
            "JOBCTRL_GMAIL_DIR",
            os.environ.get("GMAIL_MCP_DIR", APP_DIR / "gmail"),
        )
    ).expanduser()


def get_gmail_mcp_oauth_keys_path() -> Path:
    """Return the expected Google OAuth client file for Gmail setup."""
    return Path(
        os.environ.get("JOBCTRL_GMAIL_OAUTH_CLIENT_PATH")
        or os.environ.get("GMAIL_MCP_OAUTH_KEYS_PATH")
        or get_gmail_mcp_dir() / "oauth-client.json"
    ).expanduser()


def get_gmail_mcp_credentials_path() -> Path:
    """Return the Gmail token file created by the first-party auth flow."""
    return Path(
        os.environ.get("JOBCTRL_GMAIL_TOKEN_PATH")
        or os.environ.get("GMAIL_MCP_CREDENTIALS_PATH")
        or get_gmail_mcp_dir() / "token.json"
    ).expanduser()


def gmail_mcp_auth_status() -> tuple[bool, str]:
    """Report whether Gmail verification and owned email-send scopes are authenticated."""
    load_env()
    credentials_path = get_gmail_mcp_credentials_path()
    oauth_keys_path = get_gmail_mcp_oauth_keys_path()
    if credentials_path.exists():
        try:
            token = json.loads(credentials_path.read_text(encoding="utf-8"))
        except Exception:
            return False, f"invalid Gmail token JSON at {credentials_path}"
        from jobctrl.infrastructure.gmail.auth import GMAIL_SEND_SCOPE

        scopes = {part.strip() for part in str(token.get("scope") or "").split() if part.strip()}
        if GMAIL_SEND_SCOPE not in scopes:
            return (
                False,
                f"Gmail token at {credentials_path} is missing gmail.send scope; run jobctrl gmail-auth",
            )
        return True, f"authenticated with {credentials_path}"
    if not oauth_keys_path.exists():
        return (
            False,
            f"missing OAuth client at {oauth_keys_path}",
        )
    try:
        raw = json.loads(oauth_keys_path.read_text(encoding="utf-8"))
    except Exception:
        return False, f"invalid OAuth client JSON at {oauth_keys_path}"
    web = raw.get("web") if isinstance(raw, dict) else None
    installed = raw.get("installed") if isinstance(raw, dict) else None
    if not installed and web:
        redirects = tuple(str(uri) for uri in web.get("redirect_uris") or ())
        if not any(uri.startswith(("http://localhost:", "http://127.0.0.1:")) for uri in redirects):
            return (
                False,
                "OAuth web client has no local redirect URI; use a Desktop client "
                "or add http://localhost:3000/oauth2callback",
            )
    return (
        False,
        "OAuth client found; run jobctrl gmail-auth",
    )


def get_apply_timeout_seconds() -> int:
    """Return the per-job autonomous apply timeout.

    Real ATS flows can include account creation, resume parsing, and email
    verification, so local operators may need to tune the timeout without a
    code change.
    """
    saved = _config_setting("apply_timeout_seconds")
    try:
        return min(3600, max(60, int(saved)))
    except (TypeError, ValueError):
        return int(DEFAULTS.get("apply_timeout", 900))


def get_apply_max_budget_usd() -> float:
    """Return the per-run Claude apply budget cap in USD."""
    saved = _config_setting("apply_max_budget_usd")
    try:
        return max(0.0, float(saved))
    except (TypeError, ValueError):
        return float(DEFAULTS.get("apply_max_budget_usd", 5.00))


def get_analysis_legs() -> tuple[str, ...]:
    """Return internal analysis leg identifiers from config.json or defaults."""
    saved = _config_setting("analysis_legs")
    raw = ",".join(str(item) for item in saved) if isinstance(saved, list) else ""
    aliases = {
        "claude": "claude",
        "anthropic": "claude",
        "codex": "codex",
        "openai": "codex",
        "google": "antigravity",
        "gemini": "antigravity",
        "antigravity": "antigravity",
    }
    selected = []
    for item in str(raw or "claude,codex,google").replace(";", ",").split(","):
        leg = aliases.get(item.strip().lower())
        if leg and leg not in selected:
            selected.append(leg)
    return tuple(leg for leg in ("claude", "codex", "antigravity") if leg in selected) or (
        "claude",
        "codex",
        "antigravity",
    )


def get_tailoring_generator_models() -> tuple[str, ...]:
    saved = _config_setting("tailoring_generator_models")
    return tuple(str(item).strip() for item in saved if str(item).strip()) if isinstance(saved, list) else ()


def get_tailoring_judge_model() -> str | None:
    saved = _config_setting("tailoring_judge_model")
    return str(saved).strip() or None if saved is not None else None


def get_tailoring_judge_min_score() -> float:
    value = _config_setting("tailoring_judge_min_score")
    try:
        return min(1.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        return 0.82


def get_config_path(*, app_dir: Path | None = None) -> Path:
    """Return the one file that owns persisted, non-secret Settings values."""
    if app_dir is not None:
        return Path(app_dir) / CONFIG_FILENAME
    configured = os.environ.get("JOBCTRL_CONFIG_PATH", "").strip()
    return Path(configured).expanduser() if configured else APP_DIR / CONFIG_FILENAME


def load_config_file(
    *,
    path: Path | str | None = None,
    app_dir: Path | None = None,
    strict: bool = False,
) -> dict[str, object]:
    if path is not None and app_dir is not None:
        raise ValueError("path and app_dir are mutually exclusive")
    resolved_path = Path(path).expanduser() if path is not None else get_config_path(app_dir=app_dir)
    try:
        parsed = json.loads(resolved_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        if strict:
            raise ConfigFileError(f"{resolved_path.name} must contain valid JSON") from exc
        return {}
    if not isinstance(parsed, dict):
        if strict:
            raise ConfigFileError(f"{resolved_path.name} must contain a JSON object")
        return {}
    return parsed


@contextmanager
def config_file_lock(
    *,
    path: Path | str | None = None,
    app_dir: Path | None = None,
) -> Iterator[None]:
    """Serialize config.json transactions across the TypeScript and Python runtimes."""
    if path is not None and app_dir is not None:
        raise ValueError("path and app_dir are mutually exclusive")
    resolved_path = Path(path).expanduser() if path is not None else get_config_path(app_dir=app_dir)
    _ensure_config_parent(resolved_path)
    lock_path = resolved_path.parent / CONFIG_LOCK_DIRECTORY
    deadline = time.monotonic() + CONFIG_LOCK_TIMEOUT_SECONDS

    while True:
        try:
            lock_path.mkdir(mode=0o700)
            break
        except FileExistsError:
            try:
                lock_stat = lock_path.lstat()
            except FileNotFoundError:
                continue
            if not lock_path.is_dir() or lock_path.is_symlink():
                raise ConfigFileError("The settings lock path is not a directory")
            if time.time() - lock_stat.st_mtime > CONFIG_LOCK_STALE_SECONDS:
                try:
                    lock_path.rmdir()
                except FileNotFoundError:
                    continue
                except OSError:
                    # A non-empty or otherwise unremovable lock is still an
                    # active/untrusted lock.  Keep the normal wait/timeout
                    # behavior instead of spinning forever.
                    pass
                else:
                    continue
            if time.monotonic() >= deadline:
                raise ConfigFileError(
                    f"{resolved_path.name} is busy; retry after the current settings update finishes"
                )
            time.sleep(CONFIG_LOCK_RETRY_SECONDS)

    try:
        yield
    finally:
        try:
            lock_path.rmdir()
        except FileNotFoundError:
            pass


@contextmanager
def edit_config_file(
    *,
    path: Path | str | None = None,
    app_dir: Path | None = None,
) -> Iterator[dict[str, object]]:
    """Yield the latest config object and commit its mutation as one transaction."""
    if path is not None and app_dir is not None:
        raise ValueError("path and app_dir are mutually exclusive")
    resolved_path = Path(path).expanduser() if path is not None else get_config_path(app_dir=app_dir)
    with config_file_lock(path=resolved_path):
        config = load_config_file(path=resolved_path, strict=True)
        yield config
        _write_config_file_unlocked(config, resolved_path)


def write_config_file(
    config: Mapping[str, object],
    *,
    path: Path | str | None = None,
    app_dir: Path | None = None,
) -> None:
    """Atomically replace config.json while keeping it private to the user."""
    if path is not None and app_dir is not None:
        raise ValueError("path and app_dir are mutually exclusive")
    resolved_path = Path(path).expanduser() if path is not None else get_config_path(app_dir=app_dir)
    with config_file_lock(path=resolved_path):
        _write_config_file_unlocked(config, resolved_path)


def update_config_file(
    updates: Mapping[str, object],
    *,
    path: Path | str | None = None,
    app_dir: Path | None = None,
) -> dict[str, object]:
    """Merge top-level settings without discarding unrelated concurrent updates."""
    with edit_config_file(path=path, app_dir=app_dir) as config:
        config.update(updates)
    return config


def _write_config_file_unlocked(config: Mapping[str, object], resolved_path: Path) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{resolved_path.name}.",
        dir=resolved_path.parent,
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(dict(config), handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, resolved_path)
        resolved_path.chmod(0o600)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _ensure_config_parent(resolved_path: Path) -> None:
    """Create a private JobCtrl config directory without changing shared parents."""
    parent = resolved_path.parent
    created: list[Path] = []
    candidate = parent
    while not candidate.exists():
        created.append(candidate)
        if candidate.parent == candidate:
            break
        candidate = candidate.parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    for created_parent in created:
        created_parent.chmod(0o700)
    if parent.resolve() == (APP_DIR / CONFIG_FILENAME).parent.resolve():
        parent.chmod(0o700)


def _config_setting(key: str) -> object | None:
    return load_config_file().get(key)


def provider_configuration_environment(
    config: Mapping[str, object] | None = None,
) -> dict[str, str]:
    """Translate canonical provider connection config into SDK environment inputs."""
    root = config if config is not None else load_config_file()
    connections = root.get("provider_connections")
    connections = connections if isinstance(connections, dict) else {}
    claude = connections.get("claude")
    claude = claude if isinstance(claude, dict) else {}
    google = connections.get("google")
    google = google if isinstance(google, dict) else {}
    shared = connections.get("shared")
    shared = shared if isinstance(shared, dict) else {}
    values: dict[str, str] = {}

    claude_mode = str(claude.get("mode") or "").strip()
    mode_key = {
        "vertex": "CLAUDE_CODE_USE_VERTEX",
        "bedrock": "CLAUDE_CODE_USE_BEDROCK",
        "anthropic_aws": "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "foundry": "CLAUDE_CODE_USE_FOUNDRY",
    }.get(claude_mode)
    if mode_key:
        values[mode_key] = "1"
    _copy_provider_config(values, "ANTHROPIC_VERTEX_PROJECT_ID", claude.get("vertex_project_id"))
    _copy_provider_config(values, "CLOUD_ML_REGION", claude.get("vertex_region"))
    _copy_provider_config(values, "ANTHROPIC_AWS_WORKSPACE_ID", claude.get("aws_workspace_id"))
    _copy_provider_config(values, "ANTHROPIC_FOUNDRY_RESOURCE", claude.get("foundry_resource"))
    _copy_provider_config(values, "AWS_PROFILE", claude.get("aws_profile"))
    _copy_provider_config(values, "AWS_REGION", claude.get("aws_region"))

    if str(google.get("mode") or "").strip() == "vertex":
        values["GOOGLE_GENAI_USE_VERTEXAI"] = "true"
    _copy_provider_config(values, "GOOGLE_CLOUD_PROJECT", google.get("project_id"))
    _copy_provider_config(values, "GOOGLE_CLOUD_LOCATION", google.get("location"))
    _copy_provider_config(
        values,
        "GOOGLE_APPLICATION_CREDENTIALS",
        shared.get("google_application_credentials_path"),
    )
    return values


def _copy_provider_config(target: dict[str, str], key: str, value: object) -> None:
    normalized = str(value or "").strip()
    if normalized:
        target[key] = normalized


def load_provider_configuration(
    *,
    env: MutableMapping[str, str] = os.environ,
) -> None:
    """Make config.json the only persisted authority for non-secret provider settings."""
    configured = provider_configuration_environment()
    for key in PROVIDER_CONFIGURATION_KEYS:
        env.pop(key, None)
    env.update(configured)


def load_macos_keychain_fallbacks(
    *,
    env: MutableMapping[str, str] = os.environ,
    system_name: str | None = None,
    find_executable: Callable[[str], str | None] = _find_macos_security_binary,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> tuple[KeychainFallbackDiagnostic, ...]:
    """Fill missing provider settings from the macOS Keychain.

    Environment values always win. Keychain values are copied only into this
    process environment, so a long-lived worker must restart after the web API
    saves or removes an entry. Diagnostics deliberately contain no command
    output or secret value.
    """

    diagnostics: dict[str, KeychainFallbackDiagnostic] = {}
    missing_keys: list[str] = []
    for key in KEYCHAIN_PROVIDER_KEYS:
        if env.get(key):
            diagnostics[key] = KeychainFallbackDiagnostic(key, "explicit", "environment_precedence")
        else:
            missing_keys.append(key)

    if not missing_keys:
        return tuple(diagnostics[key] for key in KEYCHAIN_PROVIDER_KEYS)

    if (system_name or platform.system()) != "Darwin":
        for key in missing_keys:
            diagnostics[key] = KeychainFallbackDiagnostic(key, "unsupported", "non_darwin")
        return tuple(diagnostics[key] for key in KEYCHAIN_PROVIDER_KEYS)

    security = find_executable("security")
    if security != KEYCHAIN_SECURITY_BINARY:
        for key in missing_keys:
            diagnostics[key] = KeychainFallbackDiagnostic(key, "unavailable", "binary_missing")
        return tuple(diagnostics[key] for key in KEYCHAIN_PROVIDER_KEYS)

    for key in missing_keys:
        command = [
            security,
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            _keychain_account(key),
            "-w",
        ]
        try:
            completed = run(
                command,
                check=False,
                capture_output=True,
                text=True,
                stdin=subprocess.DEVNULL,
                timeout=KEYCHAIN_LOOKUP_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            diagnostics[key] = KeychainFallbackDiagnostic(key, "unavailable", "timeout")
            continue
        except OSError:
            diagnostics[key] = KeychainFallbackDiagnostic(key, "unavailable", "binary_missing")
            continue
        except subprocess.SubprocessError:
            diagnostics[key] = KeychainFallbackDiagnostic(key, "unavailable", "command_failed")
            continue

        if completed.returncode != 0:
            missing = _is_confirmed_keychain_miss(completed.returncode, completed.stderr)
            diagnostics[key] = KeychainFallbackDiagnostic(
                key,
                "missing" if missing else "unavailable",
                "item_not_found" if missing else "command_failed",
            )
            continue

        value = completed.stdout.rstrip("\r\n")
        if not value:
            diagnostics[key] = KeychainFallbackDiagnostic(key, "unavailable", "empty_value")
            continue
        env[key] = value
        diagnostics[key] = KeychainFallbackDiagnostic(key, "loaded", "loaded")

    return tuple(diagnostics[key] for key in KEYCHAIN_PROVIDER_KEYS)


def get_env_path() -> Path:
    """Return the state-owned environment file for the active runtime mode."""

    if is_bundled_runtime():
        return owned_env_path(app_dir=APP_DIR)
    return ENV_PATH


def load_env() -> tuple[KeychainFallbackDiagnostic, ...]:
    """Load approved env files, then fill missing provider settings from Keychain.

    A source checkout retains its historical CWD ``.env`` fallback.  The
    installed payload reads exactly one JobCtrl-owned env file and never asks
    python-dotenv to search the current directory or its parents.
    """
    from dotenv import load_dotenv

    global _KEYCHAIN_FALLBACK_DIAGNOSTICS

    env_path = get_env_path()
    if env_path.exists():
        load_dotenv(env_path)
    if not is_bundled_runtime():
        # Source-install compatibility: contributors may keep checkout-local
        # values in CWD .env. This discovery path is forbidden in bundled mode.
        load_dotenv()
    load_provider_configuration()
    if _KEYCHAIN_FALLBACK_DIAGNOSTICS is None or not KEYCHAIN_REQUIRES_WORKER_RESTART:
        _KEYCHAIN_FALLBACK_DIAGNOSTICS = load_macos_keychain_fallbacks()
    return _KEYCHAIN_FALLBACK_DIAGNOSTICS


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
    2: ["score", "tailor", "cover"],
    3: ["apply"],
}


def get_tier() -> int:
    """Detect the current tier based on available dependencies.

    Tier 1 (Discovery):            Python + pip
    Tier 2 (AI Scoring & Tailoring): + LLM provider config
    Tier 3 (Full Auto-Apply):       + Claude apply runtime + explicitly enabled browser capability
    """
    load_env()

    has_llm = _has_core_llm_provider()
    if not has_llm:
        return 1

    has_claude = _has_claude_apply_runtime()
    from jobctrl.browser_capabilities import browser_capability_status

    has_auto_apply_browser = browser_capability_status("auto-apply-browser").status == "ready"

    if has_claude and has_auto_apply_browser:
        return 3

    return 2


def _has_claude_apply_runtime() -> bool:
    """Return whether apply can spawn a Claude runtime.

    A system ``claude`` is still accepted, but the Agent SDK's pinned bundled
    binary is also a valid local runtime.
    """

    try:
        from jobctrl.infrastructure.setup_probes import resolve_claude_apply_binary

        binary = resolve_claude_apply_binary()
    except Exception:  # noqa: BLE001 - tier detection should degrade to missing
        return False
    return shutil.which(binary) is not None or Path(binary).expanduser().exists()


def _has_core_llm_provider() -> bool:
    """Return whether at least one sanctioned provider is ready end to end."""

    try:
        from jobctrl.infrastructure.setup_probes import core_llm_ready

        return core_llm_ready()
    except Exception:  # noqa: BLE001 - tier detection degrades to Tier 1
        return False


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
    if required >= 2 and not _has_core_llm_provider():
        missing.append(
            "LLM provider — authenticate Claude, Codex, or Google; "
            "run [bold]jobctrl setup[/bold] and [bold]jobctrl doctor[/bold] for provider diagnostics"
        )
    if required >= 3:
        if not _has_claude_apply_runtime():
            missing.append("Claude apply runtime — install dependencies or set JOBCTRL_CLAUDE_BIN")
        from jobctrl.browser_capabilities import browser_capability_status

        capability = browser_capability_status("auto-apply-browser")
        if capability.status != "ready":
            missing.append(
                "auto-apply browser capability — explicitly adopt a Chrome/Chromium executable with "
                "[bold]jobctrl capability enable auto-apply-browser --browser-path <path>[/bold]"
            )

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
