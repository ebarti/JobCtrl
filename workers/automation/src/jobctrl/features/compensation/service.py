"""Compensation application service: accepted evidence, policies and source fences."""

from __future__ import annotations

import asyncio
from contextlib import nullcontext
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re
from uuid import uuid4
from urllib.parse import urlsplit

from jobctrl.app.errors import AppError, ConflictError

from .core.analysis import EvidenceError, annualize, direct_benchmark, estimate_market, extrapolate, extract_posted, posted_from_judgment, validate_classification, validate_source_date
from .core.ports import Observation, Source
from .geography import CompanyMatch, company_identity_source, extrapolate_for_target, validate_company_match
from .policy import PolicyInput, registry
from .ports import CompensationModel, CompensationProvider, CompensationSourceFactory, CompensationStore, OfficialDataAuthority


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _posting_source(snapshot: dict) -> tuple[Source, str]:
    for field in ("salary", "enriched_description", "full_description", "description"):
        value = snapshot.get(field)
        if isinstance(value, str) and value.strip():
            return Source(reference=f"posting:{snapshot['job_id']}:{snapshot['revision']}:{field}", text=value,
                          as_of=snapshot.get("observed_at"), url=snapshot.get("url")), field
    return Source(reference=f"posting:{snapshot['job_id']}:{snapshot['revision']}:missing", text="",
                  as_of=snapshot.get("observed_at"), url=snapshot.get("url")), "missing"


def _target_source(snapshot: dict) -> Source:
    # Canonical source content is supplied to the model, never interpreted by lexical rules.
    value = {key: snapshot.get(key) for key in ("title", "company", "location", "salary", "enriched_description", "full_description", "description")}
    return Source(reference=f"posting:{snapshot['job_id']}:{snapshot['revision']}:classification", text=_json(value),
                  as_of=snapshot.get("observed_at"), url=snapshot.get("url"))


class _RecordedRates:
    """Prefer a still-fresh, source-verified rate before a new external fetch."""
    def __init__(self, rates, fallback, freshness):
        self._rates = list(rates)
        self._fallback = fallback
        self._freshness = freshness
        self._fallback_failed = False
        self._missing = set()
        self.new_sources = {}

    def rate(self, source_currency: str, target_currency: str, as_of: str):
        candidates = [rate for rate in self._rates if rate.from_currency == source_currency
                      and rate.to_currency == target_currency and rate.as_of <= as_of]
        if candidates:
            return max(candidates, key=lambda value: (value.as_of, value.source.reference))
        key = (source_currency, target_currency, as_of)
        if self._fallback_failed or key in self._missing or self._fallback is None:
            return None
        try:
            result = self._fallback.rate(source_currency, target_currency, as_of)
        except Exception:
            # All currency pairs share one daily ECB acquisition. A failed
            # lookup cannot become a second request inside this same refresh.
            self._fallback_failed = True
            raise
        if result:
            observed = _now()
            expiry = (datetime.fromisoformat(observed.replace("Z", "+00:00")) + timedelta(days=7)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            self._freshness.setdefault(result.source.reference, {"observed_at": observed, "fresh_until": expiry})
            self.new_sources[result.source.reference] = result.source
            self._rates.append(result)
        else:
            self._missing.add(key)
        return result


def _warning(code: str) -> dict:
    return {"code": code, "message": code.replace("_", " ").capitalize() + "."}


def _receipt(determination: dict, result: dict, kind: str, entity_id: str) -> dict:
    return {"receipt_id": determination["reference"], "provider": determination["provider"], "model": determination["model"],
            "lane": determination["lane"], "prompt_version": determination["prompt_version"],
            "input_fingerprint": determination["input_fingerprint"], "created_at": determination["decided_at"],
            "source_reference": determination["source_reference"], "source_hash": determination["source_hash"],
            "kind": kind, "entity_id": entity_id, "result": result}


def _validate_observation_source(row: dict) -> None:
    source = row["source"]
    if source["reference"].rsplit(":", 1)[-1] != hashlib.sha256(source["text"].encode()).hexdigest():
        raise EvidenceError("provider_source_hash_mismatch")
    payload = json.loads(source["text"])
    if (not isinstance(payload, dict) or source.get("attribution") != row["attribution"]
            or not source["reference"].startswith(row["provider"] + ":")):
        raise EvidenceError("provider_source_binding_invalid")
    identity = row.get("company_reference")
    if identity is not None:
        if payload.get("company_reference") != identity or row["provider"] != "levels_fyi":
            raise EvidenceError("company_identity_source_invalid")
        parts = urlsplit(source.get("url") or "")
        match = re.fullmatch(r"/companies/([a-zA-Z0-9_-]+)/salaries(?:/.*)?", parts.path)
        if parts.scheme != "https" or parts.hostname != "www.levels.fyi" or match is None or identity != "levels_fyi:company:" + match.group(1):
            raise EvidenceError("company_identity_source_invalid")
    elif payload.get("company_reference") is not None:
        raise EvidenceError("company_identity_source_invalid")
    if row["provider"] == "euro_top_tech":
        raw = payload.get("preTaxTC")
        if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
            raise EvidenceError("provider_source_binding_invalid")
        try:
            value = Decimal(str(raw))
            if not value.is_finite() or value != value.to_integral_value():
                raise ValueError
            amount = int(value)
        except (ValueError, InvalidOperation, OverflowError):
            raise EvidenceError("provider_source_binding_invalid") from None
        if (row["currency"] != "EUR" or row["period"] != "year" or row["component"] != "total_compensation"
                or row["minimum"] != amount or row["maximum"] != amount
                or (str(payload.get("company") or "").strip() or None) != row["company"]
                or str(payload.get("jobTitle") or "").strip() != row["role"]):
            raise EvidenceError("provider_source_binding_invalid")
        return
    company = payload.get("company_name", payload.get("company"))
    role = payload.get("role_title", payload.get("role"))
    level = payload.get("level_label", payload.get("level"))
    if (company != row["company"] or role != row["role"] or payload.get("location") != row["location"]
            or level != row["level"] or payload.get("sample_count") != row["sample_count"]
            or payload.get("release_year") != row["release_year"]):
        raise EvidenceError("provider_source_binding_invalid")
    if (payload.get("currency") != row["currency"] or payload.get("component") != row["component"]
            or payload.get("period") not in {"year", "month", "week", "day", "hour"}):
        raise EvidenceError("provider_source_binding_invalid")
    lower, upper = payload.get("minimum"), payload.get("maximum")
    if payload["period"] != row["period"]:
        if row["period"] != "year":
            raise EvidenceError("provider_source_binding_invalid")
        lower = annualize(lower, payload["period"]) if lower is not None else None
        upper = annualize(upper, payload["period"]) if upper is not None else None
    if lower != row["minimum"] or upper != row["maximum"]:
        raise EvidenceError("provider_source_binding_invalid")


def _posted_response(job_id: str, stored: dict) -> dict:
    result = stored["fact"]["judgment"]
    source = stored["fact"]["source"]
    citations = result["determination"]["citations"]
    excerpt = "\n".join(c["quote"] for c in citations) or source["text"]
    confidence = result["confidence"]
    if result["parse_state"] == "missing":
        excerpt, confidence = None, "none"
    elif result["parse_state"] == "unparseable":
        confidence = "low"
    elif result["parse_state"] == "ambiguous" and confidence not in ("low", "medium"):
        confidence = "low"
    elif result["parse_state"] == "parsed_range" and confidence not in ("low", "medium", "high"):
        confidence = "low"
    fact = {"tenantId": "local", "jobKey": job_id, "sourceField": stored["sourceField"],
            "sourceText": excerpt[:280] if excerpt is not None else None,
            "legacyRawSalary": source["text"][:280] or None, "parseState": result["parse_state"],
            "parserVersion": "posted-compensation-v5-determination", "sourceHash": result["determination"]["source_hash"],
            "parsedAt": stored["updatedAt"], "confidence": confidence,
            "warnings": [_warning(c) for c in dict.fromkeys([*result["warnings"], *(["source_text_truncated"] if excerpt and len(excerpt) > 280 else [])])]}
    if result["parse_state"] == "parsed_range":
        fact.update(currency=result["currency"], period=result["period"], component=result["component"],
                    minimumAmount=result["minimum"], maximumAmount=result["maximum"],
                    annualizedMinimumAmount=stored["fact"]["annual_minimum"],
                    annualizedMaximumAmount=stored["fact"]["annual_maximum"],
                    annualizationAssumption=stored["fact"]["annualization_assumption"])
    return {"ok": True, "recordStatus": "recorded", "fact": fact,
            "sourceCurrent": stored.get("sourceCurrent", True), "sourceRevision": stored.get("sourceRevision"),
            "determination": _receipt(result["determination"], result, "posted_compensation", job_id)}


def _direct_input(item: dict, role: str, weight: float | None, updated_at: str, fresh_until: str) -> dict:
    row, rate = item["observation"], item["exchange_rate"]
    source = row["source"]
    return {"factId": item["reference"], "inputRole": role, "weight": weight,
            "geography": {"countryCode": row["classification"]["countries"][0], "subdivisionCode": None,
                          "locality": row["classification"]["locality"], "scope": row["classification"]["geography_scope"]},
            "marketScope": row["classification"]["market_scope"],
            "normalizedCompany": row["company"] if row["classification"]["market_scope"] == "company" else None,
            "minimumAmountEur": item["annual_minimum_eur"], "maximumAmountEur": item["annual_maximum_eur"],
            "confidenceScore": None, "sampleCount": row["sample_count"], "sourceId": row["provider"],
            "sourceProvenance": row["provenance"], "sourceSnapshotId": source["reference"],
            "sourceUrl": source["url"], "attribution": row["attribution"],
            "asOfDate": source["as_of"], "fetchedAt": updated_at, "freshUntil": fresh_until, "refreshDueAt": fresh_until,
            "originalCurrency": row["original_currency"] or row["currency"],
            "originalPeriod": row["original_period"] or row["period"],
            "originalMinimum": row["original_minimum"] if row["original_minimum"] is not None else row["minimum"],
            "originalMaximum": row["original_maximum"] if row["original_maximum"] is not None else row["maximum"],
            "rate": rate, "providerConversionRate": row["conversion_rate"],
            "providerConversionReference": row["conversion_reference"],
            "classificationReceiptId": row["classification"]["determination"]["reference"]}


def _market_response(job_id: str, stored: dict) -> dict:
    estimate, target = stored["estimate"], stored["target"]
    evidence, sources, determinations = [], [], [_receipt(target["determination"], target, "job_interpretation", job_id)]
    geography = stored.get("geography") or {}
    display_rows = list(estimate["sources"])
    if geography.get("status") == "estimated":
        display_rows.append(geography["anchor"]["observation"])
        for match in geography["company_matches"]:
            display_rows.extend((match["source"]["observation"], match["target"]["observation"]))
    display_rows = list({_json(row): row for row in display_rows}.values())
    for row in display_rows:
        cls, source = row["classification"], row["source"]
        determinations.append(_receipt(cls["determination"], cls, "benchmark_classification", source["reference"]))
        low = row["minimum"]
        high = row["maximum"]
        evidence.append({"determinationId": cls["determination"]["reference"], "sourceId": row["provider"],
                         "displayName": row["provider"], "sourceUrl": source["url"], "companyName": row["company"] or "",
                         "roleTitle": row["role"], "location": row["location"], "levelLabel": row["level"],
                         "companyTier": cls["company_tier"], "component": row["component"], "currency": row["currency"],
                         "period": row["period"], "minimumAmount": low, "maximumAmount": high,
                         "sampleCount": row["sample_count"], "releaseYear": row["release_year"],
                         "companyScore": None, "roleScore": None, "levelScore": None, "locationScore": None, "freshnessScore": None,
                         "sourceReference": source["reference"], "sourceDate": source["as_of"],
                         "originalPeriod": row.get("original_period"), "originalCurrency": row.get("original_currency"),
                         "originalMinimum": row.get("original_minimum"), "originalMaximum": row.get("original_maximum"),
                         "conversionRate": row.get("conversion_rate"), "conversionReference": row.get("conversion_reference")})
        sources.append({"sourceId": row["provider"], "provenance": row["provenance"], "displayName": row["provider"],
                        "sourceType": "reported_compensation", "releaseYear": row["release_year"],
                        "snapshotVersion": source["reference"], "geographyScope": "reported", "aggregateBucket": "reported",
                        "attribution": row["attribution"], "sampleCount": row["sample_count"]})
    benchmark_rows = stored.get("directBenchmarks", [])
    lineage = None
    if benchmark_rows:
        input_windows = stored.get("inputFreshness", {})
        expiries = [input_windows[item["observation"]["source"]["reference"]]["fresh_until"] for item in benchmark_rows]
        expiries.extend(input_windows[item["exchange_rate"]["source"]["reference"]]["fresh_until"] for item in benchmark_rows if item["exchange_rate"])
        fresh_until = min(expiries)
        inputs = [_direct_input(item, "anchor", None,
                                input_windows[item["observation"]["source"]["reference"]]["observed_at"],
                                input_windows[item["observation"]["source"]["reference"]]["fresh_until"])
                  for item in benchmark_rows]
        for item, projected in zip(benchmark_rows, inputs, strict=True):
            if item["exchange_rate"]:
                projected["rateFreshness"] = input_windows[item["exchange_rate"]["source"]["reference"]]
        refs = sorted(item["reference"] for item in benchmark_rows)
        common_dates = [item["observation"]["source"]["as_of"] for item in benchmark_rows]
        observations = [input_windows[item["observation"]["source"]["reference"]]["observed_at"] for item in benchmark_rows]
        observations.extend(input_windows[item["exchange_rate"]["source"]["reference"]]["observed_at"]
                            for item in benchmark_rows if item["exchange_rate"])
        lineage = {"kind": "direct", "factId": "direct-set:" + hashlib.sha256(_json(refs).encode()).hexdigest(),
                   "taxonomyVersion": "1", "roleFamilyCode": target["occupation"], "seniorityLabel": target["seniority"],
                   "targetGeography": {"countryCode": target["countries"][0], "subdivisionCode": None, "locality": target["locality"], "scope": target["geography_scope"]},
                   "component": estimate["component"], "asOfDate": min(common_dates) if all(common_dates) else None,
                   "observedAt": min(observations),
                   "freshUntil": fresh_until, "refreshDueAt": fresh_until, "directInputs": inputs, "priceLevelInputs": []}
    elif geography.get("status") == "estimated":
        adjusted = geography["extrapolation"]
        fresh_until = geography["fresh_until"]
        anchor = geography["anchor"]
        anchor_window = geography["input_freshness"][anchor["observation"]["source"]["reference"]]
        inputs = [_direct_input(anchor, "anchor", 1.0, anchor_window["observed_at"], anchor_window["fresh_until"])]
        if anchor["exchange_rate"]:
            inputs[0]["rateFreshness"] = geography["input_freshness"][anchor["exchange_rate"]["source"]["reference"]]
        pairs, matches = geography["company_pairs"], geography["company_matches"]
        total_weight = sum(pair["quality_weight"] for pair in pairs)
        for pair, match in zip(pairs, matches, strict=True):
            weight = adjusted["shrinkage_weight"] * pair["quality_weight"] / total_weight if total_weight else 0
            for side, role in (("source", "matched_company_source"), ("target", "matched_company_target")):
                fact = match[side]
                window = geography["input_freshness"][fact["observation"]["source"]["reference"]]
                item = _direct_input(fact, role, weight, window["observed_at"], window["fresh_until"])
                if fact["exchange_rate"]:
                    item["rateFreshness"] = geography["input_freshness"][fact["exchange_rate"]["source"]["reference"]]
                item["companyIdentityReceiptId"] = match["decision"]["determination"]["reference"]
                inputs.append(item)
            decision = match["decision"]
            determinations.append(_receipt(decision["determination"], decision, "company_identity", decision["source"]["reference"]))
        price_inputs = []
        for price, role in ((geography["source_price"], "source_price_level"), (geography["target_price"], "target_price_level")):
            source = price["source"]
            window = geography["price_freshness"][source["reference"]]
            price_inputs.append({"factId": source["reference"] + ":" + price["country"], "inputRole": role,
                                 "weight": 1 - adjusted["shrinkage_weight"], "countryCode": price["country"],
                                 "category": price["category"], "referenceYear": price["year"],
                                 "baseGeographyCode": price["base_geography"], "indexValue": price["index"],
                                 "sourceId": "eurostat", "sourceSnapshotId": source["reference"],
                                 "sourceUrl": source["url"], "attribution": source["attribution"],
                                 "asOfDate": source["as_of"], "fetchedAt": window["observed_at"],
                                 "freshUntil": window["fresh_until"], "refreshDueAt": window["fresh_until"]})
        fingerprint = hashlib.sha256(_json({"anchor": anchor, "adjustment": adjusted}).encode()).hexdigest()
        lineage = {"kind": "extrapolated", "factId": "extrapolated:" + fingerprint,
                   "taxonomyVersion": "1", "roleFamilyCode": target["occupation"], "seniorityLabel": target["seniority"],
                   "targetGeography": {"countryCode": geography["target_country"], "subdivisionCode": None, "locality": None, "scope": "country"},
                   "component": estimate["component"], "asOfDate": anchor["observation"]["source"]["as_of"],
                   "observedAt": geography["observed_at"], "freshUntil": fresh_until, "refreshDueAt": fresh_until,
                   "directInputs": inputs, "priceLevelInputs": price_inputs,
                   "anchorDirectFactId": anchor["reference"], "anchorGeography": inputs[0]["geography"],
                   "extrapolationMethod": "evidence_weighted_shrinkage", "rawFactor": adjusted["raw_factor"],
                   "shrinkageWeight": adjusted["shrinkage_weight"], "lowerFactorBound": .1, "upperFactorBound": 10.0,
                   "factorBoundState": adjusted["factor_bound_state"], "matchedCompanyCount": adjusted["matched_company_count"],
                   "formulaVersion": adjusted["formula_version"]}
    samples = [r["sample_count"] for r in display_rows if r["sample_count"] is not None]
    if len(samples) != len(display_rows):
        samples = []
    value = {"determinations": determinations, "tenantId": "local", "jobKey": job_id,
             "estimateState": estimate["state"], "confidenceBand": geography["extrapolation"]["confidence_band"] if geography.get("status") == "estimated" else "none",
             "confidenceScore": geography["extrapolation"]["confidence_score"] if geography.get("status") == "estimated" else None,
             "sourceCount": len({r["provider"] for r in display_rows}),
             "sampleCount": sum(samples) if samples else None, "aggregateBucket": "reported" if sources else None,
             "geographyScope": "reported" if sources else None, "occupationCode": target["occupation"],
             "occupationLabel": target["occupation"], "seniorityLabel": target["seniority"],
             "companyName": stored["company"], "normalizedCompany": None, "roleTitle": stored["title"],
             "normalizedRole": target["occupation"], "companyTier": "unknown", "matchScope": estimate["match_scope"],
             "sources": sources, "factors": [], "evidence": evidence, "warnings": [_warning(w) for w in estimate["warnings"]],
             "benchmarkLineage": lineage,
             "geographyStatus": {"status": geography.get("status"), "reason": geography.get("reason"),
                                 "warnings": geography.get("warnings", [])} if geography else None,
             "benchmarkRejections": stored.get("benchmarkRejections", []),
             "benchmarkRejectionsOmitted": stored.get("benchmarkRejectionsOmitted", 0), "estimatorVersion": "company-role-reported-compensation-v5-determinations",
             "estimatedAt": stored["updatedAt"]}
    if estimate["state"] == "estimated_range":
        value.update(currency=estimate["currency"], period=estimate["period"], component=estimate["component"],
                     minimumAmount=estimate["minimum"], maximumAmount=estimate["maximum"],
                     confidenceInterval=None)
    else:
        value["insufficientReasons"] = [_warning(code) for code in estimate["reasons"]]
    return {"ok": True, "recordStatus": "recorded", "estimate": value,
            "sourceCurrent": stored.get("sourceCurrent", True), "sourceRevision": stored.get("sourceRevision"),
            "evidenceFresh": stored.get("evidenceFresh", True), "evidenceFreshUntil": stored.get("evidenceFreshUntil")}


class CompensationService:
    def __init__(self, repository: CompensationStore, model: CompensationModel, source_verifier: OfficialDataAuthority, *,
                 providers: tuple[tuple[str, CompensationProvider], ...] = (),
                 source_factory: CompensationSourceFactory | None = None):
        self.repository, self.model, self.source_verifier = repository, model, source_verifier
        self.providers = tuple(providers)
        self.source_factory = source_factory

    def preferences(self, connection=None) -> dict:
        with self.repository.read(connection) as unit:
            return unit.policy_snapshot()[0]

    def sources(self) -> dict:
        with self.repository.read() as unit:
            preferences, revision = unit.policy_snapshot()
            return {**registry(preferences), "revision": revision}

    def update_policy(self, payload: dict) -> dict:
        input_ = PolicyInput.model_validate(payload)
        value = input_.model_dump(exclude_none=True, exclude={"expectedRevision"})
        with self.repository.write() as unit:
            revision = unit.set_policy(input_.sourceId, value, input_.expectedRevision)
            unit.append_event("CompensationSourcePolicyChanged", {"sourceId": input_.sourceId}, input_.sourceId)
            return {**registry(unit.policy_snapshot()[0]), "revision": revision}

    def assert_job_exists(self, job_id: str) -> None:
        with self.repository.read() as unit:
            unit.posting(job_id)

    def automatic_enabled(self) -> bool:
        with self.repository.read() as unit:
            return unit.automatic_enabled()

    def needs_refresh(self, snapshot: dict) -> bool:
        with self.repository.read() as unit:
            record = unit.record("market", snapshot["job_id"])
            state = unit.refresh_state(snapshot["job_id"])
        now = datetime.now(timezone.utc)
        if state and state["status"] == "running" and state["lease_expires_at"] and state["lease_expires_at"] > _now():
            return False
        if state and state["status"] == "failed" and state["failure_code"] == "compensation_source_unavailable":
            try:
                failed_at = datetime.fromisoformat(state["updated_at"].replace("Z", "+00:00"))
            except (ValueError, TypeError):
                failed_at = datetime.min.replace(tzinfo=timezone.utc)
            if now - failed_at < timedelta(days=1):
                return False
        if record and record["posting_revision"] == snapshot["revision"] and record["posting_hash"] == snapshot["source_hash"]:
            try:
                updated = datetime.fromisoformat(record["record"]["updatedAt"].replace("Z", "+00:00"))
            except (ValueError, TypeError, KeyError):
                updated = datetime.min.replace(tzinfo=timezone.utc)
            fresh_until = record["record"].get("evidenceFreshUntil")
            if fresh_until:
                try:
                    return now >= datetime.fromisoformat(fresh_until.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    return True
            return now - updated >= timedelta(days=7)
        return True

    def _verified_benchmark(self, item: dict, unit, valuation_date: str):
        """Rebuild a reusable fact from its saved source, receipt and dated rate."""
        row = item["observation"]
        _validate_observation_source(row)
        source = Source(**row["source"])
        validate_source_date(source, valuation_date)
        result = unit.verified_model_result(source, row["classification"]["determination"]["reference"], "classification")
        classification = self.model.rebuild_classification(source, result)
        validate_classification(source, classification)
        if _json(asdict(classification)) != _json(row["classification"]):
            raise EvidenceError("provider_determination_binding_invalid")
        values = {key: value for key, value in row.items() if key not in {"source", "classification"}}
        observation = Observation(source=source, classification=classification, **values)
        rate = self.source_verifier.verify_rate(item["exchange_rate"]) if item["exchange_rate"] is not None else None
        fact = direct_benchmark(observation, rate=rate)
        if _json(asdict(fact)) != _json(item):
            raise EvidenceError("direct_benchmark_binding_invalid")
        return fact

    @staticmethod
    def _source_permitted(row, preferences: dict, options: dict) -> bool:
        if row.provider == "euro_top_tech":
            return options.get("includeEuroTopTech", True) is not False
        if row.provider == "levels_fyi":
            policy = preferences.get("levels_fyi", {})
            mode = policy.get("accessMode")
            return policy.get("enabled") is True and ((row.provenance == "public" and mode == "public_markdown")
                or (row.provenance == "licensed" and mode in {"licensed_api", "licensed_data_feed", "enterprise_mcp"}
                    and policy.get("europeCoverageConfirmed") is True))
        if row.provider == "glassdoor":
            policy = preferences.get("glassdoor", {})
            return policy.get("enabled") is True and policy.get("accessMode") in {"partner_api", "written_permission"}
        return row.provider == "manual_reported_compensation" and row.provenance == "manual"

    def _verify_record(self, kind: str, stored: dict, unit):
        if kind == "posted":
            fact = stored["fact"]
            source = Source(**fact["source"])
            saved = fact["judgment"]
            result = unit.verified_model_result(source, saved["determination"]["reference"], "posted")
            rebuilt = posted_from_judgment(source, self.model.rebuild_posted(source, result))
            if _json(asdict(rebuilt)) != _json(fact):
                raise EvidenceError("posted_determination_binding_invalid")
            return rebuilt
        target_source = Source(**stored["targetSource"])
        target = stored["target"]
        target_result = unit.verified_model_result(target_source, target["determination"]["reference"], "classification")
        target_rebuilt = self.model.rebuild_classification(target_source, target_result)
        validate_classification(target_source, target_rebuilt)
        if _json(asdict(target_rebuilt)) != _json(target):
            raise EvidenceError("target_determination_binding_invalid")
        observations = []
        by_source = {}
        for row in stored["allEvidence"]:
            _validate_observation_source(row)
            source = Source(**row["source"])
            validate_source_date(source, stored["updatedAt"][:10])
            result = unit.verified_model_result(source, row["classification"]["determination"]["reference"], "classification")
            rebuilt = self.model.rebuild_classification(source, result)
            validate_classification(source, rebuilt)
            if _json(asdict(rebuilt)) != _json(row["classification"]):
                raise EvidenceError("provider_determination_binding_invalid")
            values = {key: value for key, value in row.items() if key not in {"source", "classification"}}
            observation = Observation(source=source, classification=rebuilt, **values)
            observations.append(observation)
            by_source[_json(row)] = observation
        estimate = stored["estimate"]
        posted_row = unit.record("posted", stored["jobId"])
        if posted_row is None:
            raise EvidenceError("posted_compensation_unavailable")
        posted = self._verify_record("posted", posted_row["record"], unit)
        expected = estimate_market(target_source, target_rebuilt, observations, component=estimate["component"], posted=posted)
        geography = stored.get("geography") or {}
        geographic = geography.get("status") == "estimated"
        expected_warnings = list(expected.warnings)
        if geographic:
            expected_warnings.extend(("benchmark_extrapolated", *geography["warnings"],
                                      *(["factor_out_of_bounds"] if geography["extrapolation"]["factor_bound_state"] != "within_bounds" else [])))
        if (_json([asdict(row) for row in expected.sources]) != _json(estimate["sources"])
                or expected.match_scope != estimate["match_scope"]
                or _json(tuple(dict.fromkeys(expected_warnings))) != _json(estimate["warnings"])):
            raise EvidenceError("market_source_binding_invalid")

        def verify_window(window):
            if not isinstance(window, dict):
                raise EvidenceError("missing_input_freshness")
            try:
                observed = datetime.fromisoformat(window["observed_at"].replace("Z", "+00:00"))
                expiry = datetime.fromisoformat(window["fresh_until"].replace("Z", "+00:00"))
                accepted = datetime.fromisoformat(stored["updatedAt"].replace("Z", "+00:00"))
                if any(value.tzinfo is None or value.utcoffset() is None for value in (observed, expiry, accepted)):
                    raise ValueError
                if observed > accepted or expiry <= accepted or expiry < observed or expiry - observed > timedelta(days=7):
                    raise ValueError
            except (KeyError, TypeError, ValueError, OverflowError):
                raise EvidenceError("invalid_input_freshness") from None
            return window

        def verify_direct(item):
            observation = by_source.get(_json(item["observation"]))
            if observation is None:
                raise EvidenceError("direct_benchmark_source_invalid")
            window = verify_window(stored.get("inputFreshness", {}).get(observation.source.reference))
            acquisition = unit.benchmark_acquisition(item["reference"], window["observed_at"])
            if not acquisition or acquisition["fresh_until"] != window["fresh_until"] or _json(acquisition["fact"]) != _json(item):
                raise EvidenceError("direct_acquisition_binding_invalid")
            rate_data = item["exchange_rate"]
            rate = None
            if rate_data is not None:
                rate_window = verify_window(stored.get("inputFreshness", {}).get(rate_data["source"]["reference"]))
                rate_acquisition = unit.rate_acquisition(rate_data["source"]["reference"], rate_window["observed_at"])
                if not rate_acquisition or rate_acquisition["fresh_until"] != rate_window["fresh_until"] or _json(rate_acquisition["source"]) != _json(rate_data["source"]):
                    raise EvidenceError("exchange_rate_acquisition_invalid")
                rate = self.source_verifier.verify_rate(rate_data)
            fact = direct_benchmark(observation, rate=rate)
            if _json(asdict(fact)) != _json(item):
                raise EvidenceError("direct_benchmark_binding_invalid")
            return fact

        direct = stored.get("directBenchmarks", [])
        if direct:
            if geographic or (estimate["state"] != "estimated_range" or estimate["currency"] != "EUR" or estimate["period"] != "year"
                    or estimate["minimum"] != min(item["annual_minimum_eur"] for item in direct)
                    or estimate["maximum"] != max(item["annual_maximum_eur"] for item in direct)):
                raise EvidenceError("direct_benchmark_binding_invalid")
            seen, direct_scopes = set(), set()
            for item in direct:
                if _json(item["observation"]) not in {_json(row) for row in estimate["sources"]}:
                    raise EvidenceError("direct_benchmark_source_invalid")
                fact = verify_direct(item)
                cls = fact.observation.classification
                if (item["reference"] in seen or cls.market_scope not in {"market", "company"} or cls.countries != target_rebuilt.countries
                        or cls.geography_scope != target_rebuilt.geography_scope or cls.locality != target_rebuilt.locality):
                    raise EvidenceError("direct_benchmark_source_invalid")
                seen.add(item["reference"])
                direct_scopes.add(cls.market_scope)
            if len(direct_scopes) != 1:
                raise EvidenceError("direct_benchmark_source_invalid")
            direct_sources = {_json(item["observation"]) for item in direct}
            for row in expected.sources:
                if row.classification.market_scope != "market" or _json(asdict(row)) in direct_sources:
                    continue
                try:
                    direct_benchmark(row)
                except EvidenceError:
                    continue  # Missing inputs or FX are reported as rejected.
                raise EvidenceError("direct_benchmark_source_omitted")
            windows = [verify_window(stored.get("inputFreshness", {}).get(row["source"]["reference"]))
                       for row in estimate["sources"]]
            windows.extend(verify_window(stored.get("inputFreshness", {}).get(item["exchange_rate"]["source"]["reference"]))
                           for item in direct if item["exchange_rate"])
            if stored.get("evidenceFreshUntil") != min(value["fresh_until"] for value in windows):
                raise EvidenceError("direct_freshness_binding_invalid")
        elif geographic:
            if target_rebuilt.geography_scope != "country" or target_rebuilt.countries != (geography["target_country"],):
                raise EvidenceError("geographic_target_binding_invalid")
            anchor = verify_direct(geography["anchor"])
            cls = anchor.observation.classification
            if (cls.geography_scope != "country" or cls.market_scope != "market"
                    or cls.countries != (geography["source_country"],) or cls.countries == target_rebuilt.countries
                    or cls.occupation != target_rebuilt.occupation or cls.seniority != target_rebuilt.seniority
                    or anchor.observation.component != estimate["component"]):
                raise EvidenceError("geographic_anchor_binding_invalid")
            source_data, target_data = geography["source_price"], geography["target_price"]
            price_ref = source_data["source"]["reference"]
            price_window = verify_window(stored.get("priceFreshness", {}).get(price_ref))
            price_acquisition = unit.price_acquisition(price_ref, price_window["observed_at"])
            if (not price_acquisition or price_acquisition["fresh_until"] != price_window["fresh_until"]
                    or price_acquisition["reference_year"] != source_data["year"]
                    or _json(price_acquisition["source"]) != _json(source_data["source"])):
                raise EvidenceError("price_acquisition_binding_invalid")
            if source_data["source"] != target_data["source"] or source_data["year"] != target_data["year"]:
                raise EvidenceError("price_level_binding_invalid")
            if any(row.classification and row.classification.market_scope == "market"
                   and row.classification.geography_scope == "country" and row.classification.countries == target_rebuilt.countries
                   and row.classification.occupation == target_rebuilt.occupation
                   and row.classification.seniority == target_rebuilt.seniority and row.component == estimate["component"]
                   and row.minimum is not None and row.maximum is not None and 0 < row.minimum <= row.maximum
                   and row.sample_count is not None and row.sample_count > 0
                   for row in observations):
                raise EvidenceError("geographic_direct_precedence_invalid")
            source_price, target_price = self.source_verifier.verify_prices(source_data, target_data,
                                                                             geography["source_country"], geography["target_country"])
            company_pairs = []
            identities = set()
            for match in geography["company_matches"]:
                source_fact, target_fact = verify_direct(match["source"]), verify_direct(match["target"])
                identity_source = company_identity_source(source_fact.observation, target_fact.observation)
                saved = match["decision"]
                receipt = unit.verified_model_result(identity_source, saved["determination"]["reference"], "company_identity")
                decision = self.model.rebuild_company_identity(identity_source, receipt)
                if _json(asdict(decision)) != _json(saved):
                    raise EvidenceError("company_identity_binding_invalid")
                pair = validate_company_match(CompanyMatch(source_fact, target_fact, decision), geography["source_country"],
                                              geography["target_country"], target_rebuilt.occupation,
                                              target_rebuilt.seniority, estimate["component"])
                if pair is None or pair.company_reference in identities:
                    raise EvidenceError("company_identity_binding_invalid")
                identities.add(pair.company_reference)
                company_pairs.append(pair)
            if _json([asdict(pair) for pair in company_pairs]) != _json(geography["company_pairs"]):
                raise EvidenceError("company_pair_binding_invalid")
            adjusted = extrapolate(anchor.annual_minimum_eur, anchor.annual_maximum_eur, source_price, target_price, company_pairs)
            selected_refs = {anchor.observation.source.reference}
            if anchor.exchange_rate:
                selected_refs.add(anchor.exchange_rate.source.reference)
            for match in geography["company_matches"]:
                for side in ("source", "target"):
                    selected_refs.add(match[side]["observation"]["source"]["reference"])
                    if match[side]["exchange_rate"]:
                        selected_refs.add(match[side]["exchange_rate"]["source"]["reference"])
            actual_windows = {ref: verify_window(stored.get("inputFreshness", {}).get(ref)) for ref in selected_refs}
            if (_json(actual_windows) != _json(geography["input_freshness"])
                    or _json({price_ref: price_window}) != _json(geography["price_freshness"])):
                raise EvidenceError("geographic_freshness_binding_invalid")
            windows = [*actual_windows.values(), price_window]
            if (geography["observed_at"] != min(value["observed_at"] for value in windows)
                    or geography["fresh_until"] != min(value["fresh_until"] for value in windows)
                    or stored.get("evidenceFreshUntil") != geography["fresh_until"]):
                raise EvidenceError("geographic_freshness_binding_invalid")
            if (_json(asdict(adjusted)) != _json(geography["extrapolation"]) or estimate["state"] != "estimated_range"
                    or estimate["currency"] != "EUR" or estimate["period"] != "year"
                    or estimate["minimum"] != adjusted.minimum or estimate["maximum"] != adjusted.maximum):
                raise EvidenceError("geographic_benchmark_binding_invalid")
        elif (any(getattr(expected, key) != estimate[key] for key in ("state", "currency", "period", "component", "minimum", "maximum"))
              or _json(expected.reasons) != _json(estimate["reasons"])):
            raise EvidenceError("market_estimate_binding_invalid")

    def _read(self, kind: str, job_id: str, connection=None, *, include_deleted=False, unit=None) -> dict | None:
        with nullcontext(unit) if unit is not None else self.repository.read(connection) as current:
            snapshot = current.posting(job_id, include_deleted=include_deleted)
            row = current.record(kind, job_id)
            if not row:
                return None
            try:
                stored = row["record"]
                self._verify_record(kind, stored, current)
            except Exception:
                return {"recordUnavailable": True}
            stored["sourceCurrent"] = row["posting_revision"] == snapshot["revision"] and row["posting_hash"] == snapshot["source_hash"]
            stored["sourceRevision"] = row["posting_revision"]
            if kind == "market":
                stored["evidenceFresh"] = bool(stored.get("evidenceFreshUntil") and stored["evidenceFreshUntil"] > _now())
            return stored

    def posted(self, job_id: str, connection=None, *, include_deleted=False, unit=None) -> dict:
        with nullcontext(unit) if unit is not None else self.repository.read(connection) as current:
            stored = self._read("posted", job_id, unit=current, include_deleted=include_deleted)
            if stored and stored.get("recordUnavailable"):
                snapshot = current.posting(job_id, include_deleted=include_deleted)
                return {"ok": True, "recordStatus": "unavailable", "jobKey": job_id, "legacyRawSalary": snapshot.get("salary"),
                        "failureCode": "posted_compensation_determination_unavailable"}
            if stored:
                return _posted_response(job_id, stored)
            snapshot = current.posting(job_id, include_deleted=include_deleted)
            return {"ok": True, "recordStatus": "not_recorded", "jobKey": job_id, "legacyRawSalary": snapshot.get("salary")}

    def market(self, job_id: str, connection=None, *, include_deleted=False, unit=None) -> dict:
        stored = self._read("market", job_id, connection, unit=unit, include_deleted=include_deleted)
        if stored and stored.get("recordUnavailable"):
            return {"ok": True, "recordStatus": "unavailable", "jobKey": job_id, "failureCode": "compensation_determination_unavailable"}
        return _market_response(job_id, stored) if stored else {"ok": True, "recordStatus": "not_requested", "jobKey": job_id}

    def _claim(self, job_id: str, operation_id: str | None = None, input_hash: str | None = None) -> tuple[str | None, dict | None]:
        attempt = str(uuid4())
        now = _now()
        expires = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self.repository.write() as unit:
            unit.posting(job_id)
            if operation_id:
                completion = unit.completion(operation_id)
                if completion:
                    if completion["input_hash"] != input_hash:
                        raise ConflictError("The refresh operation belongs to different input.")
                    return None, completion["result"]
            unit.claim(job_id, attempt, now, expires)
            unit.append_event("CompensationRefreshChanged", {"jobId": job_id, "status": "running"}, job_id)
        return attempt, None

    def _renew(self, job_id: str, attempt: str) -> None:
        now = _now()
        expires = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self.repository.write() as unit:
            unit.renew(job_id, attempt, now, expires)

    async def refresh(self, job_id: str, *, options: dict | None = None, context=None, automatic=False) -> dict:
        options = options or {}
        def automation_guard(unit=None):
            if automatic:
                if unit is not None:
                    enabled = unit.automatic_enabled()
                else:
                    with self.repository.read() as current:
                        enabled = current.automatic_enabled()
                if not enabled:
                    raise AppError("automatic_refresh_disabled", "Automatic compensation refresh is disabled.", 409)
        automation_guard()
        def cancellation_guard():
            if context is not None and context.cancelled():
                raise AppError("cancelled", "Compensation refresh cancelled.", 409)
        operation_id = f"{context.run_id}:{job_id}" if context else None
        input_hash = hashlib.sha256(_json({"jobId": job_id, "options": options, "automatic": automatic}).encode()).hexdigest()
        if operation_id:
            with self.repository.read() as unit:
                completion = unit.completion(operation_id)
            if completion:
                if completion["input_hash"] != input_hash:
                    raise ConflictError("The refresh operation belongs to different input.")
                return completion["result"]
        attempt, completed = self._claim(job_id, operation_id, input_hash)
        if completed is not None:
            return completed
        if attempt is None:
            raise RuntimeError("Compensation refresh was not admitted")
        async def keep_lease():
            while True:
                await asyncio.sleep(60)
                self._renew(job_id, attempt)
                if context:
                    context.heartbeat({"jobId": job_id})
        lease_task = asyncio.create_task(keep_lease())
        try:
            with self.repository.read() as unit:
                snapshot = unit.posting(job_id)
                preferences, policy_revision = unit.policy_snapshot()
            source, source_field = _posting_source(snapshot)
            posted = await extract_posted(source, self.model)
            automation_guard()
            if context and context.cancelled():
                raise AppError("cancelled", "Compensation refresh cancelled.", 409)
            posted_record = {"fact": asdict(posted), "sourceField": source_field, "updatedAt": _now()}
            target_source = _target_source(snapshot)
            target = await self.model.classify(target_source)
            automation_guard()
            validate_classification(target_source, target)
            source_set = self.source_factory(options, attempt, preferences) if self.source_factory else None
            providers = source_set.providers if source_set else self.providers
            if not providers:
                raise AppError("compensation_provider_unavailable", "No compensation source is available for refresh.", 503)
            observations, failures = [], []
            for name, provider in providers:
                automation_guard()
                if name == "euro_top_tech" and options.get("includeEuroTopTech", True) is False:
                    continue
                saved = preferences.get(name, {})
                if name in ("levels_fyi", "glassdoor") and not saved.get("enabled", False):
                    continue
                policy = {"enabled": saved.get("enabled", True), "access_mode": saved.get("accessMode"),
                          "europe_coverage_confirmed": saved.get("europeCoverageConfirmed", False)}
                load = await asyncio.to_thread(provider.load, target, policy)
                source_errors = list(load.errors)
                if name == "manual_reported_compensation":
                    for row in load.observations:
                        source_policy = preferences.get(row.provider, {})
                        mode = source_policy.get("accessMode")
                        if row.provider == "levels_fyi" and not (source_policy.get("enabled") is True
                                and mode in {"licensed_api", "licensed_data_feed", "enterprise_mcp"}
                                and source_policy.get("europeCoverageConfirmed") is True):
                            source_errors.append("levels_fyi_access_not_permitted")
                        if row.provider == "glassdoor" and not (source_policy.get("enabled") is True
                                and mode in {"partner_api", "written_permission"}):
                            source_errors.append("glassdoor_access_not_permitted")
                target_receipts = [item.as_dict() for item in load.levels_fyi_targets[:128]]
                receipt = {"errors": list(dict.fromkeys(source_errors)), "observationCount": len(load.observations),
                           "levelsFyiTargets": target_receipts,
                           "omittedTargets": max(0, len(load.levels_fyi_targets) - len(target_receipts)),
                           "diagnostics": dict(load.diagnostics)}
                # Bound persisted diagnostics; never store bodies, headers, tokens or exception messages.
                encoded = _json(receipt)
                if len(encoded.encode()) > 128 * 1024:
                    receipt["levelsFyiTargets"] = []
                    receipt["omittedTargets"] = len(load.levels_fyi_targets)
                with self.repository.write() as unit:
                    unit.assert_posting_current(snapshot)
                    unit.record_source_receipt(job_id, attempt, name, receipt, _now())
                failures.extend(source_errors)
                observations.extend(load.observations)
            imported_providers = {row.provider for row in observations if row.provenance == "licensed"}
            failures = [code for code in failures if not (
                code == "levels_fyi_feed_unconfigured" and "levels_fyi" in imported_providers
                or code == "glassdoor_feed_unconfigured" and "glassdoor" in imported_providers)]
            if failures:
                raise AppError("compensation_source_unavailable", "A permitted compensation source could not be refreshed.", 503)
            # Never publish future or malformed explicit source dates; absence stays unknown.
            valuation_date = _now()[:10]
            for observation in observations:
                validate_source_date(observation.source, valuation_date)
            # Each unique source gets its own determination, reused within this attempt only.
            unique = {(row.source.reference, hashlib.sha256(row.source.text.encode()).hexdigest()): row.source for row in observations}
            with self.repository.read() as unit:
                config = unit.settings_snapshot()
            capacity = 1 if config.get("dailyBudgetUsd") else config.get("laneConcurrency", {}).get("compensation", 1)
            bounded = asyncio.Semaphore(max(1, min(int(capacity), 32)))
            async def classify(source):
                async with bounded:
                    automation_guard()
                    judgment = await self.model.classify(source)
                    validate_classification(source, judgment)
                    return judgment
            results = await asyncio.gather(*(classify(source) for source in unique.values()))
            classified = dict(zip(unique, results, strict=True))
            rows = [replace(row, classification=classified[(row.source.reference, hashlib.sha256(row.source.text.encode()).hexdigest())]) for row in observations]
            if any(row.period not in ("year", "month") for row in rows) or len({row.period for row in rows}) > 1:
                rows = [replace(row, original_period=row.original_period or row.period,
                                original_currency=row.original_currency or row.currency,
                                original_minimum=row.original_minimum if row.original_minimum is not None else row.minimum,
                                original_maximum=row.original_maximum if row.original_maximum is not None else row.maximum,
                                period="year", minimum=annualize(row.minimum, row.period) if row.minimum is not None else None,
                                maximum=annualize(row.maximum, row.period) if row.maximum is not None else None) for row in rows]
            unique_rows = {}
            for row in rows:
                prior = unique_rows.get(row.source.reference)
                if prior is not None and prior != row:
                    raise EvidenceError("conflicting_source_observation")
                unique_rows[row.source.reference] = row
            rows = list(unique_rows.values())
            if context and context.cancelled():
                raise AppError("cancelled", "Compensation refresh cancelled.", 409)
            acquired_at = _now()
            current_expiry = (datetime.fromisoformat(acquired_at.replace("Z", "+00:00")) + timedelta(days=7)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            acquired_rows = list(rows)
            input_freshness = {row.source.reference: {"observed_at": acquired_at, "fresh_until": current_expiry} for row in acquired_rows}
            cached_facts, cached_rates = [], []
            with self.repository.read() as unit:
                cached = unit.fresh_benchmark_inputs(target.occupation, target.seniority, "total_compensation", acquired_at)
                for entry in cached:
                    try:
                        fact = self._verified_benchmark(entry["fact"], unit, valuation_date)
                        if not self._source_permitted(fact.observation, preferences, options):
                            continue
                        cached_facts.append((fact, entry))
                    except Exception:
                        continue  # An unverifiable cache entry is never evidence.
                for entry in unit.fresh_rate_snapshots(acquired_at):
                    try:
                        rate_source = Source(**entry["source"])
                        validate_source_date(rate_source, valuation_date)
                        values = self.source_verifier.rate_snapshot(entry["source"])
                        cached_rates.extend(values)
                        input_freshness[rate_source.reference] = {"observed_at": entry["fetched_at"], "fresh_until": entry["fresh_until"]}
                    except Exception:
                        continue
            current_refs = {row.source.reference for row in acquired_rows}
            # The same source row can have several independently normalized
            # facts (for example after a later exchange-rate snapshot). Keep
            # only the newest verified acquisition of that source evidence.
            cached_facts.sort(key=lambda pair: pair[1]["fetched_at"], reverse=True)
            for fact, entry in cached_facts:
                if fact.exchange_rate and fact.exchange_rate.source.reference not in input_freshness:
                    continue
                if fact.observation.source.reference not in current_refs:
                    rows.append(fact.observation)
                    input_freshness[fact.observation.source.reference] = {"observed_at": entry["fetched_at"], "fresh_until": entry["fresh_until"]}
                    current_refs.add(fact.observation.source.reference)
            estimate = estimate_market(target_source, target, rows, posted=posted)
            direct, company_direct, rejected, market_rejected = [], [], [], []
            rate_provider = _RecordedRates(cached_rates, source_set.rates() if source_set else None, input_freshness)
            rate_cache = {}
            for row in estimate.sources:
                if row.classification.market_scope not in {"market", "company"}:
                    continue
                try:
                    rate = None
                    if row.currency != "EUR":
                        if row.currency not in rate_cache:
                            try:
                                rate_cache[row.currency] = await asyncio.to_thread(rate_provider.rate, row.currency, "EUR", valuation_date)
                            except Exception:
                                rate_cache[row.currency] = None
                        rate = rate_cache[row.currency]
                    fact = direct_benchmark(row, rate=rate)
                    (direct if row.classification.market_scope == "market" else company_direct).append(fact)
                except (EvidenceError, ValueError, TypeError, OverflowError) as error:
                    code = str(error) if isinstance(error, EvidenceError) else "invalid_benchmark_input"
                    rejection = {"sourceReference": row.source.reference, "reason": code}
                    rejected.append(rejection)
                    if row.classification.market_scope == "market":
                        market_rejected.append(rejection)
            acquired_facts = []
            for row in acquired_rows:
                cls = row.classification
                if (cls is None or cls.occupation != target.occupation or cls.seniority != target.seniority
                        or row.component != "total_compensation"):
                    continue
                try:
                    rate = None if row.currency == "EUR" else await asyncio.to_thread(rate_provider.rate, row.currency, "EUR", valuation_date)
                    fact = direct_benchmark(row, rate=rate)
                    acquired_facts.append(fact)
                except Exception:
                    continue  # A missing rate or unusable row is not a reusable fact.
            previous_market = self._read("market", job_id)
            if (market_rejected or (not direct and rejected and not company_direct)) and previous_market and previous_market.get("directBenchmarks"):
                raise AppError("benchmark_unavailable", "Benchmark normalization could not be completed; previous evidence remains available.", 503)
            if (direct and len(target.countries) == 1
                    and target.geography_scope in {"country", "locality"}
                    and all(item.observation.classification.market_scope == "market"
                            and item.observation.classification.countries == target.countries
                            and item.observation.classification.geography_scope == target.geography_scope
                            and item.observation.classification.locality == target.locality for item in direct)):
                estimate = replace(estimate, state="estimated_range", currency="EUR", period="year",
                                   minimum=min(item.annual_minimum_eur for item in direct),
                                   maximum=max(item.annual_maximum_eur for item in direct), reasons=())
            else:
                direct = []
            geography = None
            new_prices = []
            price_freshness = {}
            # A same-scope direct observation always wins. Country extrapolation
            # uses only independently classified country-level market anchors.
            if not direct and target.geography_scope == "country" and source_set:
                automation_guard()
                if context and context.cancelled():
                    raise AppError("cancelled", "Compensation refresh cancelled.", 409)
                rates = rate_provider
                market_countries = {row.classification.countries[0] for row in rows
                                    if row.classification and row.classification.geography_scope == "country"
                                    and len(row.classification.countries) == 1 and row.classification.market_scope == "market"
                                    and row.classification.occupation == target.occupation
                                    and row.classification.seniority == target.seniority
                                    and row.component == "total_compensation"
                                    and row.classification.countries != target.countries}
                matches = []
                if market_countries and len(target.countries) == 1:
                    companies = [row for row in rows if row.company_reference and row.classification
                                 and row.classification.market_scope == "company" and row.classification.geography_scope == "country"
                                 and len(row.classification.countries) == 1 and row.classification.occupation == target.occupation
                                 and row.classification.seniority == target.seniority and row.component == "total_compensation"]
                    left = [row for row in companies if row.classification.countries[0] in market_countries]
                    right = [row for row in companies if row.classification.countries == target.countries]
                    candidates = [(a, b) for a in left for b in right if a.company_reference == b.company_reference]
                    if len(candidates) > 128:
                        raise AppError("company_identity_candidate_limit", "Too many source-bound company comparisons require review.", 409)
                    for a, b in candidates:
                        automation_guard()
                        if context and context.cancelled():
                            raise AppError("cancelled", "Compensation refresh cancelled.", 409)
                        try:
                            left_rate = None if a.currency == "EUR" else await asyncio.to_thread(rates.rate, a.currency, "EUR", valuation_date)
                            right_rate = None if b.currency == "EUR" else await asyncio.to_thread(rates.rate, b.currency, "EUR", valuation_date)
                            source_fact = direct_benchmark(a, rate=left_rate)
                            target_fact = direct_benchmark(b, rate=right_rate)
                        except (EvidenceError, ValueError, TypeError, OverflowError):
                            continue
                        decision = await self.model.company_identity(a, b)
                        matches.append(CompanyMatch(source_fact, target_fact, decision))
                official_receipts, price_freshness, price_cache, new_prices = [], {}, {}, []
                reference_year = datetime.fromisoformat(valuation_date).year - 1
                with self.repository.read() as unit:
                    for year in (reference_year, reference_year - 1):
                        candidates = unit.fresh_price_snapshots(year, acquired_at)
                        for entry in sorted(candidates, key=lambda item: item["fetched_at"], reverse=True):
                            try:
                                facts = self.source_verifier.price_snapshot(entry["source"], year)
                                price_cache[year] = facts
                                price_freshness[facts[0].source.reference] = {"observed_at": entry["fetched_at"], "fresh_until": entry["fresh_until"]}
                                break
                            except Exception:
                                continue
                def load_price_levels(year):
                    if year in price_cache:
                        values = price_cache[year]
                        official_receipts.append({"year": year, "status": "reused", "count": len(values),
                                                  "snapshotReference": values[0].source.reference if values else None})
                        return values
                    try:
                        values = tuple(source_set.price_levels(year))
                        if values:
                            source = values[0].source
                            self.source_verifier.price_snapshot(asdict(source), year)
                            observed = _now()
                            expiry = (datetime.fromisoformat(observed.replace("Z", "+00:00")) + timedelta(days=7)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                            price_freshness[source.reference] = {"observed_at": observed, "fresh_until": expiry}
                            new_prices.append((source, year, observed, expiry))
                            price_cache[year] = values
                        official_receipts.append({"year": year, "status": "available", "count": len(values),
                                                  "snapshotReference": values[0].source.reference if values else None})
                        return values
                    except Exception:
                        official_receipts.append({"year": year, "status": "unavailable"})
                        raise
                geography = await extrapolate_for_target(
                    target_source=target_source, target=target, rows=rows, rates=rates,
                    load_price_levels=load_price_levels,
                    reference_year=reference_year, valuation_date=valuation_date,
                    matched_company_inputs=matches, input_freshness=input_freshness, price_freshness=price_freshness)
                if official_receipts:
                    with self.repository.write() as unit:
                        unit.assert_posting_current(snapshot)
                        unit.record_source_receipt(job_id, attempt, "eurostat",
                                                   {"requests": official_receipts[:128], "omittedRequests": max(0, len(official_receipts) - 128)}, _now())
                previous_geography = (previous_market or {}).get("geography") or {}
                if geography.status == "unavailable" or (geography.status == "insufficient" and previous_geography.get("status") == "estimated"):
                    raise AppError("benchmark_unavailable", "Geographic benchmark inputs are unavailable; previous evidence remains available.", 503)
                if geography.status == "estimated":
                    adjusted = geography.extrapolation
                    estimate = replace(estimate, state="estimated_range", currency="EUR", period="year",
                                       minimum=adjusted.minimum, maximum=adjusted.maximum,
                                       warnings=tuple(dict.fromkeys([*estimate.warnings, "benchmark_extrapolated", *geography.warnings,
                                           *(["factor_out_of_bounds"] if adjusted.factor_bound_state != "within_bounds" else [])])), reasons=())
            # When no direct market or geographic benchmark exists, retain a
            # same-location company observation as a clearly labelled fallback.
            # Its source-bound company classification does not assert that the
            # employer is the target job's company.
            if (not direct and company_direct and len(target.countries) == 1
                    and target.geography_scope in {"country", "locality"}
                    and (geography is None or geography.status == "insufficient")):
                direct = company_direct
                estimate = replace(estimate, state="estimated_range", currency="EUR", period="year",
                                   minimum=min(item.annual_minimum_eur for item in direct),
                                   maximum=max(item.annual_maximum_eur for item in direct), reasons=())
            derived_facts = list(acquired_facts) + list(direct)
            if geography and geography.status == "estimated":
                derived_facts.append(geography.anchor)
                for match in geography.company_matches:
                    derived_facts.extend((match.source, match.target))
            source_expiries = [input_freshness[row.source.reference]["fresh_until"] for row in estimate.sources]
            for fact in direct:
                if fact.exchange_rate:
                    source_expiries.append(input_freshness[fact.exchange_rate.source.reference]["fresh_until"])
            evidence_expiry = geography.fresh_until if geography and geography.status == "estimated" else min(source_expiries, default=current_expiry)
            market_record = {"jobId": job_id, "estimate": asdict(estimate), "target": asdict(target), "updatedAt": _now(),
                             "evidenceFreshUntil": evidence_expiry,
                             "company": snapshot.get("company"), "title": snapshot.get("title"),
                             "targetSource": asdict(target_source), "allEvidence": [asdict(row) for row in rows],
                             "inputFreshness": input_freshness, "priceFreshness": price_freshness,
                             "geography": asdict(geography) if geography else None,
                             "directBenchmarks": [asdict(item) for item in direct], "benchmarkRejections": rejected[:128],
                             "benchmarkRejectionsOmitted": max(0, len(rejected)-128)}
            outcome = {"ok": True, "status": "succeeded", "postedFactsRefreshed": 1,
                       "reportedObservationsLoaded": len(observations), "estimatesRefreshed": 1}
            with self.repository.write() as unit:
                automation_guard(unit)
                cancellation_guard()
                if unit.policy_snapshot()[1] != policy_revision:
                    raise ConflictError("Compensation source settings changed during refresh.")
                for rate_source in rate_provider.new_sources.values():
                    window = input_freshness[rate_source.reference]
                    unit.save_rate_snapshot(asdict(rate_source), window["observed_at"], window["fresh_until"])
                for fact in {item.reference: item for item in derived_facts}.values():
                    window = input_freshness[fact.observation.source.reference]
                    unit.save_benchmark_input(asdict(fact), window["observed_at"], window["fresh_until"])
                for price_source, year, observed, expiry in new_prices:
                    unit.save_price_snapshot(asdict(price_source), year, observed, expiry)
                unit.save_record("posted", snapshot, posted_record, attempt)
                unit.save_record("market", snapshot, market_record, attempt)
                self._verify_record("posted", posted_record, unit)
                self._verify_record("market", market_record, unit)
                cancellation_guard()
                unit.set_refresh_result(job_id, attempt, "succeeded", None, _now())
                unit.append_event("CompensationRefreshChanged", {"jobId": job_id, "status": "succeeded"}, job_id)
                if operation_id:
                    unit.save_completion(operation_id, job_id, input_hash, outcome)
            return outcome
        except BaseException as exc:
            cancelled = isinstance(exc, asyncio.CancelledError) or (context is not None and context.cancelled()) or (isinstance(exc, AppError) and exc.code == "cancelled")
            status = "cancelled" if cancelled else "failed"
            code = "cancelled" if cancelled else exc.code if isinstance(exc, AppError) else "compensation_refresh_failed"
            with self.repository.write() as unit:
                changed = unit.set_refresh_result(job_id, attempt, status, code, _now())
                if changed:
                    unit.append_event("CompensationRefreshChanged", {"jobId": job_id, "status": status, "failureCode": code}, job_id)
            raise
        finally:
            lease_task.cancel()
            try:
                await lease_task
            except asyncio.CancelledError:
                pass

    def outreach_sources(self, job_id: str, connection=None) -> list[dict]:
        """Public, bounded, source-labelled context; estimates never become offer terms."""
        with self.repository.read(connection) as unit:
            posted = self.posted(job_id, unit=unit)
            market = self.market(job_id, unit=unit)
        sources = []
        if posted["recordStatus"] == "recorded":
            determination = posted["determination"]
            receipt = {key: value for key, value in determination.items() if key != "result"}
            sources.append({"source_id": "compensation:posted:" + determination["receipt_id"],
                            "text": _json({"label": "Employer posting evidence, not actual offer terms",
                                           "sourceCurrent": posted["sourceCurrent"], "fact": posted["fact"], "receipt": receipt})})
            for index, citation in enumerate(determination["result"]["determination"]["citations"]):
                sources.append({"source_id": f"compensation:posted:{determination['receipt_id']}:citation:{index}",
                                "text": _json(citation)})
        if market["recordStatus"] == "recorded":
            estimate = market["estimate"]
            # Keep individual determination sources bounded even for a large provider result.
            summary = {key: estimate.get(key) for key in ("estimateState", "currency", "period", "component", "minimumAmount", "maximumAmount", "confidenceBand", "sourceCount", "sampleCount", "estimatedAt", "warnings")}
            lineage = estimate.get("benchmarkLineage") or {}
            inputs = lineage.get("directInputs", [])
            summary.update(benchmarkKind=lineage.get("kind"), omittedInputs=max(0, len(inputs) - 128))
            sources.append({"source_id": "compensation:market:" + hashlib.sha256(_json(summary).encode()).hexdigest(),
                            "text": _json({"label": "Recorded market estimate, not an employer offer or guaranteed entitlement", "sourceCurrent": market["sourceCurrent"],
                                           "evidenceFresh": market.get("evidenceFresh"), "evidenceFreshUntil": market.get("evidenceFreshUntil"), "estimate": summary})})
            for index, item in enumerate(inputs[:128]):
                compact = dict(item)
                if compact.get("rate"):
                    compact["rate"] = dict(compact["rate"])
                    compact["rate"]["source"] = {key: value for key, value in compact["rate"]["source"].items() if key != "text"}
                sources.append({"source_id": f"compensation:market-input:{index}:" + hashlib.sha256(_json(compact).encode()).hexdigest(),
                                "text": _json(compact)})
        return sources

    def combined(self, job_id: str, connection=None, *, include_deleted=False, unit=None) -> dict:
        with nullcontext(unit) if unit is not None else self.repository.read(connection) as current:
            posted = self.posted(job_id, include_deleted=include_deleted, unit=current)
            market = self.market(job_id, include_deleted=include_deleted, unit=current)
            status = current.refresh_state(job_id)
            receipts = [] if status is None else current.source_receipts(job_id, status["attempt_id"])
        def display(currency, low, high, period):
            if low is None and high is None:
                return None
            prefix = f"{currency} " if currency else ""
            values = f"up to {high}" if low is None else f"{low}+" if high is None else str(low) if low == high else f"{low}-{high}"
            return prefix + values + (f"/{period}" if period else "")
        fact = posted.get("fact", {})
        estimate = market.get("estimate", {})
        p_range = None
        if fact.get("parseState") == "parsed_range":
            p_range = {"currency": fact["currency"], "period": fact["period"], "component": fact["component"],
                       "minimumAmount": fact["minimumAmount"], "maximumAmount": fact["maximumAmount"],
                       "annualizedMinimumAmount": fact["annualizedMinimumAmount"], "annualizedMaximumAmount": fact["annualizedMaximumAmount"],
                       "displayRange": display(fact["currency"], fact["minimumAmount"], fact["maximumAmount"], fact["period"])}
        m_range = None
        if estimate.get("estimateState") == "estimated_range":
            m_range = {"currency": estimate["currency"], "period": estimate["period"], "component": estimate["component"],
                       "minimumAmount": estimate["minimumAmount"], "maximumAmount": estimate["maximumAmount"],
                       "displayRange": display(estimate["currency"], estimate["minimumAmount"], estimate["maximumAmount"], estimate["period"])}
        p_summary = {"sourceKind": "posted", "recordStatus": posted["recordStatus"], "parseState": fact.get("parseState"),
                     "confidence": fact.get("confidence", "none"), "warningCount": len(fact.get("warnings", [])),
                     "range": p_range, "displayRange": p_range["displayRange"] if p_range else None}
        m_summary = {"sourceKind": "reported_company_role_market", "benchmarkKind": (estimate.get("benchmarkLineage") or {}).get("kind"), "recordStatus": market["recordStatus"],
                     "estimateState": estimate.get("estimateState", "not_requested"), "confidenceBand": estimate.get("confidenceBand", "none"),
                     "confidenceScore": estimate.get("confidenceScore"), "sourceCount": estimate.get("sourceCount", 0),
                     "sampleCount": estimate.get("sampleCount"), "warningCount": len(estimate.get("warnings", [])),
                     "range": m_range, "displayRange": m_range["displayRange"] if m_range else None,
                     "confidenceInterval": None, "displayConfidenceInterval": None}
        audit_posted = dict(posted)
        audit_market = dict(market)
        if "jobKey" in audit_posted:
            audit_posted["jobId"] = audit_posted.pop("jobKey")
        if "jobKey" in audit_market:
            audit_market["jobId"] = audit_market.pop("jobKey")
        if "fact" in audit_posted:
            audit_posted["fact"] = {("jobId" if k == "jobKey" else k): v for k, v in audit_posted["fact"].items()}
        if "estimate" in audit_market:
            audit_market["estimate"] = {("jobId" if k == "jobKey" else k): v for k, v in audit_market["estimate"].items()}
        return {"summary": {"projectionVersion": 1, "legacyRawSalary": fact.get("legacyRawSalary", posted.get("legacyRawSalary")),
                            "warningCount": p_summary["warningCount"] + m_summary["warningCount"], "posted": p_summary, "market": m_summary},
                "audit": {"projectionVersion": 1, "posted": audit_posted, "market": audit_market},
                "refresh": ({**dict(status), "sources": receipts} if status else None)}

    def job_summaries(self, job_ids, connection=None, *, include_deleted=True) -> dict:
        """Compose validated public snapshots under the caller's read transaction."""
        if not isinstance(job_ids, (list, tuple)) or any(not isinstance(job_id, str) for job_id in job_ids):
            raise ValueError("job IDs must be a list of strings")
        with self.repository.read(connection) as unit:
            return {job_id: self.combined(job_id, unit=unit, include_deleted=include_deleted) for job_id in dict.fromkeys(job_ids)}

    def delete_job_data(self, job_id: str, connection=None) -> None:
        """Remove this owner's private job evidence in the permanent-delete transaction."""
        if connection is None:
            raise RuntimeError("Permanent deletion requires the canonical transaction")
        with self.repository.write(connection) as unit:
            unit.delete_job(job_id)
