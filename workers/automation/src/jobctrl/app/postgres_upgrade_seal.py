"""Native cutover custody for the retained canonical SQLite source, on macOS."""

from contextlib import contextmanager, nullcontext
import json
import os
import stat
import subprocess
import sys
import tempfile

from jobctrl.app.postgres_upgrade_source import UpgradeError, canonical, exclude_source_writers, require, source_files

JOURNAL = ".jobctrl-sqlite-seal.json"


def _sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class SourceSeal:
    def __init__(self, path, fd):
        self.source = path
        self.fd = fd
        self.journal = path.parent / JOURNAL
        self.record = None
        self.applied = False
        self.writer_pid = None
        if self.journal.is_symlink() or self.journal.exists():
            with os.fdopen(os.open(self.journal, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
                info = os.fstat(stream.fileno())
                require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                        and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 2048, "unsafe_source_seal_journal")
                self.record = json.load(stream)
            info = os.fstat(fd)
            require(set(self.record) == {"version", "source_device", "source_inode", "original_mode", "target_instance"} and
                    self.record["version"] == 1 and self.record["source_device"] == info.st_dev and
                    self.record["source_inode"] == info.st_ino and self.record["original_mode"] in {0o600, 0o700},
                    "source_seal_journal_mismatch")

    def exclusive(self):
        info = os.fstat(self.fd)
        named, companions = source_files(self.source)
        require((info.st_dev, info.st_ino) == named and stat.S_IMODE(info.st_mode) == 0o400, "sqlite_source_seal_changed")
        paths = [str(self.source), *(str(self.source) + suffix for suffix in companions)]
        try:
            result = subprocess.run(["/usr/sbin/lsof", "-nP", "-Fp", "--", *paths], capture_output=True, timeout=15)
        except (subprocess.TimeoutExpired, OSError):
            raise UpgradeError("sqlite_source_descriptor_inspection_failed") from None
        allowed = {f"p{os.getpid()}".encode()}
        if self.writer_pid is not None:
            allowed.add(f"p{self.writer_pid}".encode())
        records = result.stdout.splitlines()
        # Darwin lsof emits descriptor ('f') records even with -Fp.
        processes = {line for line in records if line.startswith(b"p")}
        require(result.returncode == 0 and processes == allowed and
                all(line.startswith((b"p", b"f")) for line in records),
                "sqlite_source_descriptor_busy_or_unknown")

    def bind(self, instance):
        if self.record is not None:
            require(self.record["target_instance"] == instance, "source_seal_target_mismatch")

    def apply(self, instance):
        self.bind(instance)
        info = os.fstat(self.fd)
        mode = stat.S_IMODE(info.st_mode)
        if self.record is None:
            require(mode in {0o600, 0o700}, "source_seal_original_mode_unknown")
            record = {"version": 1, "source_device": info.st_dev, "source_inode": info.st_ino,
                      "original_mode": mode, "target_instance": instance}
            # Publish the recovery record durably before changing access.
            with tempfile.NamedTemporaryFile(dir=self.source.parent, prefix=".jobctrl-sqlite-seal-", delete=False) as stage:
                try:
                    stage.write(canonical(record).encode())
                    stage.flush()
                    os.fsync(stage.fileno())
                    # The native selector lock and predecessor writer lock
                    # serialize the first publication of this private journal.
                    os.replace(stage.name, self.journal)
                finally:
                    if os.path.lexists(stage.name):
                        os.unlink(stage.name)
            _sync_directory(self.source.parent)
            self.record = record
        require(mode in (0o400, self.record["original_mode"]), "source_seal_mode_changed")
        if mode != 0o400:
            os.fchmod(self.fd, 0o400)
            self.applied = True
            os.fsync(self.fd)
        self.exclusive()

    def restore_before_publication(self):
        if self.applied:
            os.fchmod(self.fd, self.record["original_mode"])
            os.fsync(self.fd)
            self.applied = False

    def recover_failed_commit(self, workspace, database_url):
        # Lock the same target before restoring access. An acknowledged or
        # ambiguous publication keeps the predecessor sealed for forward retry.
        if not self.applied:
            return
        from jobctrl.app.database import Database
        from contextlib import closing
        try:
            with closing(Database(workspace, database_url=database_url, staging=True)) as staged, staged.transaction():
                self.bind(staged.instance_id)
                self.restore_before_publication()
        except Exception:
            pass  # The recorded recovery tuple and read-only source survive.


@contextmanager
def sealed_writer_fence(path, database_url):
    require(sys.platform == "darwin", "native_sqlite_sealing_requires_macos")
    identity, _ = source_files(path)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        info = os.fstat(stream.fileno())
        require(identity == (info.st_dev, info.st_ino), "sqlite_source_changed")
        seal = SourceSeal(path, stream.fileno())
        if stat.S_IMODE(info.st_mode) == 0o400:
            require(seal.record is not None, "source_seal_original_mode_unknown")
            seal.exclusive()
            guard = nullcontext()
        else:
            guard = exclude_source_writers(path)
        with guard as fence:
            seal.writer_pid = fence.process.pid if fence is not None else None
            try:
                yield seal
            except BaseException:
                seal.recover_failed_commit(path.parent, database_url)
                raise
