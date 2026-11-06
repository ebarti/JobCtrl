"""Explicit source composition with a fresh network budget per refresh.

Example::

    sources = build_sources(levels_refs=(configured_feed,), levels_token=token)
    service = CompensationService(..., providers=sources.providers)
    rates = sources.rates()                  # one ECB snapshot for this refresh
    price_levels = sources.price_levels(2025)  # fixed Eurostat annual query

The host supplies feed paths, URLs and tokens; nothing here reads environment,
settings, a home directory, or application tables. Levels/Glassdoor adapters
are present but make no request until the source's explicit policy permits it.
Manual imports are present only when explicitly configured. Euro Top Tech is
public and present by default, matching the existing source inventory.

``Provider.load`` returns safe error receipts and partial observations; callers
must not publish a failed lookup as a successful replacement. The convenience
``observations`` method raises ProviderUnavailable on an incomplete receipt.
ECB/Eurostat fetch and parse failures propagate; the application owns reporting,
retry and preservation of the last accepted result.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from jobctrl.features.compensation.core.ports import Classification, Observation, PriceLevel
from jobctrl.features.compensation.providers.common import ProviderLoad
from jobctrl.features.compensation.providers.euro_top_tech import EuroTopTechProvider
from jobctrl.features.compensation.providers.imported import ImportedProvider
from jobctrl.features.compensation.providers.levels_fyi_public import (
    DEFAULT_LEVELS_FYI_PUBLIC_MAX_PAGES,
    LevelsFyiPublicProvider,
)
from jobctrl.features.compensation.providers.network import (
    compensation_feed_client,
    levels_public_text_fetcher,
    licensed_text_fetcher,
)
from jobctrl.features.compensation.providers.official_data import (
    EcbRates,
    load_eurostat_actual_individual_consumption_price_levels,
)
from jobctrl.network import PolitenessGateway


class _PerRefreshProvider:
    """Bind configuration, but create a fresh transport for each lookup."""

    def __init__(self, make_provider: Callable[[], Any]) -> None:
        self._make_provider = make_provider

    def load(self, target: Classification, policy: dict) -> ProviderLoad:
        return self._make_provider().load(target, policy)

    def observations(self, target: Classification, policy: dict) -> tuple[Observation, ...]:
        return self.load(target, policy).require_complete()


@dataclass(frozen=True)
class CompensationSources:
    providers: tuple[tuple[str, _PerRefreshProvider], ...]
    rates: Callable[[], EcbRates]
    price_levels: Callable[[int], tuple[PriceLevel, ...]]


def build_sources(
    *,
    levels_refs: tuple[str | Path, ...] = (),
    glassdoor_refs: tuple[str | Path, ...] = (),
    manual_refs: tuple[str | Path, ...] = (),
    levels_token: str | None = None,
    glassdoor_token: str | None = None,
    levels_public_max_pages: int = DEFAULT_LEVELS_FYI_PUBLIC_MAX_PAGES,
    euro_top_tech_max_pages: int = 10,
    include_euro_top_tech: bool = True,
    gateway: PolitenessGateway | None = None,
    run_id: str | None = None,
    opener: Any | None = None,
) -> CompensationSources:
    """Build bounded source adapters from explicit host configuration."""

    def client(source_id: str):
        return compensation_feed_client(source_id, gateway=gateway, run_id=run_id, opener=opener)

    def levels_public():
        return LevelsFyiPublicProvider(
            levels_public_text_fetcher(client("levels_fyi")), max_pages=levels_public_max_pages
        )

    def levels_licensed():
        return ImportedProvider(
            levels_refs, licensed_text_fetcher(client("levels_fyi")), provider="levels_fyi", token=levels_token
        )

    def glassdoor():
        return ImportedProvider(
            glassdoor_refs, licensed_text_fetcher(client("glassdoor")), provider="glassdoor", token=glassdoor_token
        )

    providers: list[tuple[str, _PerRefreshProvider]] = [
        ("levels_fyi", _PerRefreshProvider(levels_public)),
        ("levels_fyi", _PerRefreshProvider(levels_licensed)),
        ("glassdoor", _PerRefreshProvider(glassdoor)),
    ]
    if manual_refs:
        providers.append(
            (
                "manual_reported_compensation",
                _PerRefreshProvider(lambda: ImportedProvider(manual_refs, licensed_text_fetcher(client("manual")))),
            )
        )
    if include_euro_top_tech:
        providers.append(
            (
                "euro_top_tech",
                _PerRefreshProvider(
                    lambda: EuroTopTechProvider(client("euro_top_tech").fetch_json, max_pages=euro_top_tech_max_pages)
                ),
            )
        )

    rate_snapshot: EcbRates | None = None
    eurostat_client = None

    def rates() -> EcbRates:
        nonlocal rate_snapshot
        if rate_snapshot is None:
            rate_snapshot = EcbRates(client("ecb_daily_xml").fetch_text)
        return rate_snapshot

    def price_levels(reference_year: int) -> tuple[PriceLevel, ...]:
        nonlocal eurostat_client
        if eurostat_client is None:
            eurostat_client = client("eurostat")
        return load_eurostat_actual_individual_consumption_price_levels(
            reference_year=reference_year, fetch_json=eurostat_client.fetch_json
        )

    return CompensationSources(tuple(providers), rates, price_levels)
