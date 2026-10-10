"""Compensation consumes accepted job interpretations and persisted provider rows."""

from dataclasses import replace
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.compensation.classification import ModelBenchmarkClassifier
from jobctrl.domain.compensation.benchmarks import BenchmarkGeography
from jobctrl.infrastructure.determinations import determination_dependencies
from jobctrl.infrastructure.enrichment.interpretation import read_job_interpretation


def job_interpretation_for_id(conn, tenant_id, job_id):
    cursor = conn.execute(
        "SELECT j.*,e.full_description AS enriched_description FROM jobs j LEFT JOIN job_enrichments e ON e.tenant_id=j.tenant_id AND e.job_id=j.job_id AND e.current_status='enriched' WHERE j.tenant_id=? AND j.job_id=?",
        (tenant_id, job_id),
    )
    row = cursor.fetchone()
    if row is None:
        raise DeterminationFailure("job_interpretation_unavailable")
    job = dict(zip((column[0] for column in cursor.description), row))
    if job.get("enriched_description"):
        job["full_description"] = job["enriched_description"]
    accepted = read_job_interpretation(conn, job, tenant_id=tenant_id)
    if accepted is None:
        raise DeterminationFailure("job_interpretation_unavailable")
    return accepted[0]


def classify_observations(conn, observations, *, tenant_id, dependencies=None):
    dependencies = dependencies or determination_dependencies(conn, tenant_id=tenant_id, lane="compensation")
    classifier = ModelBenchmarkClassifier(**dependencies)
    classified = []
    for row in observations:
        result, envelope = classifier.classify(row)
        classified.append(
            replace(
                row,
                classification=result,
                determination_id=envelope.determination_id,
                classification_entity_id=envelope.entity_id,
            )
        )
    return tuple(classified)


def classified_geography(classification):
    places = [place for place in classification.places if place.country_code]
    if len(places) != 1:
        return None
    place = places[0]
    return (
        BenchmarkGeography(place.country_code, scope="locality", locality=place.locality)
        if place.locality
        else BenchmarkGeography(place.country_code)
    )
