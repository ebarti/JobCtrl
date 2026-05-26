"""Versioned tailoring policy model for Materials Generation."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping as MappingABC
from dataclasses import dataclass, field
from typing import Any

from jobhunter.domain.tenant import LOCAL_TENANT, TenantId

DEFAULT_TAILORING_POLICY_VERSION = 1


@dataclass(frozen=True)
class TailoringPolicy:
    """Safe, versioned metadata describing one tailoring configuration.

    The policy stores fingerprints and non-sensitive settings only. Raw
    profile, resume, custom prompt, and generated material content stays out of
    this model and out of repository events.
    """

    tenant_id: TenantId = LOCAL_TENANT
    version: int = DEFAULT_TAILORING_POLICY_VERSION
    prompt_version: str = ""
    schema_version: str = ""
    judge_schema_version: str = ""
    prompt_fingerprint: str = ""
    config_fingerprint: str = ""
    profile_policy_fingerprint: str = ""
    custom_prompt_fingerprint: str = ""
    generator_settings: dict[str, Any] = field(default_factory=dict)
    judge_settings: dict[str, Any] = field(default_factory=dict)
    runtime_settings: dict[str, Any] = field(default_factory=dict)
    rollback_of_version: int | None = None
    rollback_reason: str = ""
    created_at: str = ""
    created_from_event_id: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "tenant_id", TenantId(str(self.tenant_id)))
        version = _int_or_default(self.version, 0)
        if version < 0:
            raise ValueError("TailoringPolicy.version must be >= 0")
        object.__setattr__(self, "version", version)
        for name in (
            "prompt_version",
            "schema_version",
            "judge_schema_version",
            "prompt_fingerprint",
            "config_fingerprint",
            "profile_policy_fingerprint",
            "custom_prompt_fingerprint",
            "created_at",
            "rollback_reason",
        ):
            object.__setattr__(self, name, str(getattr(self, name) or "").strip())
        object.__setattr__(self, "generator_settings", _clean_mapping(self.generator_settings))
        object.__setattr__(self, "judge_settings", _clean_mapping(self.judge_settings))
        object.__setattr__(self, "runtime_settings", _clean_mapping(self.runtime_settings))
        if self.rollback_of_version is not None:
            rollback = _int_or_default(self.rollback_of_version, 0)
            if rollback < 1:
                raise ValueError("TailoringPolicy.rollback_of_version must be >= 1")
            object.__setattr__(self, "rollback_of_version", rollback)
        if self.created_from_event_id is not None:
            object.__setattr__(
                self,
                "created_from_event_id",
                _int_or_default(self.created_from_event_id, 0),
            )

    @property
    def policy_id(self) -> str:
        return f"{self.tenant_id}:tailoring-policy-v{self.version}"

    @classmethod
    def from_runtime(
        cls,
        *,
        tenant_id: TenantId,
        version: int,
        prompt_version: str,
        schema_version: str,
        judge_schema_version: str,
        prompt_text: str,
        profile_policy: MappingABC[str, Any] | None,
        custom_prompt: str,
        generator_settings: MappingABC[str, Any] | None,
        judge_settings: MappingABC[str, Any] | None,
        runtime_settings: MappingABC[str, Any] | None,
        created_at: str,
        created_from_event_id: int | None = None,
    ) -> "TailoringPolicy":
        profile_fingerprint = fingerprint_value(profile_policy or {})
        custom_fingerprint = fingerprint_value(custom_prompt or "")
        prompt_fingerprint = fingerprint_value(prompt_text or "")
        generator = _clean_mapping(generator_settings or {})
        judge = _clean_mapping(judge_settings or {})
        runtime = _clean_mapping(runtime_settings or {})
        config_fingerprint = fingerprint_value(
            {
                "prompt_version": prompt_version,
                "schema_version": schema_version,
                "judge_schema_version": judge_schema_version,
                "prompt_fingerprint": prompt_fingerprint,
                "profile_policy_fingerprint": profile_fingerprint,
                "custom_prompt_fingerprint": custom_fingerprint,
                "generator_settings": generator,
                "judge_settings": judge,
                "runtime_settings": runtime,
            }
        )
        return cls(
            tenant_id=tenant_id,
            version=version,
            prompt_version=prompt_version,
            schema_version=schema_version,
            judge_schema_version=judge_schema_version,
            prompt_fingerprint=prompt_fingerprint,
            config_fingerprint=config_fingerprint,
            profile_policy_fingerprint=profile_fingerprint,
            custom_prompt_fingerprint=custom_fingerprint,
            generator_settings=generator,
            judge_settings=judge,
            runtime_settings=runtime,
            created_at=created_at,
            created_from_event_id=created_from_event_id,
        )

    @classmethod
    def from_persistence(
        cls,
        *,
        tenant_id: TenantId,
        version: int,
        prompt_version: str,
        schema_version: str,
        judge_schema_version: str,
        prompt_fingerprint: str,
        config_fingerprint: str,
        profile_policy_fingerprint: str,
        custom_prompt_fingerprint: str,
        generator_settings: MappingABC[str, Any] | None,
        judge_settings: MappingABC[str, Any] | None,
        runtime_settings: MappingABC[str, Any] | None,
        rollback_of_version: int | None,
        rollback_reason: str,
        created_at: str,
        created_from_event_id: int | None,
    ) -> "TailoringPolicy":
        return cls(
            tenant_id=tenant_id,
            version=version,
            prompt_version=prompt_version,
            schema_version=schema_version,
            judge_schema_version=judge_schema_version,
            prompt_fingerprint=prompt_fingerprint,
            config_fingerprint=config_fingerprint,
            profile_policy_fingerprint=profile_policy_fingerprint,
            custom_prompt_fingerprint=custom_prompt_fingerprint,
            generator_settings=dict(generator_settings or {}),
            judge_settings=dict(judge_settings or {}),
            runtime_settings=dict(runtime_settings or {}),
            rollback_of_version=rollback_of_version,
            rollback_reason=rollback_reason,
            created_at=created_at,
            created_from_event_id=created_from_event_id,
        )

    def same_config_as(self, other: "TailoringPolicy") -> bool:
        return self.config_fingerprint == other.config_fingerprint

    def as_artifact_metadata(self) -> dict[str, Any]:
        return {
            "policy_id": self.policy_id,
            "version": self.version,
            "prompt_version": self.prompt_version,
            "schema_version": self.schema_version,
            "judge_schema_version": self.judge_schema_version,
            "prompt_fingerprint": self.prompt_fingerprint,
            "config_fingerprint": self.config_fingerprint,
            "profile_policy_fingerprint": self.profile_policy_fingerprint,
            "custom_prompt_fingerprint": self.custom_prompt_fingerprint,
        }


def fingerprint_value(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _clean_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, MappingABC):
        return {}
    return json.loads(json.dumps(dict(value), sort_keys=True, default=str))


def _int_or_default(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


__all__ = [
    "DEFAULT_TAILORING_POLICY_VERSION",
    "TailoringPolicy",
    "fingerprint_value",
]
