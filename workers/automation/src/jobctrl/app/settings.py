"""Revisioned non-secret runtime settings; credentials have a separate boundary."""

from __future__ import annotations

import json
from copy import deepcopy

from jobctrl.app.database import Database
from jobctrl.app.errors import AppError, ConflictError
from jobctrl.app.events import EventStore

DEFAULTS = {
    "defaultProvider": "codex",
    "providerModels": {"codex": "gpt-6", "claude": "claude-opus-4-8", "google": "gemini-3.1-pro-preview"},
    "modelPricingQuotes": {},
    "dailyBudgetUsd": 25,
    "laneTokenLimits": {},
    "laneConcurrency": {},
    "providerConfiguration": {},
    "resumeMode": "tailored",
    "aiExecutionPolicy": {"enabled": True},
    "workerActivitySlots": 4,
    "applyConcurrency": 1,
    "applyMaxBudgetUsd": 5,
    "applyTimeoutSeconds": 900,
    "applyAutomationEnabled": False,
    "applyAutomationIntervalMinutes": 5,
    "compensationAutomationEnabled": True,
    "codexReasoningEfforts": {},
    "minFitScore": 7,
    "scoreCriteria": "",
    "targetCriteria": "",
}
PROVIDER_CONFIGURATION_KEYS = frozenset({
    "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "ANTHROPIC_AWS_WORKSPACE_ID",
    "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_RESOURCE", "AWS_REGION", "AWS_PROFILE",
    "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
})


class Settings:
    def __init__(self, database: Database, events: EventStore):
        self.database = database
        self.events = events
        with database.transaction() as connection:
            connection.execute("INSERT OR IGNORE INTO app_settings VALUES(1,1,?)", (json.dumps(DEFAULTS),))

    def snapshot(self, connection=None) -> dict:
        if connection is None:
            with self.database.connect() as owned:
                return self.snapshot(owned)
        row = connection.execute("SELECT revision,value_json FROM app_settings WHERE id=1").fetchone()
        return {**json.loads(row["value_json"]), "revision": row["revision"]}

    def get(self, key: str, default=None):
        return self.snapshot().get(key, default)

    def update(self, patch: dict, *, expected_revision: int, connection=None) -> dict:
        if not isinstance(patch, dict) or set(patch) - set(DEFAULTS):
            raise AppError("invalid_settings", "Settings contain an unsupported field.")
        if type(expected_revision) is not int:
            raise AppError("expected_revision_required", "A saved settings revision is required.", 428)
        if connection is None:
            with self.database.transaction() as owned:
                return self.update(patch, expected_revision=expected_revision, connection=owned)
        if not connection.in_transaction:
            raise RuntimeError("Settings changes require a canonical write transaction")
        saved = self.snapshot(connection)
        if saved.pop("revision") != expected_revision:
            raise ConflictError()
        value = {**saved, **deepcopy(patch)}
        self._validate(value)
        connection.execute("UPDATE app_settings SET revision=revision+1,value_json=? WHERE id=1", (json.dumps(value),))
        self.events.append(connection, "SettingsUpdated", {"revision": expected_revision + 1}, feature="settings")
        return self.snapshot(connection)

    @staticmethod
    def _validate(value: dict) -> None:
        if not isinstance(value["defaultProvider"], str) or value["defaultProvider"] not in {"codex", "claude", "google"}:
            raise AppError("invalid_provider", "Choose a supported provider.")
        models = value["providerModels"]
        if not isinstance(models, dict) or set(models) - {"codex", "claude", "google"} or any(
            not isinstance(item, str) or not item.strip() or len(item) > 200 for item in models.values()
        ):
            raise AppError("invalid_models", "Provider models must be explicit model identifiers.")
        quotes = value["modelPricingQuotes"]
        if not isinstance(quotes, dict) or len(quotes) > 100:
            raise AppError("invalid_pricing_quotes", "Supply at most 100 exact provider/model pricing quotes.")
        for key, quote in quotes.items():
            provider, separator, model = key.partition(":") if isinstance(key, str) else ("", "", "")
            if provider not in {"codex", "claude", "google"} or not separator or not model or len(model) > 200:
                raise AppError("invalid_pricing_quotes", "Pricing keys must name an exact provider:model identifier.")
            if not isinstance(quote, dict) or set(quote) != {"inputUsdPerMillion", "outputUsdPerMillion", "source", "revision"}:
                raise AppError("invalid_pricing_quotes", "A pricing quote requires input/output USD rates, source and revision.")
            for field in ("inputUsdPerMillion", "outputUsdPerMillion"):
                if type(quote[field]) not in {int, float} or not 0 <= quote[field] <= 1000000:
                    raise AppError("invalid_pricing_quotes", "Pricing rates must be finite nonnegative USD amounts.")
            if any(not isinstance(quote[field], str) or not quote[field].strip() or len(quote[field]) > 500
                   for field in ("source", "revision")):
                raise AppError("invalid_pricing_quotes", "Keep the exact source and revision of each pricing quote.")
        budget = value["dailyBudgetUsd"]
        if type(budget) not in {float, int} or not 0 <= budget <= 100000:
            raise AppError("invalid_budget", "The daily budget must be a nonnegative amount.")
        for key, minimum, maximum in (("laneConcurrency", 1, 32), ("laneTokenLimits", 0, 1000000000)):
            limits = value[key]
            if not isinstance(limits, dict) or any(
                not isinstance(name, str) or not name or type(limit) is not int or not minimum <= limit <= maximum
                for name, limit in limits.items()
            ):
                raise AppError("invalid_lane_settings", "Lane limits are invalid.")
        configuration = value["providerConfiguration"]
        if not isinstance(configuration, dict) or set(configuration) - PROVIDER_CONFIGURATION_KEYS or any(
            not isinstance(item, str) or len(item) > 4096 for item in configuration.values()
        ):
            raise AppError("invalid_provider_configuration", "Provider configuration contains an unsupported value.")
        if not isinstance(value["resumeMode"], str) or value["resumeMode"] not in {"baseline", "tailored"}:
            raise AppError("invalid_resume_mode", "Choose baseline or tailored resumes.")
        policy = value["aiExecutionPolicy"]
        if not isinstance(policy, dict) or set(policy) != {"enabled"} or type(policy["enabled"]) is not bool:
            raise AppError("invalid_execution_policy", "AI execution policy must state whether it is enabled.")
        for key, minimum, maximum in (("workerActivitySlots", 1, 64), ("applyConcurrency", 1, 8),
                                      ("applyTimeoutSeconds", 30, 7200), ("minFitScore", 1, 10),
                                      ("applyAutomationIntervalMinutes", 1, 1440)):
            if type(value[key]) is not int or not minimum <= value[key] <= maximum:
                raise AppError("invalid_settings", f"{key} must be an integer from {minimum} to {maximum}.")
        if any(type(value[key]) is not bool for key in ("applyAutomationEnabled", "compensationAutomationEnabled")):
            raise AppError("invalid_settings", "Automation controls must be explicitly enabled or disabled.")
        amount = value["applyMaxBudgetUsd"]
        if type(amount) not in {int, float} or not 0 <= amount <= 10000:
            raise AppError("invalid_settings", "The Apply call budget must be a nonnegative amount.")
        for key in ("scoreCriteria", "targetCriteria"):
            if not isinstance(value[key], str) or len(value[key]) > 20000:
                raise AppError("invalid_settings", "Saved criteria must be text of at most 20,000 characters.")
        efforts = value["codexReasoningEfforts"]
        if not isinstance(efforts, dict) or any(
            not isinstance(model, str) or not model or len(model) > 200
            or not isinstance(effort, str) or effort not in {"low", "medium", "high", "xhigh", "max"} for model, effort in efforts.items()
        ):
            raise AppError("invalid_settings", "Codex reasoning efforts must name supported effort levels for explicit models.")
