"""Source-bound structured model calls with one durable lane/spend authority."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError

from jobctrl.app.database import Database
from jobctrl.app.errors import AppError, NotFoundError
from jobctrl.app.events import now
from jobctrl.app.settings import PROVIDER_CONFIGURATION_KEYS, Settings
from jobctrl.app.synthetic import synthetic_boundary


@dataclass(frozen=True)
class ModelResult:
    value: dict
    provenance: dict


@dataclass(frozen=True)
class ModelExecution:
    """One immutable non-secret execution selection, shared by lookup and call."""

    provider: str
    model: str
    reasoning_effort: str | None
    _provider_configuration: tuple[tuple[str, str], ...] = field(repr=False)

    def identity(self) -> dict:
        return {"reasoning_effort": self.reasoning_effort,
                "provider_configuration_sha256": hashlib.sha256(
                    _canonical(dict(self._provider_configuration)).encode()).hexdigest()}

    def configuration(self) -> dict:
        # Return a fresh container so a downstream adapter cannot mutate the
        # frozen selection. Credentials are resolved only at its native boundary.
        return {"providerConfiguration": dict(self._provider_configuration),
                "codexReasoningEfforts": {self.model: self.reasoning_effort}
                if self.provider == "codex" else {}}


def _canonical(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class ModelGateway:
    def __init__(self, workspace: Path, database: Database, settings: Settings):
        self.workspace = workspace
        self.database = database
        self.settings = settings
        self.synthetic = synthetic_boundary(workspace, os.environ.get("JOBCTRL_E2E_PROVIDER_URL"))

    @staticmethod
    def _selection(settings: dict, model: str | None = None) -> dict:
        provider = settings["defaultProvider"]
        if model and ":" in model:
            provider, model = model.split(":", 1)
        if provider not in {"codex", "claude", "google"}:
            raise AppError("model_unavailable", "The configured provider is unavailable.", 503)
        selected = model or settings["providerModels"].get(provider)
        if not isinstance(selected, str) or not selected.strip():
            raise AppError("model_unavailable", "Select a model for this provider.", 503)
        return {"provider": provider, "model": selected}

    def selection(self, model: str | None = None) -> dict:
        return self._selection(self.settings.snapshot(), model)

    def freeze_execution(self, model: str | None = None, *, selection: dict | None = None) -> ModelExecution:
        """Resolve model and effective saved effort/configuration exactly once.

        Cache owners pass the returned descriptor to both fingerprint and
        determine. Accounting, admission and credentials deliberately stay live.
        """
        settings = self.settings.snapshot()
        selected = selection or self._selection(settings, model)
        provider, selected_model = selected["provider"], selected["model"]
        if provider not in {"codex", "claude", "google"} or not isinstance(selected_model, str) or not selected_model.strip():
            raise AppError("model_unavailable", "Choose a supported provider and model.")
        effort = settings.get("codexReasoningEfforts", {}).get(selected_model, "high") if provider == "codex" else None
        if provider == "codex" and effort not in {"low", "medium", "high", "xhigh", "max"}:
            raise AppError("model_reasoning_effort_invalid", "Choose a supported Codex reasoning effort.")
        configuration = settings.get("providerConfiguration", {})
        return ModelExecution(provider, selected_model, effort,
                              tuple(sorted((key, value) for key, value in configuration.items()
                                           if key in PROVIDER_CONFIGURATION_KEYS)))

    def _execution(self, execution, *, model=None, selection=None) -> ModelExecution:
        frozen = execution if execution is not None else self.freeze_execution(model, selection=selection)
        if (not isinstance(frozen, ModelExecution)
                or model is not None and model not in {frozen.model, f"{frozen.provider}:{frozen.model}"}
                or selection is not None and (selection.get("provider"), selection.get("model")) != (frozen.provider, frozen.model)):
            raise AppError("model_execution_mismatch", "The frozen execution must match the selected provider and model.")
        return frozen

    def accounting_capability(self, model: str | None = None, *, selection: dict | None = None, settings: dict | None = None) -> dict:
        selected = selection or self.selection(model)
        quote = (settings if settings is not None else self.settings.snapshot()).get("modelPricingQuotes", {}).get(f"{selected['provider']}:{selected['model']}")
        source = "provider_reported" if self.synthetic else "sdk_estimate" if selected["provider"] == "claude" else "configured_pricing_estimate" if quote is not None else None
        return {**selected, "available": source is not None,
                "costSource": source,
                "pricingQuote": quote}

    def _payload(self, *, operation: str, instructions: str, sources, response_schema: dict,
                 context: dict | None, prompt_version: str, lane: str, execution: ModelExecution) -> dict:
        if (not isinstance(operation, str) or not operation or len(operation) > 160
                or not isinstance(instructions, str) or not instructions.strip()
                or not isinstance(sources, (list, dict)) or not sources
                or not isinstance(response_schema, dict) or not response_schema
                or not isinstance(lane, str) or not lane or len(lane) > 80
                or not isinstance(prompt_version, str) or not prompt_version):
            raise AppError("invalid_model_request", "A model call requires sources, instructions, schema and provenance.")
        try:
            Draft202012Validator.check_schema(response_schema)
        except SchemaError:
            raise AppError("invalid_model_schema", "The model output schema is invalid.") from None
        value = dict(operation=operation, instructions=instructions, sources=sources,
                     response_schema=response_schema, context=context or {}, prompt_version=prompt_version,
                     lane=lane, provider=execution.provider, model=execution.model, execution=execution.identity())
        encoded = _canonical(value)
        if len(encoded.encode()) > 1024 * 1024:
            raise AppError("model_input_too_large", "The source-bound model input exceeds its limit.", 413)
        return json.loads(encoded)

    def fingerprint(self, *, operation: str, instructions: str, sources, response_schema: dict,
                    context: dict | None = None, prompt_version: str = "1", lane: str = "interactive",
                    model: str | None = None, selection: dict | None = None, execution: ModelExecution | None = None) -> str:
        value = self._payload(operation=operation, instructions=instructions, sources=sources,
                              response_schema=response_schema, context=context, prompt_version=prompt_version,
                              lane=lane, execution=self._execution(execution, model=model, selection=selection))
        return hashlib.sha256(_canonical(value).encode()).hexdigest()

    def receipt(self, receipt_id: str, connection=None) -> dict:
        if connection is None:
            with self.database.connect() as owned:
                return self.receipt(receipt_id, owned)
        row = connection.execute("SELECT * FROM app_model_calls WHERE receipt_id=?", (receipt_id,)).fetchone()
        if row is None:
            raise NotFoundError("The model receipt does not exist.")
        value = dict(row)
        value["value"] = json.loads(value.pop("result_json")) if value["result_json"] else None
        pricing = json.loads(value.pop("pricing_json")) if value["pricing_json"] else None
        envelope = isinstance(pricing, dict) and ("configured_quote" in pricing or "cost_provenance" in pricing)
        value["pricing_quote"] = pricing.get("configured_quote") if envelope else pricing
        value["cost_provenance"] = pricing.get("cost_provenance") if envelope else None
        value["owner_alive"] = _alive(value.pop("owner_pid")) if value["status"] == "running" else False
        if value["status"] == "running" and not value["owner_alive"]:
            value["recorded_status"] = "running"
            value["status"] = "uncertain"
        return value

    def receipts_for(self, operation: str, input_fingerprint: str, connection=None) -> list[dict]:
        """Bounded immutable attempt history for a feature's exact source call."""
        if connection is None:
            with self.database.connect() as owned:
                return self.receipts_for(operation, input_fingerprint, owned)
        rows = connection.execute(
            "SELECT receipt_id FROM app_model_calls WHERE operation=? AND input_fingerprint=? "
            "ORDER BY created_at DESC,receipt_id DESC LIMIT 64", (operation, input_fingerprint),
        ).fetchall()
        return [self.receipt(row[0], connection) for row in rows]

    def find_succeeded(self, input_fingerprint: str, connection=None) -> dict | None:
        """Exact receipt lookup only; feature owners still validate acceptance."""
        if connection is None:
            with self.database.connect() as owned:
                return self.find_succeeded(input_fingerprint, owned)
        row = connection.execute(
            "SELECT receipt_id FROM app_model_calls WHERE input_fingerprint=? AND status='succeeded' "
            "ORDER BY completed_at DESC,receipt_id LIMIT 1", (input_fingerprint,),
        ).fetchone()
        return self.receipt(row[0], connection) if row else None

    def spend(self) -> dict:
        day = now()[:10]
        with self.database.connect() as connection:
            connection.execute("BEGIN")
            settings = self.settings.snapshot(connection)
            budget = settings["dailyBudgetUsd"]
            unlimited = budget <= 0
            rows = connection.execute(
                "SELECT lane,COUNT(*) calls,COALESCE(SUM(CAST(input_tokens AS REAL)),0) input_tokens,"
                "COALESCE(SUM(CAST(output_tokens AS REAL)),0) output_tokens,SUM(cost_usd) cost_usd,"
                "SUM(CASE WHEN cost_source IN ('configured_pricing_estimate','sdk_estimate') THEN 1 ELSE 0 END) estimated_calls,"
                "SUM(CASE WHEN provider_started IS NOT 0 AND status='uncertain' THEN 1 ELSE 0 END) unresolved,"
                "SUM(CASE WHEN provider_started IS NOT 0 AND status NOT IN ('running','uncertain') "
                "AND cost_usd IS NULL THEN 1 ELSE 0 END) unavailable_cost,"
                "SUM(CASE WHEN provider_started IS NOT 0 AND status NOT IN ('running','uncertain') "
                "AND (input_tokens IS NULL OR output_tokens IS NULL) THEN 1 ELSE 0 END) unavailable_tokens "
                "FROM app_model_calls WHERE created_at>=? GROUP BY lane", (day,)
            ).fetchall()
            running = connection.execute(
                "SELECT lane,owner_pid,COUNT(*) calls FROM app_model_calls WHERE created_at>=? "
                "AND status='running' GROUP BY lane,owner_pid", (day,)
            ).fetchall()
        lanes = {row["lane"]: {**dict(row), "active": 0} for row in rows}
        owners = {row["owner_pid"]: _alive(row["owner_pid"]) for row in running}
        for row in running:
            lanes[row["lane"]]["active" if owners[row["owner_pid"]] else "unresolved"] += row["calls"]
        active = sum(row["active"] for row in lanes.values())
        unresolved = sum(row["unresolved"] for row in lanes.values())
        missing_cost = sum(row["unavailable_cost"] for row in lanes.values())
        missing_tokens = sum(row["unavailable_tokens"] for row in lanes.values())

        def status(unavailable):
            return "unresolved" if unresolved else "pending" if active else "unavailable" if unavailable else "complete"

        cost_status, token_status = status(missing_cost), status(missing_tokens)
        known_cost = sum(row["cost_usd"] or 0 for row in lanes.values())
        # Knowledge and admission are separate: unknown history is actionable
        # only for an enabled policy that requires that missing evidence.
        monetary_blocked = budget > 0 and (unresolved > 0 or missing_cost > 0)
        blocked_lanes = sorted(name for name, row in lanes.items()
                               if settings["laneTokenLimits"].get(name, 0) > 0
                               and (row["unresolved"] > 0 or row["unavailable_tokens"] > 0))
        return {"day": day, "lanes": list(lanes.values()), "unlimited": unlimited, "dailyBudgetUsd": budget,
                "accountingBlocked": monetary_blocked or bool(blocked_lanes),
                "monetaryAccountingBlocked": monetary_blocked, "tokenAccountingBlockedLanes": blocked_lanes,
                "costUsd": known_cost if cost_status == "complete" else None, "knownCostUsd": known_cost,
                "costStatus": cost_status, "tokenStatus": token_status,
                "activeCalls": active, "unresolvedCalls": unresolved,
                "unavailableCostCalls": missing_cost, "unavailableTokenCalls": missing_tokens,
                "accountingComplete": cost_status == "complete" and token_status == "complete",
                "costAuthority": "incomplete" if cost_status != "complete" else "includes_estimates"
                if any(row["estimated_calls"] for row in rows) else "reported"}

    def lane_status(self) -> dict:
        with self.database.connect() as connection:
            connection.execute("BEGIN")
            settings = self.settings.snapshot(connection)
            rows = connection.execute("SELECT lane,status,owner_pid FROM app_model_calls WHERE status IN ('running','uncertain')").fetchall()
        lanes = {name: {"lane": name, "active": 0, "unresolved": 0,
                        "capacity": settings["laneConcurrency"].get(name, 1)}
                 for name in set(settings["laneConcurrency"]) | {row["lane"] for row in rows}}
        for row in rows:
            field = "active" if row["status"] == "running" and _alive(row["owner_pid"]) else "unresolved"
            lanes[row["lane"]][field] += 1
        return {"observedAt": now(), "defaultCapacity": 1, "lanes": [lanes[key] for key in sorted(lanes)],
                "monetarySerialization": settings["dailyBudgetUsd"] > 0,
                "budgetBusy": settings["dailyBudgetUsd"] > 0 and any(item["active"] for item in lanes.values()),
                "scope": "recorded model calls and configured lane limits; provider readiness is separate"}

    def _admit(self, payload: dict, *, require_accounting: bool = False) -> str:
        receipt_id = str(uuid.uuid4())
        with self.database.transaction() as connection:
            settings = self.settings.snapshot(connection)
            if not settings["aiExecutionPolicy"]["enabled"]:
                raise AppError("ai_disabled", "AI execution is disabled in Settings.", 409)
            running = connection.execute("SELECT receipt_id,owner_pid FROM app_model_calls WHERE status='running'").fetchall()
            for row in running:
                if not _alive(row["owner_pid"]):
                    connection.execute("UPDATE app_model_calls SET status='uncertain',error_code='process_interrupted' WHERE receipt_id=?", (row["receipt_id"],))
            day = now()[:10]
            lane = payload["lane"]
            budget = settings["dailyBudgetUsd"]
            limit = settings["laneTokenLimits"].get(lane, 0)
            quote = settings["modelPricingQuotes"].get(f"{payload['provider']}:{payload['model']}")
            if (budget or require_accounting) and not self.synthetic and payload["provider"] != "claude" and quote is None:
                raise AppError(
                    "cost_accounting_unavailable",
                    "This provider does not report monetary cost. Save an exact model pricing quote or explicitly disable the monetary cap before starting.",
                    409, {"provider": payload["provider"], "model": payload["model"], "setting": "modelPricingQuotes"},
                )
            uncertain = connection.execute(
                "SELECT 1 FROM app_model_calls WHERE created_at>=? AND status!='running' AND "
                "provider_started IS NOT 0 AND "
                "((? > 0 AND (status='uncertain' OR cost_usd IS NULL)) OR "
                "(? > 0 AND lane=? AND (status='uncertain' OR input_tokens IS NULL OR output_tokens IS NULL))) LIMIT 1",
                (day, budget, limit, lane),
            ).fetchone()
            if uncertain and (budget or limit):
                raise AppError("spend_accounting_unresolved", "Model usage is unresolved; inspect the retained receipts before further calls.", 409)
            totals = connection.execute(
                "SELECT COALESCE(SUM(cost_usd),0),COALESCE(SUM(CASE WHEN lane=? THEN CAST(input_tokens AS REAL)+output_tokens ELSE 0 END),0) "
                "FROM app_model_calls WHERE created_at>=?", (lane, day)
            ).fetchone()
            if (budget and totals[0] >= budget) or (limit and totals[1] >= limit):
                raise AppError("spend_limit_reached", "The configured model spend or lane token limit has been reached.", 409)
            active = connection.execute("SELECT COUNT(*) FROM app_model_calls WHERE status='running' AND lane=?", (lane,)).fetchone()[0]
            if active >= settings["laneConcurrency"].get(lane, 1):
                raise AppError("model_lane_busy", "The model lane is at its configured capacity.", 429)
            # Capped accounting must settle one accepted call before admitting a
            # peer, otherwise concurrent checks could all spend the same budget.
            if budget and connection.execute("SELECT 1 FROM app_model_calls WHERE status='running' LIMIT 1").fetchone():
                raise AppError("model_budget_busy", "A budgeted model call is still settling.", 429)
            connection.execute(
                "INSERT INTO app_model_calls(receipt_id,operation,provider,model,lane,prompt_version,input_fingerprint,created_at,status,owner_pid,pricing_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (receipt_id, payload["operation"], payload["provider"], payload["model"], lane,
                 payload["prompt_version"], hashlib.sha256(_canonical(payload).encode()).hexdigest(), now(), "running", os.getpid(),
                 _canonical(quote) if quote is not None else None),
            )
        return receipt_id

    async def _external(self, payload: dict, execution: ModelExecution):
        if self.synthetic:
            url = os.environ.get("JOBCTRL_E2E_PROVIDER_URL")
            if not url:
                raise AppError("model_unavailable", "The controlled external model provider is not configured.", 503)
            synthetic_boundary(self.workspace, url)
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=120) as client:
                async with client.stream("POST", url, json=payload, headers={"Authorization": f"Bearer {self.synthetic['token']}"}) as response:
                    response.raise_for_status()
                    chunks = bytearray()
                    async for chunk in response.aiter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > 2 * 1024 * 1024:
                            raise AppError("model_output_too_large", "The provider output exceeds its limit.", 502)
                    result = json.loads(chunks)
            return result["value"], result.get("usage", {})
        from jobctrl.app.model_providers import execute_provider

        result = await execute_provider(
            workspace=self.workspace, provider=payload["provider"], model=payload["model"],
            instructions=payload["instructions"], payload={"sources": payload["sources"], "context": payload["context"]},
            response_schema=payload["response_schema"], configuration=execution.configuration(),
        )
        return result.value, dict(input_tokens=result.input_tokens, output_tokens=result.output_tokens,
                                 cost_usd=result.cost_usd, cost_source=result.cost_source,
                                 cost_provenance=getattr(result, "cost_provenance", None))

    async def determine(self, *, operation: str, instructions: str, sources, response_schema: dict,
                        context: dict | None = None, prompt_version: str = "1", lane: str = "interactive",
                        model: str | None = None, require_accounting: bool = False,
                        execution: ModelExecution | None = None) -> ModelResult:
        if type(require_accounting) is not bool:
            raise AppError("invalid_model_request", "Accounting admission must be an explicit boolean.")
        execution = self._execution(execution, model=model)
        payload = self._payload(operation=operation, instructions=instructions, sources=sources,
                                response_schema=response_schema, context=context, prompt_version=prompt_version,
                                lane=lane, execution=execution)
        receipt_id = self._admit(payload, require_accounting=require_accounting)
        usage = {}
        try:
            value, usage = await self._external(payload, execution)
            if not isinstance(value, dict):
                raise AppError("model_schema_violation", "The provider did not return a JSON object.", 502)
            Draft202012Validator(payload["response_schema"]).validate(value)
            encoded = _canonical(value)
            if len(encoded.encode()) > 2 * 1024 * 1024:
                raise AppError("model_output_too_large", "The provider output exceeds its limit.", 502)
        except BaseException as error:
            if isinstance(getattr(error, "usage", None), dict):
                usage = error.usage
            code = error.code if isinstance(error, AppError) else (
                "model_schema_violation" if isinstance(error, (ValidationError, ValueError, KeyError, TypeError))
                else "model_cancelled" if isinstance(error, asyncio.CancelledError) else "model_provider_failed"
            )
            # Even transport failure can follow provider execution. Preserve an
            # uncertain receipt instead of reporting unobserved spend as zero.
            started = getattr(error, "provider_started", None)
            self._settle(receipt_id, "failed" if usage or started is False else "uncertain", usage,
                         error_code=code, provider_started=started)
            if isinstance(error, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
                raise
            raise AppError(code, "The model determination was not accepted; previous accepted work is preserved.", 502,
                           {"receiptId": receipt_id}) from None
        self._settle(receipt_id, "succeeded", usage, result_json=encoded, provider_started=True)
        receipt = self.receipt(receipt_id)
        provenance = {key: receipt[key] for key in (
            "receipt_id", "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at",
        )}
        return ModelResult(value, provenance)

    def _settle(self, receipt_id: str, status: str, usage: dict, *, result_json=None, error_code=None, provider_started=None):
        def amount(name):
            value = usage.get(name)
            if value is None:
                return None
            valid = type(value) is int if name != "cost_usd" else type(value) in {int, float}
            maximum = (2**63 - 1) if name != "cost_usd" else 1000000000
            return value if valid and 0 <= value <= maximum else None
        with self.database.transaction() as connection:
            cost_source = usage.get("cost_source")
            if cost_source not in {"provider_reported", "configured_pricing_estimate", "sdk_estimate"}:
                cost_source = "provider_reported" if self.synthetic and amount("cost_usd") is not None else None
            cost = amount("cost_usd")
            pricing = connection.execute("SELECT pricing_json FROM app_model_calls WHERE receipt_id=?", (receipt_id,)).fetchone()
            quote = json.loads(pricing[0]) if pricing and pricing[0] else None
            if quote and ("configured_quote" in quote or "cost_provenance" in quote):
                quote = quote.get("configured_quote")
            if cost is None and quote and amount("input_tokens") is not None and amount("output_tokens") is not None:
                cost = (amount("input_tokens") * quote["inputUsdPerMillion"]
                        + amount("output_tokens") * quote["outputUsdPerMillion"]) / 1000000
                cost_source = "configured_pricing_estimate"
            provenance = usage.get("cost_provenance")
            keys = {"sdk", "sdk_version", "cli", "cli_version", "pricing_source"}
            if (not isinstance(provenance, dict) or set(provenance) - keys
                    or any(value is not None and (not isinstance(value, str) or len(value) > 200) for value in provenance.values())):
                provenance = None
            pricing_record = {"configured_quote": quote, "cost_provenance": provenance}
            connection.execute(
                "UPDATE app_model_calls SET status=?,completed_at=?,result_json=?,error_code=?,input_tokens=?,output_tokens=?,cost_usd=?,cost_source=?,provider_started=?,pricing_json=? "
                "WHERE receipt_id=? AND status='running'",
                (status, now(), result_json, error_code, amount("input_tokens"), amount("output_tokens"), cost,
                 cost_source, int(provider_started) if type(provider_started) is bool else None,
                 _canonical(pricing_record) if quote is not None or provenance is not None else None, receipt_id),
            )
