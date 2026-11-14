"""Explicit product composition. No discovery, plugins, private SQL or RPC bridge."""

from __future__ import annotations

from collections.abc import Collection
from pathlib import Path

from jobctrl.app.actions import Application
from jobctrl.app.contracts import Runtime
from jobctrl.app.database import Database
from jobctrl.app.errors import AppError
from jobctrl.app.events import EventStore
from jobctrl.app.model import ModelGateway
from jobctrl.app.settings import Settings

FEATURE_NAMES = (
    "profile", "jobs", "requirements", "fit", "resumes", "discovery", "companies",
    "contacts", "outreach", "applications", "interviews", "learning", "digest", "compensation", "offers", "preparation",
)


def create_application(workspace: Path | str, *, enabled_features: Collection[str] | None = None) -> Application:
    selected = set(FEATURE_NAMES if enabled_features is None else enabled_features)
    if selected - set(FEATURE_NAMES):
        raise AppError("unknown_feature", "The composition contains an unknown feature.", 500)
    database = Database(workspace)
    events = EventStore(database)
    settings = Settings(database, events)
    runtime = Runtime(database.workspace, database, settings, events, ModelGateway(database.workspace, database, settings))
    features = []
    services = {}

    def add(feature):
        features.append(feature)
        services[feature.name] = feature.service

    def need(name):
        if name not in services:
            raise AppError("missing_feature_dependency", f"The selected composition requires {name}.", 500)
        return services[name]

    if "profile" in selected:
        from jobctrl.features.profile.bootstrap import build_feature
        add(build_feature(runtime))
    if "jobs" in selected:
        from jobctrl.features.jobs.bootstrap import build_feature
        add(build_feature(runtime))
    if "requirements" in selected:
        from jobctrl.features.requirements.bootstrap import build_feature
        add(build_feature(runtime, jobs=need("jobs")))
    if "fit" in selected:
        from jobctrl.features.fit.bootstrap import build_feature
        add(build_feature(runtime, profile=need("profile"), jobs=need("jobs"), requirements=need("requirements")))
    if "resumes" in selected:
        from jobctrl.features.resumes.bootstrap import build_feature
        add(build_feature(runtime, profile=need("profile"), jobs=need("jobs"), requirements=need("requirements"), fit=need("fit")))
        services["profile"].renderer = services["resumes"].preview_profile
    broker = None
    if "discovery" in selected:
        from jobctrl.extension_transport import ExtensionBroker
        from jobctrl.features.discovery.bootstrap import build_feature
        broker = ExtensionBroker(runtime)
        add(build_feature(runtime, jobs=need("jobs"), profile=services.get("profile"), browser_port=broker))
    if "companies" in selected:
        from jobctrl.features.companies.bootstrap import build_feature
        add(build_feature(runtime, jobs=need("jobs"), discovery=services.get("discovery")))
    if "contacts" in selected:
        from jobctrl.features.contacts.bootstrap import build_feature
        add(build_feature(runtime, jobs=services.get("jobs"), profile=services.get("profile"),
                          discovery=services.get("discovery"), model=runtime.model))
    if "applications" in selected:
        from jobctrl.features.applications.bootstrap import build_feature
        add(build_feature(runtime, profile=need("profile"), jobs=need("jobs"), resumes=need("resumes"), fit=need("fit")))
    if "interviews" in selected:
        from jobctrl.features.interviews.bootstrap import build_feature
        add(build_feature(runtime, profile=need("profile"), jobs=need("jobs"), requirements=services.get("requirements"),
                          fit=services.get("fit"), companies=services.get("companies"),
                          applications=services.get("applications"), resumes=services.get("resumes")))
    if "learning" in selected:
        from jobctrl.features.learning.bootstrap import build_feature
        add(build_feature(runtime, profile=need("profile"), jobs=need("jobs"), requirements=services.get("requirements"), fit=services.get("fit")))
    if "compensation" in selected:
        from jobctrl.features.compensation.bootstrap import build_feature
        add(build_feature(runtime, jobs=need("jobs"), profile=services.get("profile")))
    if "offers" in selected:
        from jobctrl.features.offers.bootstrap import build_feature
        add(build_feature(runtime, jobs=need("jobs"), applications=services.get("applications"), compensation=services.get("compensation")))
    if "outreach" in selected:
        from jobctrl.features.outreach.bootstrap import build_feature
        add(build_feature(runtime, contacts=need("contacts"), profile=need("profile"), jobs=services.get("jobs"),
                          offers=services.get("offers"), compensation=services.get("compensation"),
                          applications=services.get("applications"), model=runtime.model))
    if "digest" in selected:
        from jobctrl.features.digest.bootstrap import build_feature
        add(build_feature(runtime, profile=services.get("profile"), jobs=services.get("jobs"), fit=services.get("fit"),
                          discovery=services.get("discovery"), companies=services.get("companies"),
                          applications=services.get("applications"), interviews=services.get("interviews"),
                          learning=services.get("learning"), resumes=services.get("resumes")))
    if "preparation" in selected:
        from jobctrl.app.preparation_bootstrap import build_feature
        add(build_feature(runtime, profile=need("profile"), jobs=need("jobs"), requirements=need("requirements"),
                          fit=need("fit"), resumes=need("resumes"), discovery=services.get("discovery"),
                          companies=services.get("companies"), compensation=services.get("compensation")))
        # The ordinary search is an application journey across public owners.
        # Discovery remains independently removable and acquisition-only on its
        # own; the complete product retains its existing public search identity.
        preparation_finalizer = features[-1].action_finalizers["preparation.run"]
        preparation_version = features[-1].action_versions["preparation.run"]
        for feature in features:
            if feature.name == "discovery":
                feature.actions["discovery.search"] = services["preparation"].search
                feature.action_finalizers["discovery.search"] = preparation_finalizer
                feature.action_versions["discovery.search"] = preparation_version
    if "jobs" in services:
        jobs = services["jobs"]
        if "fit" in services:
            jobs.bind_fit(services["fit"])
        if "discovery" in services:
            jobs.bind_crawler_settings(services["discovery"].get_crawler_settings)
        for feature in features:
            delete = getattr(feature.service, "delete_job_data", None)
            if feature.name != "jobs" and delete is not None:
                jobs.register_deletion_port(delete)
            after_delete = getattr(feature.service, "after_job_deletion", None)
            if feature.name != "jobs" and after_delete is not None:
                jobs.register_post_commit_deletion_port(after_delete, feature=feature.name)
    application = Application(runtime, features)
    if "preparation" in services:
        services["preparation"].bind_run_reader(application.action_run)
    if "applications" in services:
        services["applications"].set_action_reader(application.list_runs)
        if "interviews" in services:
            services["applications"].feedback.set_interview_preparation(services["interviews"].get_generation)
    application.extension_broker = broker
    if broker is not None:
        broker.bind(application)
    return application
