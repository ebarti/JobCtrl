"""Source-bound structured model calls with one durable lane/spend authority."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path

import httpx
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError

from jobctrl.app.database import Database
from jobctrl.app.errors import AppError, NotFoundError
from jobctrl.app.events import now
from jobctrl.app.settings import Settings
from jobctrl.app.synthetic import synthetic_boundary


@dataclass(frozen=True)
class ModelResult:
    value: dict
    provenance: dict


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

    def selection(self, model: str | None = None) -> dict:
        settings = self.settings.snapshot()
        provider = settings["defaultProvider"]
        if model and ":" in model:
            provider, model = model.split(":", 1)
        if provider not in {"codex", "claude", "google"}:
            raise AppError("model_unavailable", "The configured provider is unavailable.", 503)
        selected = model or settings["providerModels"].get(provider)
        if not isinstance(selected, str) or not selected.strip():
            raise AppError("model_unavailable", "Select a model for this provider.", 503)
        return {"provider": provider, "model": selected}

    def accounting_capability(self, model: str | None = None, *, selection: dict | None = None) -> dict:
        selected = selection or self.selection(model)
        quote = self.settings.get("modelPricingQuotes", {}).get(f"{selected['provider']}:{selected['model']}")
        source = "provider_reported" if self.synthetic else "sdk_estimate" if selected["provider"] == "claude" else "configured_pricing_estimate" if quote is not None else None
        return {**selected, "available": source is not None,
                "costSource": source,
                "pricingQuote": quote}

    def _payload(self, *, operation: str, instructions: str, sources, response_schema: dict,
                 context: dict | None, prompt_version: str, lane: str, selection: dict) -> dict:
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
                     lane=lane, **selection)
        if len(_canonical(value).encode()) > 1024 * 1024:
            raise AppError("model_input_too_large", "The source-bound model input exceeds its limit.", 413)
        return value

    def fingerprint(self, *, operation: str, instructions: str, sources, response_schema: dict,
                    context: dict | None = None, prompt_version: str = "1", lane: str = "interactive",
                    model: str | None = None, selection: dict | None = None) -> str:
        value = self._payload(operation=operation, instructions=instructions, sources=sources,
                              response_schema=response_schema, context=context, prompt_version=prompt_version,
                              lane=lane, selection=selection or self.selection(model))
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
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT lane,COUNT(*) calls,COALESCE(SUM(CAST(input_tokens AS REAL)),0) input_tokens,"
                "COALESCE(SUM(CAST(output_tokens AS REAL)),0) output_tokens,SUM(cost_usd) cost_usd,"
                "SUM(CASE WHEN cost_source IN ('configured_pricing_estimate','sdk_estimate') THEN 1 ELSE 0 END) estimated_calls,"
                "SUM(CASE WHEN provider_started IS NOT 0 AND (status IN ('running','uncertain') OR cost_usd IS NULL "
                "OR input_tokens IS NULL OR output_tokens IS NULL) THEN 1 ELSE 0 END) unresolved "
                "FROM app_model_calls WHERE created_at>=? GROUP BY lane", (now()[:10],)
            ).fetchall()
        complete = not any(row["unresolved"] for row in rows)
        return {"day": now()[:10], "lanes": [dict(row) for row in rows],
                "costUsd": sum(row["cost_usd"] or 0 for row in rows),
                "accountingComplete": complete,
                "costAuthority": "incomplete" if not complete else "includes_estimates" if any(row["estimated_calls"] for row in rows) else "reported"}

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

    async def _external(self, payload: dict):
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
            response_schema=payload["response_schema"], configuration=self.settings.snapshot(),
        )
        return result.value, dict(input_tokens=result.input_tokens, output_tokens=result.output_tokens,
                                 cost_usd=result.cost_usd, cost_source=result.cost_source,
                                 cost_provenance=getattr(result, "cost_provenance", None))

    async def determine(self, *, operation: str, instructions: str, sources, response_schema: dict,
                        context: dict | None = None, prompt_version: str = "1", lane: str = "interactive",
                        model: str | None = None, require_accounting: bool = False) -> ModelResult:
        if type(require_accounting) is not bool:
            raise AppError("invalid_model_request", "Accounting admission must be an explicit boolean.")
        payload = self._payload(operation=operation, instructions=instructions, sources=sources,
                                response_schema=response_schema, context=context, prompt_version=prompt_version,
                                lane=lane, selection=self.selection(model))
        receipt_id = self._admit(payload, require_accounting=require_accounting)
        usage = {}
        try:
            value, usage = await self._external(payload)
            if not isinstance(value, dict):
                raise AppError("model_schema_violation", "The provider did not return a JSON object.", 502)
            Draft202012Validator(response_schema).validate(value)
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
