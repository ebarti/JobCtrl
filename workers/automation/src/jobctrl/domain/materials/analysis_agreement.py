"""Persist one semantic agreement determination over the surviving model drafts."""

import json
from jobctrl.domain.determinations import Source, DeterminationFailure, determine
from jobctrl.domain.ports.analysis_agreement import DraftAgreement


class ModelAnalysisAgreementJudge:
    def __init__(self, *, llm, repository, tenant_id, provider, model, lane, preflight):
        self.dependencies = dict(
            llm=llm,
            repository=repository,
            tenant_id=tenant_id,
            provider=provider,
            model=model,
            lane=lane,
            preflight=preflight,
        )

    def judge(self, *, entity_id, drafts):
        sources = []
        kinds = {}
        for index, draft in enumerate(drafts):
            for row in draft.requirements:
                ident = f"draft:{index}:requirement:{row.id}"
                sources.append(Source(source_id=ident, text=json.dumps(row.model_dump(), ensure_ascii=False)))
                kinds[ident] = "requirement"
            for ordinal, row in enumerate(draft.keywords):
                ident = f"draft:{index}:keyword:{ordinal}"
                sources.append(Source(source_id=ident, text=json.dumps(row.model_dump(), ensure_ascii=False)))
                kinds[ident] = "keyword"
            sources.append(Source(source_id=f"draft:{index}:framing", text=draft.role_framing))

        def validate(result):
            for finding in result.findings:
                if any(kinds.get(ident) != finding.kind for ident in finding.source_ids):
                    raise DeterminationFailure("foreign_source_id")
                if any(cite.source_id not in finding.source_ids for cite in finding.citations):
                    raise DeterminationFailure("agreement_binding_invalid")

        return determine(
            kind="analysis_agreement",
            schema=DraftAgreement,
            schema_version="1",
            prompt_version="analysis-agreement-v1",
            instruction="Compare the surviving employer-analysis drafts by meaning. Return their diagnostic agreement score and every substantive divergent requirement or keyword, citing the corresponding draft source IDs and verbatim spans. Identical wording is not proof of agreement; different wording is not proof of disagreement. With one draft, report that there is no cross-draft comparison. The score is diagnostic and never gates acceptance.",
            sources=sources,
            context={"draft_count": len(drafts)},
            entity_id=entity_id,
            validate=validate,
            **self.dependencies,
        )
