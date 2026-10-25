"""Overlap independent checks without publishing a proposed interpretation."""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path

from jobctrl.database import close_thread_connections, get_connection
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.domain.ports.analysis_checks import AnalysisCheckResults
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.enrichment.interpretation import interpret_job
from jobctrl.infrastructure.llm.attempt_admission import model_attempt_admission
from jobctrl.infrastructure.materials.letter_reviews import _letter_review_pool


class ParallelAnalysisChecks:
    def __init__(self, database: Path, dependencies: dict):
        self._database = database
        self._dependencies = {key: value for key, value in dependencies.items() if key != "repository"}

    def review(self, *, claim_request, interpretation_request, execution_guard=None):
        claims, interpretation = deepcopy(claim_request), deepcopy(interpretation_request)

        def leaf(kind, request, stop):
            try:
                stop.check()
                from jobctrl.database import DB_PATH

                if self._database != Path(DB_PATH).resolve():
                    raise DeterminationFailure("review_database_mismatch")
                conn = get_connection(self._database)
                deps = dict(self._dependencies, repository=SqliteDeterminationRepository(conn), on_terminal_failure=stop.abort)
                budget_preflight = deps["preflight"]

                def preflight():
                    stop.check()
                    return budget_preflight()

                deps["preflight"] = preflight
                with model_attempt_admission(stop.check):
                    stop.check()
                    if kind == "claims":
                        return ModelClaimVerifier(**deps).verify(**request)
                    # A receipt may finish before factual verification. Only
                    # the accepted aggregate's transaction may make it current.
                    result, _ = interpret_job(conn, dependencies=deps, bind=False, **request)
                    return result
            except BaseException as error:
                stop.abort(error)
                raise
            finally:
                if close_thread_connections():
                    stop.abort(RuntimeError("review_transaction_unfinished"))

        claims_result, interpretation_result = _letter_review_pool().run_pair(
            lambda stop: leaf("claims", claims, stop),
            lambda stop: leaf("interpretation", interpretation, stop),
            execution_guard,
        )
        return AnalysisCheckResults(claims_result, interpretation_result)
