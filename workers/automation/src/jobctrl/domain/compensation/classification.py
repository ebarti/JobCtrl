"""Provider rows are classified once into the shared semantic taxonomy."""

import hashlib
import json
from pydantic import Field
from typing import Literal
from jobctrl.domain.determinations import DeterminationModel, Source, determine
from jobctrl.domain.enrichment.interpretation import InterpretedField, InterpretedPlace
from jobctrl.domain.taxonomy_codes import OccupationFamilyCode, SeniorityCode


class BenchmarkClassification(DeterminationModel):
    occupation_family: InterpretedField[OccupationFamilyCode]
    seniority: InterpretedField[SeniorityCode]
    places: list[InterpretedPlace] = Field(max_length=12)
    market_scope: InterpretedField[Literal["company", "market"]]
    company_tier: InterpretedField[Literal["tier_1_local", "tier_2_ambitious", "tier_3_top_of_market", "unknown"]]


class ModelBenchmarkClassifier:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def classify(self, observation):
        payload = {
            key: getattr(observation, key)
            for key in (
                "source_id",
                "company_name",
                "role_title",
                "location",
                "level_label",
                "company_tier",
                "source_url",
            )
        }
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        return determine(
            kind="benchmark_classification",
            schema=BenchmarkClassification,
            schema_version="1",
            prompt_version="benchmark-classification-v1",
            entity_id=hashlib.sha256(text.encode()).hexdigest(),
            sources=[Source(source_id="provider_row", text=text)],
            context={},
            instruction="Classify this provider's reported salary population into the supplied occupation and seniority codes, and structured geographic places. An ambiguous mixed population remains unknown. Identify whether it is company-specific or a market aggregate and whether the source states a company compensation tier; do not infer a tier from the salary amount. Cite source spans for every judgment. No synonym tables or fuzzy similarity.",
            **self._dependencies,
        )
