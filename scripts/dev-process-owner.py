#!/usr/bin/env python3
"""Retain original source child custody; recovered PIDs never authorize signals."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time

SOURCE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SOURCE / "workers/automation/src"))
from jobctrl.infrastructure.process_ownership import (  # noqa: E402
    ProcessOwnershipError,
    _cleanup_deadline,
    _waitid_nowait,
    terminate_owned_process,
)

NAMES = {"temporal", "api", "web", "worker", "docs", "demo-api", "demo-web"}


class Unverified(RuntimeError):
    pass


def read_regular(path: Path) -> bytes:
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid() or before.st_size > 4096:
        raise Unverified()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        after = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise Unverified()
        return stream.read(4097)


def atomic_write(path: Path, value: bytes) -> None:
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as stream:
        os.chmod(stream.name, 0o600)
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
        temporary = stream.name
    os.replace(temporary, path)


@contextmanager
def lock(directory: Path, name: str):
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise Unverified()
    fd = os.open(directory / f"{name}.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            raise Unverified()
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def files(directory: Path, name: str):
    return directory / f"{name}.pid", directory / f"{name}.identity.json"


def receipt(directory: Path, name: str, expected: str | None = None):
    pid_file, identity_file = files(directory, name)
    if not any(os.path.lexists(p) for p in (pid_file, identity_file)):
        return None
    try:
        pid = read_regular(pid_file).decode("ascii").strip()
        value = json.loads(read_regular(identity_file))
        required = {"version", "sourceRoot", "component", "id", "pid", "socket", "state"}
        if (not isinstance(value, dict) or set(value) != required or value["version"] != 1
                or value["sourceRoot"] != str(SOURCE) or value["component"] != name
                or type(value["pid"]) is not int or value["pid"] <= 1 or pid != str(value["pid"])
                or not isinstance(value["id"], str) or len(value["id"]) != 64
                or any(c not in "0123456789abcdef" for c in value["id"])
                or value["state"] not in {"running", "stopped"}
                or not isinstance(value["socket"], str) or not Path(value["socket"]).is_absolute()
                or (expected is not None and value["id"] != expected)):
            raise Unverified()
        return value
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise Unverified() from error


def send(channel: socket.socket, value: dict) -> None:
    channel.sendall(json.dumps(value).encode() + b"\n")


def receive(channel: socket.socket) -> dict:
    value = bytearray()
    while len(value) <= 1024:
        part = channel.recv(1)
        if not part:
            raise Unverified()
        if part == b"\n":
            result = json.loads(value)
            if not isinstance(result, dict):
                raise Unverified()
            return result
        value.extend(part)
    raise Unverified()


def proof(secret: str, text: str) -> str:
    return hmac.new(bytes.fromhex(secret), text.encode(), hashlib.sha256).hexdigest()


@contextmanager
def at_directory(directory: Path):
    # Relative AF_UNIX addresses avoid macOS's short socket-path limit while
    # keeping the private endpoint inside the selected synthetic/temp root.
    previous = os.open(".", os.O_RDONLY)
    try:
        os.chdir(directory)
        yield
    finally:
        os.fchdir(previous)
        os.close(previous)


def request(value: dict, action: str) -> dict:
    # Authenticate the live launch owner before sending a stop request. A stale
    # PID or socket path cannot turn another process into a signal target.
    with socket.socket(socket.AF_UNIX) as channel:
        channel.settimeout(20 if action == "stop" else 1)
        endpoint = Path(value["socket"])
        with at_directory(endpoint.parent):
            channel.connect(endpoint.name)
        challenge = secrets.token_hex(32)
        send(channel, {"jobctrlSourceOwner": challenge})
        answer = receive(channel)
        if answer.get("pid") != value["pid"] or not hmac.compare_digest(str(answer.get("proof")), proof(value["id"], challenge)):
            raise Unverified()
        send(channel, {"action": action, "proof": proof(value["id"], challenge + ":" + action)})
        return receive(channel)


def state(value) -> str:
    if value is None or value["state"] == "stopped":
        return "down"
    answer = request(value, "state")
    return "up" if answer == {"state": "running"} else "unverified"


def retire(directory: Path, name: str, value: dict) -> None:
    current = receipt(directory, name, value["id"])
    if current is None or current["state"] != "stopped":
        raise Unverified()
    for file in files(directory, name):
        file.unlink()


def launch(directory: Path, name: str, secret: str, command: str, log: str | None) -> int:
    if len(secret) != 64 or any(c not in "0123456789abcdef" for c in secret):
        raise Unverified()
    control = Path(tempfile.mkdtemp(prefix="jobctrl-dev-owner-"))
    endpoint = control / "control"
    listener = socket.socket(socket.AF_UNIX)
    with at_directory(control):
        listener.bind(endpoint.name)
    endpoint_identity = endpoint.lstat()
    listener.listen(4)
    listener.settimeout(0.1)
    value = {"version": 1, "sourceRoot": str(SOURCE), "component": name,
             "id": secret, "pid": os.getpid(), "socket": str(endpoint), "state": "running"}
    with lock(directory, name):
        if any(os.path.lexists(p) for p in files(directory, name)):
            raise Unverified()
        pid_file, identity_file = files(directory, name)
        atomic_write(identity_file, json.dumps(value).encode())
        atomic_write(pid_file, f"{os.getpid()}\n".encode())
    stopping = False
    failed = False

    def on_signal(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    # Keep this exact child unreaped. Only the launch-owning process can use
    # the existing original-handle/session termination helper.
    child = subprocess.Popen(["bash", "-c", command], cwd=SOURCE, start_new_session=True,
                             stdout=subprocess.PIPE if log is not None else None,
                             stderr=subprocess.STDOUT if log is not None else None)
    child_pid = child.pid
    output = None
    if log is not None:
        def forward_output():
            console = True
            with open(log, "ab") as stream:
                for line in child.stdout:
                    stream.write(line)
                    stream.flush()
                    if console:
                        try:
                            sys.stdout.buffer.write(f"[{name}] ".encode() + line)
                            sys.stdout.buffer.flush()
                        except OSError:
                            console = False
        output = threading.Thread(target=forward_output, daemon=True)
        output.start()

    def cleanup() -> bool:
        nonlocal failed
        budget = _cleanup_deadline.set(time.monotonic() + 16)
        try:
            terminate_owned_process(child, launched_pid=child_pid)
            if output is not None:
                output.join(timeout=1)
                if output.is_alive():
                    raise Unverified()
            with lock(directory, name):
                if receipt(directory, name, secret) != value:
                    raise Unverified()
                current = endpoint.lstat()
                if (current.st_dev, current.st_ino) != (endpoint_identity.st_dev, endpoint_identity.st_ino):
                    raise Unverified()
                endpoint.unlink()
                control.rmdir()
                stopped = {**value, "state": "stopped"}
                atomic_write(identity_file, json.dumps(stopped).encode())
                value.update(stopped)
            return True
        except (ProcessOwnershipError, OSError, Unverified, subprocess.TimeoutExpired):
            failed = True
            print(f"dev: {name} cleanup failed; ownership records retained for review or retry.", file=sys.stderr, flush=True)
            return False
        finally:
            _cleanup_deadline.reset(budget)

    while True:
        # WNOWAIT observes natural completion without releasing the original
        # PID. No poll()/wait() may transfer authority to a reused PID here.
        try:
            event = None if child.returncode is not None else _waitid_nowait(child_pid)
        except (OSError, ChildProcessError, ProcessOwnershipError, AttributeError):
            event = None
            if not failed:
                print(f"dev: {name} child inspection failed; ownership records retained.", file=sys.stderr, flush=True)
            failed = True
        natural_exit = event is not None and event.si_code in (os.CLD_EXITED, os.CLD_KILLED, os.CLD_DUMPED)
        if stopping or (natural_exit and not failed):
            stopping = False
            if cleanup():
                return child.returncode or 0
        try:
            connection, _ = listener.accept()
        except socket.timeout:
            continue
        with connection:
            try:
                connection.settimeout(1)
                challenge = receive(connection).get("jobctrlSourceOwner")
                if not isinstance(challenge, str) or len(challenge) != 64:
                    raise Unverified()
                send(connection, {"pid": os.getpid(), "proof": proof(secret, challenge)})
                query = receive(connection)
                action = query.get("action")
                if not isinstance(action, str) or action not in {"state", "stop"} or not hmac.compare_digest(str(query.get("proof")), proof(secret, challenge + ":" + action)):
                    raise Unverified()
                if action == "state":
                    send(connection, {"state": "cleanup_failed" if failed else "running"})
                elif cleanup():
                    try:
                        send(connection, {"state": "stopped"})
                    finally:
                        # The stopped receipt settles an interrupted reply;
                        # never leave a listener alive after verified cleanup.
                        return 0
                else:
                    send(connection, {"state": "cleanup_failed"})
            except (OSError, ValueError, Unverified):
                continue


def main() -> int:
    action, directory_arg, name, *args = sys.argv[1:]
    if name not in NAMES:
        raise Unverified()
    directory = Path(directory_arg).absolute()
    if action == "launch":
        return launch(directory, name, args[0], args[1], args[2] if len(args) > 2 else None)
    with lock(directory, name):
        if action == "forget":
            try:
                current = receipt(directory, name)
            except Unverified:
                current = None
            if current is not None and current["state"] != "stopped":
                try:
                    request(current, "state")
                except (OSError, ValueError, Unverified):
                    pass
                else:
                    raise Unverified("a live launch owner must be stopped first")
            # Validate every selected metadata file before removing any of it.
            selected = [p for p in files(directory, name) if os.path.lexists(p)]
            for file in selected:
                read_regular(file)
            for file in selected:
                file.unlink()
            print("record forgotten; no process was signalled")
            return 0
        value = receipt(directory, name, args[0] if args and args[0] else None)
    if action == "state":
        observed = state(value)
        print(f"{observed} {value['pid'] if observed == 'up' else '-'}")
    elif action == "stop":
        result = "not running"
        if value is not None:
            if value["state"] != "stopped":
                try:
                    if request(value, "stop") != {"state": "stopped"}:
                        raise Unverified()
                except (OSError, ValueError, Unverified):
                    # Foreground cancellation can complete in the owner while
                    # this caller is connecting. Only its exact stopped receipt
                    # can settle that lost acknowledgement, never PID absence.
                    deadline = time.monotonic() + 1
                    while True:
                        with lock(directory, name):
                            completed = receipt(directory, name, value["id"])
                        if completed is not None and completed["state"] == "stopped":
                            break
                        if time.monotonic() >= deadline:
                            raise Unverified() from None
                        time.sleep(0.02)
                result = "stopped"
            with lock(directory, name):
                retire(directory, name, value)
        print(result)
    else:
        raise Unverified()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Unverified, ProcessOwnershipError, OSError, ValueError, TypeError, IndexError, AttributeError):
        if len(sys.argv) > 1 and sys.argv[1] == "state":
            print("unverified -")
        else:
            name = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] in NAMES else "NAME"
            print("dev: process ownership or cleanup could not be verified; records retained. "
                  f"Review the earlier processes, then use scripts/dev forget {name} for metadata-only recovery. "
                  "No reboot is required.", file=sys.stderr)
        raise SystemExit(1) from None
