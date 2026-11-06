"""Immutable Profile identity and copied document supplied through its public port."""

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from jobctrl.semantic.identifiers import TenantId


@dataclass(frozen=True)
class ProfileSnapshot:
    tenant_id: TenantId
    profile_id: str
    version: int
    _data: dict[str, Any] = field(repr=False)

    def as_dict(self) -> dict[str, Any]:
        return deepcopy(self._data)
