"""Isolated Codex permissions, environment and joined SDK process lifetime."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from jobctrl.app.provider_support.auth import CODEX_NEUTRALIZED_AUTH_ENV
from jobctrl.app.provider_support.codex_storage import shared_codex_storage


_CODEX_PERMISSION_PROFILE = "jobctrl-analysis-readonly"


_CODEX_STATIC_CONFIG_OVERRIDES = (
    "features.plugins=false",
    "features.apps=false",
    # Employer analysis is a pure structured-generation call. Do not expose a
    # shell to the model, and keep command children empty even if a future SDK
    # or model accidentally contributes one. The app-server itself still
    # receives provider auth through CodexConfig.env.
    "features.shell_tool=false",
    "allow_login_shell=false",
    # Keep SDK project discovery and the kit's native-policy inspection inside
    # the generated workspace, independently of ambient/system root markers.
    'project_root_markers=[".git"]',
    'shell_environment_policy={inherit="none"}',
    f'default_permissions="{_CODEX_PERMISSION_PROFILE}"',
)


def _isolated_codex_env(codex_home: Path, process_home: Path) -> dict[str, str]:
    """Return the minimal env override; the SDK merges this over ``os.environ``."""

    env = {
        "CODEX_HOME": str(codex_home),
        "HOME": str(process_home),
        **{key: "" for key in CODEX_NEUTRALIZED_AUTH_ENV},
        # Codex consumes endpoint overrides literally, including empty strings.
        # Pin provider defaults so refresh works without inheriting a redirect.
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE": "https://auth.openai.com/oauth/token",
        "CODEX_REVOKE_TOKEN_URL_OVERRIDE": "https://auth.openai.com/oauth/revoke",
    }
    if os.name == "nt":
        env["USERPROFILE"] = str(process_home)
    return env


def _codex_permission_profile_override(codex_binary: Path) -> str:
    """Grant the sandbox read access to only the canonical Codex executable.

    The value is a TOML command-line override. JSON string encoding is valid for
    TOML basic strings and prevents a quote or backslash in an operator-provided
    source-install path from changing the surrounding permissions structure.
    """

    quoted_binary = json.dumps(str(codex_binary))
    return (
        f"permissions.{_CODEX_PERMISSION_PROFILE}="
        '{filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"},'
        f"{quoted_binary}=\"read\"}},"
        "network={enabled=false}}"
    )


def _codex_config_overrides(codex_binary: Path) -> tuple[str, ...]:
    """Build the immutable Codex configuration for one canonical executable."""

    return (*_CODEX_STATIC_CONFIG_OVERRIDES, _codex_permission_profile_override(codex_binary))


@asynccontextmanager
async def _codex_client_context(
    async_codex: Any, codex_config: Any, *, configuration: dict[str, Any]
) -> AsyncIterator[Any]:
    """Keep auth stable and share temporary metadata across live native clients.

    Close the app server before removing its private runtime directory, including
    on failed startup, provider errors and cancellation. Never clean up the
    credential home or any pre-existing provider state.
    """

    with (
        shared_codex_storage(Path(configuration["env"]["CODEX_HOME"])) as sqlite_root,
        tempfile.TemporaryDirectory(prefix="jobctrl-codex-runtime-") as runtime_dir,
    ):
        runtime_root = Path(runtime_dir).resolve()
        runtime_configuration = {
            **configuration,
            "config_overrides": (
                *configuration["config_overrides"],
                f"sqlite_home={json.dumps(str(sqlite_root))}",
                f"log_dir={json.dumps(str(runtime_root / 'logs'))}",
            ),
        }
        client = async_codex(config=codex_config(**runtime_configuration))
        # The pinned SDK offloads process creation to a worker thread. Joining
        # just that operation prevents close() racing an unpublished process,
        # while the subsequent local initialize handshake remains cancellable.
        startup = asyncio.create_task(client._client.start())
        request_cancelled = False
        entry_error: BaseException | None = None
        try:
            try:
                # Waiting does not cancel startup or install shield's event-loop
                # exception reporter when the caller is cancelled on Python 3.14.
                try:
                    await asyncio.wait({startup})
                    startup.result()
                    await client.__aenter__()
                except BaseException as error:
                    entry_error = error
                    raise
                yield client
            except asyncio.CancelledError:
                request_cancelled = True
                raise
        finally:
            async def stop() -> None:
                try:
                    try:
                        await startup
                    except BaseException as error:
                        # The startup task must be joined, but re-awaiting an
                        # already observed cancellation can replace its args.
                        same_cancellation = (
                            startup.cancelled()
                            and isinstance(error, asyncio.CancelledError)
                            and isinstance(entry_error, asyncio.CancelledError)
                        )
                        if error is not entry_error and not same_cancellation:
                            raise
                finally:
                    try:
                        await client.close()
                    except Exception:
                        if entry_error is None:
                            raise
                        # A failed managed entry never reaches the kit's
                        # sanitized __aexit__ boundary. Preserve its original
                        # failure and report the secondary cleanup failure.
                        logging.getLogger(__name__).warning('Codex client cleanup failed during startup.')
                    except BaseException as error:
                        if entry_error is None:
                            raise
                        # Cleanup cancellation and fatal control flow must not
                        # be hidden, but their SDK payloads can be private.
                        from jobctrl.app.provider_support.codex import _safe_cleanup_exception

                        safe_error = _safe_cleanup_exception(error)
                        logging.getLogger(__name__).warning('Codex client cleanup failed during startup.')
                        raise safe_error from None

            shutdown = asyncio.create_task(stop())
            interrupted = False
            while not shutdown.done():
                try:
                    await asyncio.wait({shutdown})
                except asyncio.CancelledError:
                    interrupted = True
            try:
                shutdown.result()
            except asyncio.CancelledError:
                raise
            except BaseException:
                if request_cancelled or interrupted:
                    logging.getLogger(__name__).warning("Codex startup or cleanup failed during cancellation.")
                raise
            if interrupted:
                raise asyncio.CancelledError()
