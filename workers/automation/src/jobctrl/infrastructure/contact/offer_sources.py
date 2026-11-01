"""Canonical offer/compensation sources for the existing outreach gates.

No extraction, conversion, valuation or leverage inference happens here.
"""

from __future__ import annotations

import hashlib
import json

from jobctrl.domain.determinations import DeterminationFailure, Source

OFFER_KINDS = frozenset({"offer_negotiation", "offer_clarification", "offer_acceptance", "offer_decline"})
OFFER_RUBRIC = (
    "Use only confirmed actual offer terms and canonical achievements. Null equity, benefits, "
    "currencies, periods and deadlines are unknown; ask rather than fill them. "
    "Compensation evidence is a dated benchmark, not an employer offer or guaranteed entitlement. "
    "Never invent ROI, competing offers, employer budget, scarcity, deadlines or employer leverage. "
    "Do not convert currencies, annualize, value equity or sum incompatible components. "
    "Distinguish questions or negotiation requests from confirmed facts. Acceptance/decline messages "
    "require the matching user-attested decision on these exact terms. This is a reviewable draft; never send."
)


def load_offer_context(conn, tenant, job, kind, revision_id=None):
    if kind not in OFFER_KINDS:
        if revision_id:
            raise DeterminationFailure("offer_kind_required")
        return None
    rows = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND entity_kind='offer' AND entity_ref=? ORDER BY event_id",
        (str(tenant), job, job),
    ).fetchall()
    terms = decision = None
    for row in rows:
        payload = json.loads(row[0])
        terms = payload.get("termsRevision", terms)
        decision = payload.get("decision", decision)
    if not terms or (revision_id and terms["revisionId"] != revision_id):
        raise DeterminationFailure("offer_terms_changed_or_missing")
    if kind in {"offer_acceptance", "offer_decline"}:
        expected = "accepted" if kind == "offer_acceptance" else "declined"
        if not decision or decision["termsRevisionId"] != terms["revisionId"] or decision["decision"] != expected:
            raise DeterminationFailure("offer_decision_required")
    # Split provenance quotations from term values to keep every individual
    # canonical Source below its structural size limit, even for a large offer.
    from copy import deepcopy

    compact = deepcopy(terms)
    source_id = "offer:" + terms["revisionId"]
    provenance = []

    def bind_source(value, suffix):
        source = value["source"]
        if source.get("userConfirmed") is not True:
            raise DeterminationFailure("offer_source_unconfirmed")
        ident = source_id + ":" + suffix
        provenance.append({"source_id": ident, "text": json.dumps(source, ensure_ascii=False, sort_keys=True)})
        value["source"] = {"sourceId": ident}

    bind_source(compact["terms"], "source")
    for index, cash in enumerate(compact["terms"]["cash"]):
        bind_source(cash, "cash:" + str(index))
    for key in ("equity", "benefits", "decisionDeadline"):
        if compact["terms"][key] is not None:
            bind_source(compact["terms"][key], key)
    sources = [{"source_id": source_id, "text": json.dumps(compact, ensure_ascii=False, sort_keys=True)}, *provenance]
    if decision:
        sources.append(
            {
                "source_id": "offer-decision:" + decision["decisionId"],
                "text": json.dumps(decision, ensure_ascii=False, sort_keys=True),
            }
        )
    from jobctrl.domain.compensation.posted import PostedPayExtraction
    from jobctrl.domain.enrichment.interpretation import JobInterpretation
    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository

    repo = SqliteDeterminationRepository(conn)
    posted = conn.execute(
        "SELECT * FROM job_posted_compensation_facts WHERE tenant_id=? AND job_id=?", (str(tenant), job)
    ).fetchone()
    if posted is not None:
        receipt = repo.bound(
            tenant_id=str(tenant),
            entity_kind="posted_compensation",
            entity_id=job,
            entity_version=posted["source_hash"],
            determination_kind="posted_compensation",
        )
        if receipt and receipt.schema_version == "1" and receipt.prompt_version == "posted-compensation-v1":
            result = PostedPayExtraction.model_validate(receipt.result)
            if all(
                getattr(result, key) == posted[key]
                for key in (
                    "parse_state",
                    "currency",
                    "period",
                    "component",
                    "minimum_amount",
                    "maximum_amount",
                    "confidence",
                )
            ):
                sources.append(
                    {
                        "source_id": "compensation:posted:" + receipt.determination_id,
                        "text": json.dumps(
                            {
                                "label": "Employer posting evidence, not actual offer terms",
                                "recordedAt": posted["parsed_at"],
                                "sourceText": posted["source_text"],
                                "determination": receipt.model_dump(),
                            },
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                    }
                )
    market = conn.execute(
        "SELECT * FROM job_market_compensation_estimates WHERE tenant_id=? AND job_id=?", (str(tenant), job)
    ).fetchone()
    if market is not None:
        receipt = repo.bound(
            tenant_id=str(tenant),
            entity_kind="market_compensation",
            entity_id=job,
            entity_version=market["estimator_version"],
            determination_kind="job_interpretation",
        )
        if receipt and receipt.schema_version == "1" and receipt.prompt_version == "job-interpretation-v1":
            result = JobInterpretation.model_validate(receipt.result)
            from jobctrl.infrastructure.compensation.sqlite_market_repository import SqliteMarketCompensationRepository

            repository = SqliteMarketCompensationRepository(conn)
            estimate = repository.get_estimate(str(tenant), job)
            if (
                repository.can_retain_estimate(estimate)
                and market["occupation_code"] == result.occupation_family.value
                and market["seniority_label"] == result.seniority.value
            ):
                # Source inputs and classifications are retained in the owning compensation repository.
                # Supply the saved estimate with provenance IDs; do not infer any missing actual offer term.
                saved = {
                    key: market[key]
                    for key in (
                        "estimate_state",
                        "currency",
                        "period",
                        "component",
                        "minimum_amount",
                        "maximum_amount",
                        "confidence_band",
                        "source_count",
                        "sample_count",
                        "estimated_at",
                        "estimator_version",
                        "warnings_json",
                    )
                }
                saved["evidence"] = [
                    {
                        key: row.get(key)
                        for key in (
                            "source_id",
                            "determination_id",
                            "classification_entity_id",
                            "currency",
                            "period",
                            "component",
                            "minimum_amount",
                            "maximum_amount",
                        )
                    }
                    for row in json.loads(market["selected_evidence_json"])
                ]
                sources.append(
                    {
                        "source_id": "compensation:market:" + receipt.determination_id,
                        "text": json.dumps(
                            {
                                "label": "Recorded market estimate, not an employer offer or guaranteed entitlement",
                                "estimate": saved,
                            },
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                    }
                )
    context = {
        "binding": {
            "jobId": job,
            "termsRevisionId": terms["revisionId"],
            "decisionId": decision["decisionId"] if decision else None,
        },
        "sources": sources,
    }
    context["fingerprint"] = hashlib.sha256(json.dumps(context, sort_keys=True).encode()).hexdigest()
    return context


def context_sources(context):
    return [Source(**source) for source in context["sources"]] if context else []
