"""Explicit classifications for synthetic compensation product-path checks."""

import json
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.enrichment.interpretation import interpret_job
from jobctrl.domain.compensation import ReportedCompensationObservation
from jobctrl.infrastructure.compensation.sqlite_market_repository import ReportedCompensationSourceLoad
from jobctrl.infrastructure.compensation.automatic_refresh import run_automatic_compensation_refresh

NOW = "2026-08-12T08:00:00Z"
FRESH = "2026-08-19T08:00:00Z"
JOB = "11111111-1111-4111-8111-111111111111"


class ClassificationModel:
    def __init__(
        self,
        *,
        family="software_engineering",
        seniority="senior",
        country="ES",
        locality=None,
        scope="market",
        tier="unknown",
        fault=None,
    ):
        self.family, self.seniority, self.country, self.locality, self.scope, self.tier, self.fault, self.calls = (
            family,
            seniority,
            country,
            locality,
            scope,
            tier,
            fault,
            [],
        )

    def chat_json(self, messages, *, response_schema, **kwargs):
        data = json.loads(messages[1].content)
        self.calls.append(data)
        if self.fault:
            raise self.fault
        source = "posting" if response_schema["title"] == "JobInterpretation" else "provider_row"
        text = next(row["text"] for row in data["sources"] if row["source_id"] == source)
        quote = text[:200]
        cite = {"source_id": source, "quote": quote, "exact_values": []}

        def field(value):
            return {"value": value, "citations": [cite], "rationale": "Explicit synthetic model decision"}

        places = (
            []
            if self.country is None
            else [
                {
                    "country_code": self.country,
                    "region": "europe",
                    "locality": self.locality,
                    "citations": [cite],
                    "rationale": "Explicit synthetic model decision",
                }
            ]
        )
        if source == "posting":
            return {
                "track": field("ic"),
                "seniority": field(self.seniority),
                "occupation_family": field(self.family),
                "work_model": field("unknown"),
                "places": places,
                "requirements": [],
                "constraints": [],
                "compensation": [],
            }
        return {
            "occupation_family": field(self.family),
            "seniority": field(self.seniority),
            "places": places,
            "market_scope": field(self.scope),
            "company_tier": field(self.tier),
        }


def dependencies(conn, model, lane, tenant_id="local"):
    return dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id=tenant_id,
        provider="synthetic",
        model="synthetic",
        lane=lane,
        preflight=lambda: None,
    )


def put_job(conn, *, job_id=JOB, family="software_engineering", seniority="senior", country="ES"):
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,title,company,location,site,discovered_at) VALUES ('local',?,?,'Synthetic role','Synthetic employer','Synthetic place','synthetic',?)",
        (job_id, "https://example.test/" + job_id, NOW),
    )
    conn.commit()
    job = dict(conn.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone())
    return interpret_job(
        conn,
        job,
        dependencies=dependencies(
            conn, ClassificationModel(family=family, seniority=seniority, country=country), "enrichment"
        ),
    )


def observation(
    *,
    minimum=60000,
    maximum=90000,
    currency="EUR",
    snapshot="synthetic-1",
    source_url="https://example.org/compensation",
):
    return ReportedCompensationObservation(
        source_id="levels_fyi",
        source_provenance="public",
        company_name="Synthetic employer",
        role_title="Synthetic role",
        location="Synthetic place",
        level_label="Synthetic level",
        minimum_amount=minimum,
        maximum_amount=maximum,
        currency=currency,
        period="year",
        component="total_compensation",
        release_year=2026,
        snapshot_version=snapshot,
        sample_count=20,
        attribution="Synthetic source attribution",
        source_url=source_url,
    )


def configure_classifier(monkeypatch, model):
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.interpretation.determination_dependencies",
        lambda conn, **kwargs: dependencies(conn, model, "compensation"),
    )


def refresh(conn, *, now=NOW, rows=None, load=None, clock=None, fx=lambda: (), prices=lambda: (), force=None):
    return run_automatic_compensation_refresh(
        conn,
        tenant_id="local",
        owner="synthetic-refresh",
        now=now,
        load_observations=load
        or (
            lambda targets: ReportedCompensationSourceLoad(
                observations=tuple(rows if rows is not None else [observation()])
            )
        ),
        load_fx_rates=fx,
        load_price_levels=prices,
        completion_clock=clock or (lambda: now),
        force_slices=force,
    )


def record_job_interpretation(conn, job_id, **choices):
    cursor = conn.execute(
        "SELECT j.*,e.full_description AS enriched_description FROM jobs j LEFT JOIN job_enrichments e ON e.tenant_id=j.tenant_id AND e.job_id=j.job_id AND e.current_status='enriched' WHERE j.tenant_id='local' AND j.job_id=?",
        (str(job_id),),
    )
    row = cursor.fetchone()
    job = dict(zip((column[0] for column in cursor.description), row))
    if job.get("enriched_description"):
        job["full_description"] = job["enriched_description"]
    return interpret_job(conn, job, dependencies=dependencies(conn, ClassificationModel(**choices), "enrichment"))[0]


def classified_row(row, *, conn=None, **choices):
    from dataclasses import replace
    from jobctrl.domain.compensation.classification import ModelBenchmarkClassifier
    from tests.test_semantic_determinations import Repository

    deps = (
        dependencies(conn, ClassificationModel(**choices), "compensation")
        if conn is not None
        else dict(
            llm=ClassificationModel(**choices),
            repository=Repository(),
            tenant_id="local",
            provider="synthetic",
            model="synthetic",
            lane="compensation",
            preflight=lambda: None,
        )
    )
    result, envelope = ModelBenchmarkClassifier(**deps).classify(row)
    return replace(
        row,
        classification=result,
        determination_id=envelope.determination_id,
        classification_entity_id=envelope.entity_id,
        company_tier=result.company_tier.value,
    )


class PayModel:
    """The test chooses pay meaning; code only binds its quoted source."""

    def __init__(
        self, minimum=None, maximum=None, *, currency="EUR", period="year", component="base_salary", state=None
    ):
        self.minimum, self.maximum, self.currency, self.period, self.component, self.state = (
            minimum,
            maximum,
            currency,
            period,
            component,
            state,
        )

    def chat_json(self, messages, **kwargs):
        source = json.loads(messages[1].content)["sources"][0]
        state = self.state or ("parsed_range" if self.minimum is not None or self.maximum is not None else "missing")
        return {
            "parse_state": state,
            "minimum_amount": self.minimum,
            "maximum_amount": self.maximum,
            "currency": self.currency if state == "parsed_range" else None,
            "period": self.period if state == "parsed_range" else "unknown",
            "component": self.component if state == "parsed_range" else "unknown",
            "confidence": "high" if state == "parsed_range" else "none",
            "warnings": [],
            "citations": [{"source_id": source["source_id"], "quote": source["text"][:4000], "exact_values": []}]
            if source["text"]
            else [],
            "rationale": "Explicit synthetic pay decision",
        }


def pay_extractor(conn, tenant_id="local", **choices):
    from jobctrl.domain.compensation.posted import ModelPostedPayExtractor

    deps = dependencies(conn, PayModel(**choices), "compensation")
    deps["tenant_id"] = tenant_id
    return ModelPostedPayExtractor(**deps)


def install_compensation_models(conn, monkeypatch, *, pay_by_job=None, seniority="senior", country="ES"):
    from jobctrl.infrastructure.compensation import refresh as module
    from jobctrl.infrastructure.compensation.sqlite_repository import SqlitePostedCompensationRepository

    class SelectedPay:
        def extract(self, text, *, entity_id):
            return pay_extractor(conn, **(pay_by_job or {}).get(str(entity_id), {})).extract(text, entity_id=entity_id)

    monkeypatch.setattr(
        module,
        "SqlitePostedCompensationRepository",
        lambda connection: SqlitePostedCompensationRepository(connection, extractor=SelectedPay()),
    )
    configure_classifier(monkeypatch, ClassificationModel(seniority=seniority, country=country))
    for row in conn.execute("SELECT job_id FROM jobs WHERE tenant_id='local'").fetchall():
        record_job_interpretation(conn, row[0], seniority=seniority, country=country)
