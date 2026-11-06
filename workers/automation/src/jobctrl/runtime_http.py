"""Read-only setup diagnostics composed from public runtime/feature services."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from dataclasses import asdict

from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError


async def setup_status(application, *, credential_service=None):
    from jobctrl.app.providers import ProviderService
    from jobctrl.browser_capabilities import BrowserCapabilityError, list_browser_capabilities

    runtime = application.runtime
    settings = runtime.settings.snapshot()
    providers = await ProviderService(runtime, credentials=credential_service).status()
    try:
        accounting = runtime.model.accounting_capability()
    except AppError as error:
        accounting = {"provider": settings.get("defaultProvider"), "model": None,
                      "available": False, "costSource": None, "pricingQuote": None, "reason": error.code}
    positive_cap = settings.get("dailyBudgetUsd", 0) > 0
    checks = []
    profile = application.services.get("profile")
    if profile is None:
        profile_status = {"status": "disabled", "reason": "profile_feature_disabled"}
    else:
        try:
            snapshot = profile.snapshot()
            document = snapshot.document
            attestations = document.get("application_attestations", {})
            profile_status = {"status": "ready", "revision": snapshot.profile_revision,
                              "roles": len(snapshot.roles), "sources": len(snapshot.evidence_sources),
                              "explicitAttestations": sum(type(value) is bool for value in attestations.values())}
        except AppError as error:
            profile_status = {"status": "missing", "reason": error.code}
    checks.append({"id": "profile", **profile_status})
    try:
        browser_status = [{**asdict(item), "executable": str(item.executable) if item.executable else None}
                          for item in await run_in_threadpool(list_browser_capabilities, app_dir=runtime.workspace)]
    except BrowserCapabilityError:
        browser_status = [{"id": "browser", "status": "failed", "detail": "Browser capability configuration could not be verified."}]
    worker = application.worker_status()
    try:
        client = await asyncio.wait_for(application.temporal(), timeout=2)
        healthy = await asyncio.wait_for(client.service_client.check_health(), timeout=2)
        temporal = {"status": "ready" if healthy else "unavailable"}
    except Exception:
        temporal = {"status": "unavailable", "reason": "temporal_unreachable"}
    checks.extend([
        {"id": "temporal", **temporal},
        {"id": "worker", **worker},
        {"id": "model-policy", "status": "enabled" if settings.get("aiExecutionPolicy", {}).get("enabled") else "disabled",
         "provider": settings.get("defaultProvider"), "dailyBudgetUsd": settings.get("dailyBudgetUsd"),
         "laneTokenLimits": settings.get("laneTokenLimits", {}), "laneConcurrency": settings.get("laneConcurrency", {})},
        {"id": "model-accounting", **accounting, "positiveMonetaryCap": positive_cap,
         "status": "ready" if accounting["available"] or not positive_cap else "blocked",
         "reason": None if accounting["available"] or not positive_cap else "model_accounting_unavailable"},
        {"id": "telemetry", "status": "configured" if all(os.environ.get(key) for key in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")) else "disabled",
         "reason": "configuration_only_no_export_probe"},
    ])
    return {"ok": True, "application": "jobctrl-python", "checks": checks, "providers": providers,
            "browserCapabilities": browser_status, "llmSpend": runtime.model.spend(),
            "externalActions": {"approvalRequired": True, "authorization": "exact-reviewed-payload",
                                "ambiguousOutcome": "requires-reconciliation"}}


def browser_capabilities_snapshot(runtime, *, detect=False):
    from jobctrl.app.synthetic import synthetic_boundary
    from jobctrl.browser_capabilities import (detect_browser_profiles, detect_supported_browsers,
                                              list_browser_capabilities, load_browser_capability_state)

    state = load_browser_capability_state(app_dir=runtime.workspace)
    records = state["capabilities"]
    capabilities = []
    for item in list_browser_capabilities(app_dir=runtime.workspace):
        record = records.get(item.id, {})
        capabilities.append({"id": item.id, "status": item.status, "detail": item.detail[:400],
                             "mutable": item.id != "core-browser", "enabled": item.id == "core-browser" or record.get("enabled", False),
                             "profileCopyReady": bool(record.get("profileCopied") and record.get("profileCopyConsent"))})
    detected = []
    # The synthetic marker forbids inspecting the account holder's browsers or
    # profile metadata. Owned QA may use an explicitly supplied executable.
    if detect and synthetic_boundary(runtime.workspace) is None:
        for browser in detect_supported_browsers():
            profiles = detect_browser_profiles(browser.id)
            detected.append({"id": browser.id, "label": browser.label,
                             "defaultProfileAvailable": any(profile.directory_name == "Default" for profile in profiles),
                             "profiles": [{"id": profile.id, "label": profile.label} for profile in profiles]})
    return {"ok": True, "capabilities": capabilities, "detectedBrowsers": detected}


def build_runtime_routes(application, *, credential_service=None):
    runtime = application.runtime

    async def setup(request):
        return JSONResponse(await setup_status(application, credential_service=credential_service), headers={"cache-control": "no-store"})

    async def browsers(request):
        from jobctrl.browser_capabilities import BrowserCapabilityError
        try:
            value = await run_in_threadpool(browser_capabilities_snapshot, runtime, detect=True)
        except BrowserCapabilityError:
            raise AppError("browser_capability_failed", "The browser capability configuration could not be verified.", 409) from None
        return JSONResponse(value)

    async def mutate_browser(request):
        from jobctrl.app.http import json_object
        from jobctrl.app.synthetic import synthetic_boundary
        from jobctrl.browser_capabilities import (BrowserCapabilityError, disable_browser_capability,
                                                  enable_detected_browser_capability, enable_system_browser_capability)
        body = await json_object(request)
        capability_id = request.path_params["capability_id"]
        if capability_id not in {"auto-apply-browser", "authenticated-linkedin-browser"}:
            raise AppError("browser_capability_failed", "Only an optional browser capability can be changed.")
        try:
            if request.url.path.endswith("/disable"):
                if body:
                    raise AppError("invalid_browser_request", "Disabling a capability accepts an empty object.")
                await run_in_threadpool(disable_browser_capability, capability_id, app_dir=runtime.workspace)
            elif set(body) == {"detectedBrowserId"} and body["detectedBrowserId"] in {"google-chrome", "chromium"}:
                if synthetic_boundary(runtime.workspace) is not None:
                    raise AppError("synthetic_browser_selection_required", "Synthetic QA must supply an owned executable explicitly.", 409)
                await run_in_threadpool(enable_detected_browser_capability, capability_id, body["detectedBrowserId"], app_dir=runtime.workspace)
            elif set(body) == {"executablePath"} and isinstance(body["executablePath"], str) and 0 < len(body["executablePath"]) <= 4096:
                selected = Path(body["executablePath"]).expanduser().resolve()
                if synthetic_boundary(runtime.workspace) is not None and not selected.is_relative_to(runtime.workspace):
                    raise AppError("synthetic_browser_selection_required", "Synthetic QA must select an executable inside its owned workspace.", 409)
                await run_in_threadpool(enable_system_browser_capability, capability_id, selected, app_dir=runtime.workspace)
            else:
                raise AppError("invalid_browser_request", "Choose one detected browser or explicit executable path.")
            return JSONResponse(await run_in_threadpool(browser_capabilities_snapshot, runtime, detect=True))
        except BrowserCapabilityError:
            raise AppError("browser_capability_failed", "The requested browser capability could not be changed.", 409) from None

    async def copy_profile(request):
        from jobctrl.app.http import json_object
        from jobctrl.app.synthetic import synthetic_boundary
        from jobctrl.browser_capabilities import (BrowserCapabilityError, copy_authenticated_linkedin_profile,
                                                  copy_detected_authenticated_linkedin_profile)
        body = await json_object(request)
        if body.get("consent") is not True or body.get("consentMethod") != "explicit-ui-v1":
            raise AppError("browser_profile_consent_required", "An explicit profile-copy choice is required.", 409)
        try:
            if set(body) <= {"detectedBrowserId", "detectedProfileId", "consent", "consentMethod"} and body.get("detectedBrowserId") in {"google-chrome", "chromium"}:
                if synthetic_boundary(runtime.workspace) is not None:
                    raise AppError("synthetic_profile_copy_forbidden", "Synthetic QA cannot inspect account-holder browser profiles.", 409)
                await run_in_threadpool(copy_detected_authenticated_linkedin_profile, body["detectedBrowserId"],
                                        detected_profile_id=body.get("detectedProfileId"), consent=True,
                                        consent_method="explicit-ui-v1", app_dir=runtime.workspace)
            elif set(body) == {"sourceProfilePath", "consent", "consentMethod"} and isinstance(body["sourceProfilePath"], str):
                source = Path(body["sourceProfilePath"]).expanduser().resolve()
                if synthetic_boundary(runtime.workspace) is not None and not source.is_relative_to(runtime.workspace):
                    raise AppError("synthetic_profile_copy_forbidden", "Synthetic QA may copy only a synthetic profile inside its owned workspace.", 409)
                await run_in_threadpool(copy_authenticated_linkedin_profile, source, consent=True,
                                        consent_method="explicit-ui-v1", app_dir=runtime.workspace)
            else:
                raise AppError("invalid_browser_profile_request", "Choose exactly one source browser profile.")
            return JSONResponse(await run_in_threadpool(browser_capabilities_snapshot, runtime, detect=True))
        except BrowserCapabilityError:
            raise AppError("browser_profile_copy_failed", "The requested profile copy could not be completed safely.", 409) from None

    return (
        Route("/v1/setup/status", setup, methods=["GET"]),
        Route("/v1/browser-capabilities", browsers, methods=["GET"]),
        Route("/v1/browser-capabilities/{capability_id}/enable", mutate_browser, methods=["POST"], name="enable-browser-capability"),
        Route("/v1/browser-capabilities/{capability_id}/disable", mutate_browser, methods=["POST"], name="disable-browser-capability"),
        Route("/v1/browser-capabilities/authenticated-linkedin-browser/profile-copy", copy_profile, methods=["POST"]),
    )
