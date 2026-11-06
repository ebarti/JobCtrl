"""Compose Offers with public Jobs and optional Applications ports."""

from jobctrl.app.contracts import Feature, Runtime

from .http import routes
from .repository import SqliteOfferRepository
from .schema import SCHEMA
from .service import OffersService


def build_feature(runtime: Runtime, **ports) -> Feature:
    jobs = ports.get("jobs")
    if jobs is None:
        raise ValueError("Offers requires the public Jobs service")
    runtime.database.initialize_feature("offers", SCHEMA)
    repository = SqliteOfferRepository(runtime.database, jobs, ports.get("applications"), runtime.events)
    service = OffersService(repository)
    return Feature(name="offers", service=service, routes=routes(service))
