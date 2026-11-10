"""Small transport/composition records; feature domains own their protocols."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from starlette.routing import BaseRoute
    from jobctrl.app.database import Database
    from jobctrl.app.events import EventStore
    from jobctrl.app.model import ModelGateway
    from jobctrl.app.settings import Settings


@dataclass(frozen=True)
class ActionContext:
    run_id: str
    request_id: str
    cancelled: Callable[[], bool] = lambda: False
    heartbeat: Callable[[dict | None], None] = lambda details=None: None


ActionHandler = Callable[[ActionContext, dict], Awaitable[Any]]


@dataclass(frozen=True)
class Runtime:
    workspace: Path
    database: Database
    settings: Settings
    events: EventStore
    model: ModelGateway


@dataclass(frozen=True)
class Feature:
    name: str
    service: object
    routes: tuple[BaseRoute, ...] = ()
    actions: dict[str, ActionHandler] = field(default_factory=dict)
    # Optional, pure payload validators/keys for actions that must have one
    # active admission per feature-owned scope, including queued work.
    action_scopes: dict[str, Callable[[dict], str]] = field(default_factory=dict)
    # Transport terminalization and its owning feature receipt share a commit.
    # The callback is a feature adapter, not a domain/database dependency.
    action_finalizers: dict[str, Callable[[str, str, str | None, Any], None]] = field(default_factory=dict)
