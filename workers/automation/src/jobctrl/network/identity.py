"""Crawler identity from an explicit public settings snapshot, never a database."""

from __future__ import annotations

from collections.abc import Mapping

import ua_generator
from ua_generator.options import Options

from .ports import HonestUserAgent, default_honest_user_agent


def resolve_honest_user_agent(settings: Mapping[str, object]) -> HonestUserAgent:
    if not isinstance(settings, Mapping):
        raise ValueError("Crawler settings must be supplied explicitly.")
    identity = settings.get("crawl_user_agent")
    if not isinstance(identity, Mapping):
        raise ValueError("Crawler settings require an explicit identity.")
    product, contact = identity.get("product"), identity.get("contact")
    if not isinstance(product, str) or not product.strip():
        raise ValueError("The crawler product identity is unavailable.")
    if contact is not None and not isinstance(contact, str):
        raise ValueError("The crawler contact must be text or explicitly null.")
    if any("\r" in value or "\n" in value for value in (product, contact or "")):
        raise ValueError("The crawler identity contains invalid header characters.")
    return HonestUserAgent(product.strip(), default_honest_user_agent().version, (contact or "").strip() or None)


def resolve_request_headers(settings: Mapping[str, object]) -> dict[str, str]:
    agent = resolve_honest_user_agent(settings)
    identity = settings["crawl_user_agent"]
    if type(identity.get("use_browser_headers")) is not bool:
        raise ValueError("The crawler browser-header setting must be explicit.")
    if identity["use_browser_headers"]:
        generated = ua_generator.generate(device="desktop", browser="chrome", options=Options(latest_versions=True))
        headers = dict(generated.headers.get())
        headers["User-Agent"] = headers.pop("user-agent")
        return headers
    return {"User-Agent": agent.header_value()}
