"""JobHunter configuration: paths, platform detection, user data."""

import json
import logging
import os
import platform
import re
import shutil
import sqlite3
from pathlib import Path

from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.domain.discovery.source_registry import (
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
from jobhunter.discovery.target_queries import build_target_role_queries
from jobhunter.infrastructure.observability import source_validation_span

log = logging.getLogger(__name__)

# User data directory — all user-specific files live here
APP_DIR = Path(os.environ.get("JOBHUNTER_DIR", Path.home() / ".jobhunter"))

# Core paths
DB_PATH = APP_DIR / "jobhunter.db"
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
    return _apply_profile_target_search(search_cfg)


def _default_discovery_search_config() -> dict:
    return json.loads(json.dumps(DEFAULT_DISCOVERY_SEARCH_CONFIG))


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
        locations = _split_target_text(row["experience_target_locations"])
        return {
            "roles": _split_target_text(row["experience_target_role"]),
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
            log.warning("Discovery settings key 'sites' is deprecated for JobSpy board selection; use 'boards'.")
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
    """Generate typed source registry entries from packaged YAML and JobSpy config."""
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
    "viewport": "1280x900",
}


def get_gmail_mcp_dir() -> Path:
    """Return the first-party Gmail connector auth directory."""
    return Path(
        os.environ.get(
            "JOBHUNTER_GMAIL_DIR",
            os.environ.get("GMAIL_MCP_DIR", APP_DIR / "gmail"),
        )
    ).expanduser()


def get_gmail_mcp_oauth_keys_path() -> Path:
    """Return the expected Google OAuth client file for Gmail setup."""
    return Path(
        os.environ.get("JOBHUNTER_GMAIL_OAUTH_CLIENT_PATH")
        or os.environ.get("GMAIL_MCP_OAUTH_KEYS_PATH")
        or get_gmail_mcp_dir() / "oauth-client.json"
    ).expanduser()


def get_gmail_mcp_credentials_path() -> Path:
    """Return the Gmail token file created by the first-party auth flow."""
    return Path(
        os.environ.get("JOBHUNTER_GMAIL_TOKEN_PATH")
        or os.environ.get("GMAIL_MCP_CREDENTIALS_PATH")
        or get_gmail_mcp_dir() / "token.json"
    ).expanduser()


def gmail_mcp_auth_status() -> tuple[bool, str]:
    """Report whether read-only Gmail verification is locally authenticated."""
    load_env()
    credentials_path = get_gmail_mcp_credentials_path()
    oauth_keys_path = get_gmail_mcp_oauth_keys_path()
    if credentials_path.exists():
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
        "OAuth client found; run jobhunter gmail-auth",
    )


def get_apply_timeout_seconds() -> int:
    """Return the per-job autonomous apply timeout.

    Real ATS flows can include account creation, resume parsing, and email
    verification, so local operators may need to tune the timeout without a
    code change.
    """
    load_env()
    raw = os.environ.get("JOBHUNTER_APPLY_TIMEOUT_SECONDS")
    if raw:
        try:
            parsed = int(raw)
        except ValueError:
            log.warning("Invalid JOBHUNTER_APPLY_TIMEOUT_SECONDS=%r; using default", raw)
        else:
            if parsed > 0:
                return parsed
            log.warning("JOBHUNTER_APPLY_TIMEOUT_SECONDS must be positive; using default")
    return int(DEFAULTS.get("apply_timeout", 900))


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
    2: ["score", "tailor", "cover"],
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
