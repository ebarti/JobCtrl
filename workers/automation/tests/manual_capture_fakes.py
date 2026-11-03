"""Explicit source-bound extraction model for synthetic manual-capture tests."""
from jobctrl.domain.enrichment.page_interpretation import ModelPageInterpreter, ModelPagePostingExtractor
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from tests.page_fakes import PageModel
from tests.workflow_determination_fakes import ImportModel


def install_manual_page_model(monkeypatch, *, model=None):
    selected = model or PageModel()

    def build(connection, *, tenant_id):
        return ModelPageInterpreter(
            llm=selected, repository=SqliteDeterminationRepository(connection), tenant_id=str(tenant_id),
            provider='synthetic', model='synthetic-page', lane='enrichment', preflight=lambda: None,
        )

    monkeypatch.setattr('jobctrl.infrastructure.discovery.production_wiring.build_page_interpreter', build)
    return selected


def install_manual_capture_selection(monkeypatch, *, model=None):
    selected = model or ImportModel()

    def build(connection, tenant_id):
        return ModelPagePostingExtractor(
            llm=selected, repository=SqliteDeterminationRepository(connection), tenant_id=str(tenant_id),
            provider='synthetic', model='synthetic-manual-selection', lane='enrichment', preflight=lambda: None,
        )

    monkeypatch.setattr('jobctrl.infrastructure.discovery.production_wiring.build_manual_capture_posting_extractor', build)
    return selected
