# Shared workspace upgrades

**Status:** The macOS source controller, automatic schema-14-to-15 upgrade,
shared history selection, and source diagnostic interface are implemented in
this checkout. Validation and signed-release qualification remain separate.

## Desired behavior

An installed release and a Git checkout use one workspace by default, including
the same profile, resume, application database, and Temporal history. Starting
a newer compatible build upgrades an older supported schema automatically after
the workspace is safely stopped and backed up. No separate workspace or resume
setup is required. An older build encountering a newer schema refuses with a
clear instruction to update; it never downgrades data automatically. Downloading
a new installed release remains a separate update action.

## Implementation boundaries

1. Give source and installed runtimes the same workspace lifecycle ownership.
   Source startup must participate in the native admission and process scope
   used by release updates, including interruption and detached descendants.
   A listening port, PID file, or SQLite lock alone is not proof that a previous
   runtime has stopped. An unverified legacy runtime must fail closed.
2. Resolve the actual Temporal history as part of the workspace identity. New
   workspaces use the installed path; legacy source histories need a verified,
   interruption-safe adoption path before installed updates can use them. If
   histories conflict or ownership is uncertain, preserve both and explain the
   problem instead of choosing or replacing one.
3. Reuse the native stopped-runtime paired backup and sealed migration/activation
   boundary for both source and installed startup. Preserve acknowledged writes
   and a recovery record across failures; never restore an earlier backup over
   newer live data. The source checkout is a locally trusted build, not a signed
   release receipt, so its authority must be explicit rather than fabricated.
4. Keep a diagnostic UI available for migration and incompatible-version
   failures, with instructions appropriate to the build and condition. Source
   startup provides this interface. The native CLI explains a schema-version
   mismatch before starting a worker; opening the native diagnostic UI remains
   a separate gap. Do not advertise a migration command that does not exist.

Acceptance requires the [schema-15 forward-upgrade checks](../local-reliability-qa.md#schema-15-forward-upgrade)
and real source/installed entry-point tests in owned synthetic workspaces,
including overlapping starts, process loss, legacy history adoption, paired WAL
writes, interrupted activation and retry, and an older installed build after
the upgrade. Signed installer qualification remains a separate release gate.
