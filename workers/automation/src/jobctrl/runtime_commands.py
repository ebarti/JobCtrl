"""Native credentials/browser capability adapters, without business/database bootstrap."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

console = Console()
capability_app = typer.Typer(help="Inspect and explicitly manage optional browser capabilities.")
credentials_app = typer.Typer(help="Manage provider credentials in the operating system native store.")

@credentials_app.command("migrate")
def migrate_credentials(
    env_file: list[Path] = typer.Option(
        [],
        "--env-file",
        help="Exact persistent env file to migrate; repeat for launcher precedence order.",
    ),
    marker: Optional[Path] = typer.Option(
        None,
        "--marker",
        help="Secret-free completion marker path (defaults under JOBCTRL_DIR).",
    ),
) -> None:
    """Move allowlisted persistent provider secrets into the native store once."""

    from jobctrl.native_runtime_config import get_env_path, workspace_path
    from jobctrl.native_credentials import NativeCredentialError, NativeCredentialMigrationError
    from jobctrl.app.credentials import CredentialService
    from jobctrl.app.errors import AppError
    from jobctrl.cli import _application, _fail
    from jobctrl.runtime import is_bundled_runtime

    selected_workspace = workspace_path()
    if selected_workspace.is_symlink() or not selected_workspace.is_dir():
        _fail("workspace_missing", "Credential migration requires an existing selected workspace.")
    paths = list(env_file)
    if not paths:
        paths.append(get_env_path(app_dir=selected_workspace))
        if not is_bundled_runtime():
            cwd_env = Path.cwd() / ".env"
            if cwd_env not in paths:
                paths.append(cwd_env)
            configured = os.environ.get("JOBCTRL_USER_ENV_PATH", "").strip()
            configured_path = Path(configured).expanduser() if configured else Path.home() / "JobCtrl" / ".env"
            if configured_path not in paths:
                paths.append(configured_path)
    marker_path = marker or (selected_workspace / ".native-credentials-migrated.json")
    try:
        result = CredentialService(_application().runtime).migrate_persistent_env(paths, marker_path)
    except (NativeCredentialMigrationError, NativeCredentialError, AppError) as exc:
        console.print(f"[red]Credential migration failed:[/red] {exc}")
        raise typer.Exit(code=1) from exc
    except (OSError, UnicodeError) as exc:
        console.print(
            "[red]Credential migration failed:[/red] credential sources could not be inspected safely; no migration was completed."
        )
        raise typer.Exit(code=1) from exc
    if result.already_completed:
        console.print("Credential migration already completed; no files or native entries changed.")
        return
    console.print(
        f"Credential migration completed: {len(result.migrated_keys)} native entr"
        f"{'y' if len(result.migrated_keys) == 1 else 'ies'}, {len(result.source_files)} source file(s) inspected."
    )


@capability_app.command("list")
def capability_list() -> None:
    """Show managed core and optional authenticated-browser readiness."""

    from jobctrl.browser_capabilities import list_browser_capabilities

    table = Table(title="JobCtrl browser capabilities")
    table.add_column("Capability")
    table.add_column("Status")
    table.add_column("Details")
    marks = {
        "ready": "[green]READY[/green]",
        "disabled": "[dim]DISABLED[/dim]",
        "missing": "[yellow]MISSING[/yellow]",
        "failed": "[red]FAILED[/red]",
        "unavailable": "[red]UNAVAILABLE[/red]",
    }
    for capability in list_browser_capabilities():
        detail = capability.detail
        if capability.executable is not None:
            detail = f"{detail} {capability.executable}"
        table.add_row(capability.id, marks[capability.status], detail)
    console.print(table)


@capability_app.command("enable")
def capability_enable(
    name: str = typer.Argument(..., help="Capability to enable."),
    browser_path: Path | None = typer.Option(
        None,
        "--browser-path",
        help="Explicit Chrome or Chromium executable to adopt.",
    ),
    managed_pack: bool = typer.Option(
        False,
        "--managed-pack",
        help="Request a managed browser pack (currently unavailable; nothing is downloaded).",
    ),
    copy_profile_from: Path | None = typer.Option(
        None,
        "--copy-profile-from",
        help="Existing profile to copy into JobCtrl-owned LinkedIn resolver storage.",
    ),
    consent_copy_profile: bool = typer.Option(
        False,
        "--consent-copy-profile",
        help="Affirm separately that JobCtrl may copy the supplied browser profile.",
    ),
    yes: bool = typer.Option(False, "--yes", "-y", help="Accept safe non-profile prompts."),
    non_interactive: bool = typer.Option(False, "--non-interactive", help="Do not prompt."),
) -> None:
    """Enable an optional browser only after choosing its executable explicitly."""

    from jobctrl.browser_capabilities import (
        BrowserCapabilityError,
        BrowserCapabilityUnavailableError,
        copy_authenticated_linkedin_profile,
        enable_system_browser_capability,
        managed_optional_browser_pack_unavailable,
    )

    if copy_profile_from is not None and name != "authenticated-linkedin-browser":
        console.print("[red]Profile copying is only available for authenticated-linkedin-browser.[/red]")
        raise typer.Exit(code=2)
    if consent_copy_profile and copy_profile_from is None:
        console.print("[red]--consent-copy-profile requires --copy-profile-from.[/red]")
        raise typer.Exit(code=2)
    if managed_pack and browser_path is not None:
        console.print("[red]Choose either --managed-pack or --browser-path, not both.[/red]")
        raise typer.Exit(code=2)
    if managed_pack:
        try:
            managed_optional_browser_pack_unavailable(name)
        except BrowserCapabilityUnavailableError as exc:
            console.print(f"[yellow]{exc}[/yellow]")
            raise typer.Exit(code=2) from exc

    if browser_path is None:
        if non_interactive or yes:
            console.print(
                "[red]Enabling a browser capability requires --browser-path with an explicit Chrome/Chromium executable.[/red]"
            )
            raise typer.Exit(code=2)
        source = typer.prompt("Browser source (system or managed-pack)", default="system").strip().lower()
        if source == "managed-pack":
            try:
                managed_optional_browser_pack_unavailable(name)
            except BrowserCapabilityUnavailableError as exc:
                console.print(f"[yellow]{exc}[/yellow]")
                raise typer.Exit(code=2) from exc
        if source != "system":
            console.print("[red]Choose system or managed-pack.[/red]")
            raise typer.Exit(code=2)
        browser_path = Path(typer.prompt("Chrome/Chromium executable path")).expanduser()

    if copy_profile_from is not None and not consent_copy_profile:
        # ``--yes`` is deliberately not accepted as profile-copy consent.
        if yes or non_interactive:
            console.print(
                "[red]Copying an existing browser profile requires --consent-copy-profile; --yes cannot grant this consent.[/red]"
            )
            raise typer.Exit(code=2)
        consent_copy_profile = typer.confirm(
            "Copy this existing browser profile into JobCtrl-owned storage?",
            default=False,
        )
        if not consent_copy_profile:
            console.print(
                "[yellow]Browser capability was not enabled because profile-copy consent was not granted.[/yellow]"
            )
            raise typer.Exit(code=2)

    try:
        status = enable_system_browser_capability(name, browser_path)
        if copy_profile_from is not None:
            destination = copy_authenticated_linkedin_profile(
                copy_profile_from,
                consent=consent_copy_profile,
            )
            console.print(f"[green]{name} ready.[/green] Profile copied to JobCtrl-owned storage: {destination}")
        else:
            level = "green" if status.status == "ready" else "yellow"
            console.print(f"[{level}]{name} {status.status}.[/{level}] {status.detail}")
            if name == "authenticated-linkedin-browser":
                console.print(
                    "[yellow]A separate consented profile copy is still required before authenticated LinkedIn resolution can run.[/yellow]"
                )
    except BrowserCapabilityError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=2) from exc


@capability_app.command("disable")
def capability_disable(name: str = typer.Argument(..., help="Optional capability to disable.")) -> None:
    """Disable an optional authenticated-browser capability immediately."""

    from jobctrl.browser_capabilities import BrowserCapabilityError, disable_browser_capability

    try:
        status = disable_browser_capability(name)
    except BrowserCapabilityError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=2) from exc
    console.print(f"[green]{name} {status.status}.[/green] {status.detail}")


def provider_pack_install(
    pack: str = typer.Option(..., "--pack", help="Provider-pack id selected from the signed lock."),
) -> None:
    """Internal launcher hook for installing a hash-pinned provider pack."""

    from jobctrl.native_runtime_config import workspace_path
    from jobctrl.provider_packs import (
        ProviderPackError,
        install_provider_pack,
        load_provider_pack_spec,
    )
    from jobctrl.runtime import is_bundled_runtime, payload_path

    if not is_bundled_runtime():
        console.print("[red]Provider packs are managed only by the installed JobCtrl launcher.[/red]")
        raise typer.Exit(code=2)
    try:
        # The lock is part of the signed, manifest-covered payload. Never accept
        # a caller-selected lock whose hashes merely authenticate attacker-chosen
        # wheels.
        lock = payload_path("release/provider-packs.lock.json", require_exists=True)
        installed = install_provider_pack(
            load_provider_pack_spec(lock, pack_id=pack),
            app_dir=workspace_path(),
        )
    except ProviderPackError as exc:
        console.print(f"[red]Provider pack installation failed:[/red] {exc}")
        raise typer.Exit(code=1) from exc
    console.print_json(data={"installed": True, "path": str(installed)})
