"""Bounded CSV/vCard parsing. Imports never fetch linked content or merge facts."""

from __future__ import annotations

import csv
import io
import re

from .domain import InvalidContact, ROLES


def issue(code: str, message: str, property: str | None = None, *, warning: bool = False) -> dict:
    return {"code": code, "message": message, "property": property, "severity": "warning" if warning else "error"}


def _item() -> dict:
    return {"displayName": "", "employer": None, "jobId": None, "role": "other", "attributes": [], "issues": []}


def _add(item: dict, kind: str, value: str) -> None:
    value = value.strip()
    if not value:
        return
    if len(value) > 2000:
        item["issues"].append(issue("value_too_long", f"{kind} exceeds 2000 characters.", kind))
    elif {"kind": kind, "value": value} not in item["attributes"]:
        item["attributes"].append({"kind": kind, "value": value})


def parse_csv(content: str) -> list[dict]:
    columns = {"name": "name", "full_name": "name", "title": "title", "role_title": "title", "email": "email",
               "phone": "phone", "profile_url": "profile_url", "profileurl": "profile_url", "linkedin": "profile_url",
               "note": "note", "notes": "note"}
    results = []
    try:
        reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff")), strict=True)
        if not reader.fieldnames:
            return []
        for raw in reader:
            if len(results) >= 1000:
                raise InvalidContact("At most 1000 contacts can be imported at once.")
            item = _item()
            row = {(key or "").strip().casefold(): (value or "").strip() for key, value in raw.items() if isinstance(value, str)}
            item["employer"] = row.get("employer") or row.get("company") or None
            item["jobId"] = row.get("job_id") or row.get("jobid") or None
            supplied_role = row.get("role", "other") or "other"
            if supplied_role not in ROLES:
                item["issues"].append(issue("invalid_role", "The role is unsupported.", "role"))
            else:
                item["role"] = supplied_role
            for column, kind in columns.items():
                if row.get(column):
                    _add(item, kind, row[column])
            if None in raw:
                item["issues"].append(issue("extra_columns", "The row contains more fields than the CSV header."))
            item["displayName"] = next((fact["value"] for fact in item["attributes"] if fact["kind"] == "name"), "")
            results.append(item)
    except csv.Error:
        return [{**_item(), "issues": [issue("malformed_csv", "The CSV text is malformed.")]}]
    return results


def _split_escaped(value: str, separator: str) -> list[str]:
    result, part, escaped = [], "", False
    for character in value:
        if escaped:
            part += "\\" + character
            escaped = False
        elif character == "\\":
            escaped = True
        elif character == separator:
            result.append(part)
            part = ""
        else:
            part += character
    result.append(part + ("\\" if escaped else ""))
    return result


def _unescape(value: str) -> str:
    return re.sub(r"\\([nN,;\\])", lambda match: "\n" if match[1] in "nN" else match[1], value)


def _colon(line: str) -> int:
    quoted = False
    for index, character in enumerate(line):
        if character == '"':
            quoted = not quoted
        elif character == ":" and not quoted:
            return index
    return -1


def parse_vcard(content: str) -> list[dict]:
    lines: list[str] = []
    for line in content.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line.startswith((" ", "\t")) and lines:
            lines[-1] += line[1:]
        else:
            lines.append(line)
    cards, current, outside = [], None, False
    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue
        if line.upper() == "BEGIN:VCARD":
            if current is not None:
                current[1].append(issue("nested_vcard", "A vCard began before the previous card ended."))
                cards.append(current)
            current = ([], [])
        elif line.upper() == "END:VCARD":
            if current is None:
                outside = True
            else:
                cards.append(current)
                current = None
        elif current is None:
            outside = True
        else:
            current[0].append(line)
        if len(cards) > 1000:
            return [{**_item(), "issues": [issue("too_many_vcards", "At most 1000 vCards can be imported at once.")]}]
    if current is not None:
        current[1].append(issue("unterminated_vcard", "The vCard is missing END:VCARD."))
        cards.append(current)
    if outside:
        cards.insert(0, ([], [issue("content_outside_vcard", "Content was found outside a vCard block.")]))
    if not cards:
        cards = [([], [issue("missing_vcard", "No vCard block was found.")])]
    if len(cards) > 1000:
        return [{**_item(), "issues": [issue("too_many_vcards", "At most 1000 vCards can be imported at once.")]}]
    return [_parse_card(lines, errors) for lines, errors in cards]


def _parse_card(lines: list[str], errors: list[dict]) -> dict:
    item = _item()
    item["issues"] = list(errors)
    properties = []
    supported = {"BEGIN", "END", "VERSION", "FN", "N", "ORG", "EMAIL", "TEL", "URL", "NOTE", "TITLE"}
    for line in lines:
        if len(line) > 16384:
            item["issues"].append(issue("line_too_long", "A vCard line exceeds 16384 characters."))
            continue
        split = _colon(line)
        if split <= 0:
            item["issues"].append(issue("malformed_property", "A vCard property requires its name and ':' separator."))
            continue
        parts = line[:split].split(";")
        name = parts.pop(0).strip().rsplit(".", 1)[-1].upper()
        if name not in supported:
            item["issues"].append(issue("unsupported_property", f"{name} is not imported.", name, warning=True))
            continue
        params = {}
        for part in parts:
            key, separator, value = part.partition("=")
            key, value = (key.strip().upper(), value.strip()) if separator else ("TYPE", key.strip())
            params[key] = value
            if key == "ENCODING":
                item["issues"].append(issue("unsupported_encoding", f"{name} uses unsupported encoded content.", name))
            elif key == "CHARSET" and value.upper().replace("-", "").replace("_", "") != "UTF8":
                item["issues"].append(issue("unsupported_charset", f"{name} uses an unsupported charset.", name))
            elif key in {"TYPE", "PREF", "ALTID", "PID", "LANGUAGE"}:
                item["issues"].append(issue("ignored_parameter", f"{name} parameter {key} does not change the fact.", name, warning=True))
            elif key not in {"CHARSET", "VALUE"}:
                item["issues"].append(issue("unsupported_parameter", f"{name} parameter {key} was ignored.", name, warning=True))
        declared = params.get("VALUE", "").strip('"').lower()
        allowed = {"text", "uri"} if name == "TEL" else {"uri"} if name == "URL" else {"text"}
        if declared and declared not in allowed:
            item["issues"].append(issue("unsupported_value_type", f"{name} has an incompatible VALUE type.", name))
        properties.append((name, line[split + 1:], params))
    versions = [value.strip() for name, value, _ in properties if name == "VERSION"]
    if len(versions) != 1 or versions[0] not in {"3.0", "4.0"}:
        item["issues"].append(issue("unsupported_version", "Each card must declare VERSION:3.0 or VERSION:4.0 once.", "VERSION"))
    def first(name):
        return next((value for key, value, _ in properties if key == name), "")

    display_name = _unescape(first("FN")).strip()
    if not display_name:
        pieces = [_unescape(part).strip() for part in _split_escaped(first("N"), ";")]
        pieces += [""] * (5 - len(pieces))
        display_name = " ".join(part for part in [pieces[3], pieces[1], pieces[2], pieces[0], pieces[4]] if part)
    item["displayName"] = display_name
    _add(item, "name", display_name)
    item["employer"] = _unescape(_split_escaped(first("ORG"), ";")[0]).strip() or None
    if not item["employer"]:
        item["issues"].append(issue("missing_employer", "ORG is required to link this contact to an employer.", "ORG"))
    for name, raw, params in properties:
        value = _unescape(raw)
        if name == "EMAIL":
            if re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value.strip()):
                _add(item, "email", value)
            else:
                item["issues"].append(issue("invalid_email", "EMAIL must contain a valid email address.", name))
        elif name == "TEL":
            if raw.lower().startswith("tel:"):
                raw = raw[4:]
            elif params.get("VALUE", "").lower() == "uri":
                item["issues"].append(issue("unsupported_tel_uri", "TEL URI values must use tel:.", name))
                continue
            if ";" in raw or "?" in raw:
                item["issues"].append(issue("unsupported_qualified_tel_uri", "Qualified telephone URIs cannot be imported safely.", name))
            elif re.fullmatch(r"\+?[0-9(). -]+", raw.strip()) and len(re.sub(r"[^0-9]", "", raw)) >= 7:
                _add(item, "phone", raw)
            else:
                item["issues"].append(issue("unsupported_phone_value", "TEL must contain a plain phone number.", name))
        elif name in {"URL", "NOTE", "TITLE"}:
            _add(item, {"URL": "profile_url", "NOTE": "note", "TITLE": "title"}[name], raw if name == "URL" else value)
    if len(item["attributes"]) > 50:
        item["issues"].append(issue("too_many_facts", "A contact can contain at most 50 imported facts."))
        item["attributes"] = item["attributes"][:50]
    return item


def parse_import(payload: dict) -> tuple[str, str, str, list[dict]]:
    if not isinstance(payload, dict):
        raise InvalidContact("The import request must be an object.")
    filename = payload.get("filename")
    if not isinstance(filename, str) or not 1 <= len(filename.strip()) <= 300:
        raise InvalidContact("The import requires a filename of at most 300 characters.")
    legacy = set(payload) == {"filename", "csvText"}
    if not legacy and set(payload) != {"filename", "format", "mode", "content"}:
        raise InvalidContact("The import request contains unsupported fields.")
    format = "csv" if legacy else payload.get("format")
    mode = "commit" if legacy else payload.get("mode")
    content = payload.get("csvText") if legacy else payload.get("content")
    if format not in {"csv", "vcard"} or mode not in {"preview", "commit"}:
        raise InvalidContact("Choose CSV/vCard and preview/commit.")
    if not isinstance(content, str) or not 1 <= len(content) <= 1_000_000:
        raise InvalidContact("Import content must contain 1 to 1000000 characters.")
    return filename.strip(), format, mode, parse_csv(content) if format == "csv" else parse_vcard(content)
