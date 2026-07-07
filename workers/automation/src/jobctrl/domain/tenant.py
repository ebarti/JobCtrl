"""TenantId value object — scopes all domain entities and events.

In local-first mode TenantId is the singleton constant LOCAL_TENANT ("local").
In hosted multi-tenant mode it is the authenticated user's tenant from JWT.
"""

from __future__ import annotations

from typing import NewType

TenantId = NewType("TenantId", str)

LOCAL_TENANT: TenantId = TenantId("local")
