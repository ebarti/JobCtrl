"""Native Windows ACL proof using only owned temporary token files."""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path

import pytest

from jobctrl.infrastructure.gmail import auth

pytestmark = pytest.mark.skipif(os.name != "nt", reason="native Windows DACL verification")

TOKEN = {"access_token": "synthetic-new", "refresh_token": "synthetic-refresh", "expires_at": 9999999999}


@dataclass(frozen=True)
class _Ace:
    kind: int
    flags: int
    sid: str | None


@dataclass(frozen=True)
class _Dacl:
    sddl: str
    aces: tuple[_Ace, ...]


class _AclSizeInformation(ctypes.Structure):
    _fields_ = [("ace_count", ctypes.c_uint32), ("bytes_in_use", ctypes.c_uint32),
                ("bytes_free", ctypes.c_uint32)]


class _AceHeader(ctypes.Structure):
    _fields_ = [("kind", ctypes.c_ubyte), ("flags", ctypes.c_ubyte), ("size", ctypes.c_uint16)]


class _AccessAce(ctypes.Structure):
    _fields_ = [("header", _AceHeader), ("mask", ctypes.c_uint32), ("sid_start", ctypes.c_uint32)]


def _save_synthetic_with_diagnostics(path: Path) -> None:
    """Show the suppressed cause only for this owned synthetic fixture."""
    try:
        auth.save_token(TOKEN, path)
    except auth.GmailAuthError as error:
        if error.__context__ is not None:
            raise error.__context__ from None
        raise


def _security_libraries():
    security = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    security.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR,
        wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.DWORD)]
    security.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    security.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
    security.SetFileSecurityW.restype = wintypes.BOOL
    security.GetSecurityInfo.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.DWORD,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    security.GetSecurityInfo.restype = wintypes.DWORD
    security.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    security.GetNamedSecurityInfoW.restype = wintypes.DWORD
    security.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(wintypes.DWORD)]
    security.ConvertSecurityDescriptorToStringSecurityDescriptorW.restype = wintypes.BOOL
    security.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL),
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
    security.GetSecurityDescriptorDacl.restype = wintypes.BOOL
    security.GetAclInformation.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.c_int]
    security.GetAclInformation.restype = wintypes.BOOL
    security.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    security.GetAce.restype = wintypes.BOOL
    security.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    security.ConvertSidToStringSidW.restype = wintypes.BOOL
    return security, kernel


def _set_everyone_parent(path: Path) -> None:
    security, kernel = _security_libraries()
    descriptor = ctypes.c_void_p()
    # Only the disposable test directory is made broad, so inherited Everyone
    # access is a real negative control for the token's protected DACL.
    if not security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            "D:P(A;OICI;FA;;;WD)(A;OICI;FA;;;SY)", 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not security.SetFileSecurityW(str(path), 0x80000004, descriptor):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.LocalFree(descriptor)


def _dacl(*, path: Path | None = None, handle: int | None = None) -> _Dacl:
    security, kernel = _security_libraries()
    descriptor = ctypes.c_void_p()
    if path is not None:
        status = security.GetNamedSecurityInfoW(str(path), 1, 4, None, None, None, None, ctypes.byref(descriptor))
    else:
        status = security.GetSecurityInfo(handle, 1, 4, None, None, None, None, ctypes.byref(descriptor))
    if status:
        raise ctypes.WinError(status)
    text = wintypes.LPWSTR()
    try:
        if not security.ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor, 1, 4, ctypes.byref(text), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return _Dacl(sddl=text.value, aces=_ace_trustees(descriptor, security, kernel))
    finally:
        if text:
            kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))
        kernel.LocalFree(descriptor)


def _ace_trustees(descriptor, security, kernel) -> tuple[_Ace, ...]:
    """Read trustee SIDs from the descriptor, avoiding SDDL's display aliases."""
    present, defaulted = wintypes.BOOL(), wintypes.BOOL()
    acl = ctypes.c_void_p()
    if not security.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(acl), ctypes.byref(defaulted)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not present.value or not acl.value:
        raise AssertionError("synthetic token has no DACL")
    info = _AclSizeInformation()
    if not security.GetAclInformation(acl, ctypes.byref(info), ctypes.sizeof(info), 2):  # AclSizeInformation
        raise ctypes.WinError(ctypes.get_last_error())
    aces = []
    for index in range(info.ace_count):
        pointer = ctypes.c_void_p()
        if not security.GetAce(acl, index, ctypes.byref(pointer)):
            raise ctypes.WinError(ctypes.get_last_error())
        header = ctypes.cast(pointer, ctypes.POINTER(_AceHeader)).contents
        sid = None
        if header.kind in {0, 1}:  # ACCESS_ALLOWED_ACE_TYPE / ACCESS_DENIED_ACE_TYPE
            sid_text = wintypes.LPWSTR()
            sid_pointer = ctypes.c_void_p(pointer.value + _AccessAce.sid_start.offset)
            if not security.ConvertSidToStringSidW(sid_pointer, ctypes.byref(sid_text)):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                sid = sid_text.value
            finally:
                kernel.LocalFree(ctypes.cast(sid_text, ctypes.c_void_p))
        aces.append(_Ace(kind=header.kind, flags=header.flags, sid=sid))
    return tuple(aces)


def _current_user_sid() -> str:
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command",
         "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
        capture_output=True, text=True, check=True, timeout=20,
    )
    return result.stdout.strip()


def _assert_private(dacl: _Dacl, user_sid: str) -> None:
    assert dacl.sddl.startswith("D:P")
    assert len(dacl.aces) == 2
    assert all(ace.kind == 0 and not ace.flags & 0x10 for ace in dacl.aces)  # allowed, not inherited
    assert sorted(ace.sid for ace in dacl.aces if ace.sid is not None) == sorted([user_sid, "S-1-5-18"])


@pytest.mark.parametrize("existing", [False, True])
def test_stage_is_private_at_creation_even_under_broad_parent(tmp_path, monkeypatch, existing):
    import msvcrt

    _set_everyone_parent(tmp_path)
    parent_dacl = _dacl(path=tmp_path)
    assert any(ace.kind == 0 and ace.sid == "S-1-1-0" for ace in parent_dacl.aces)
    path = tmp_path / "token.json"
    old = b'{"access_token":"synthetic-old"}'
    if existing:
        path.write_bytes(old)
        assert any(ace.kind == 0 and ace.sid == "S-1-1-0" for ace in _dacl(path=path).aces)
    user_sid = _current_user_sid()
    original = auth._create_private_token_stage
    observed = []
    def inspect(destination):
        descriptor, name = original(destination)
        try:
            assert os.fstat(descriptor).st_size == 0
            _assert_private(_dacl(handle=msvcrt.get_osfhandle(descriptor)), user_sid)
            if existing:
                assert path.read_bytes() == old
            else:
                assert not path.exists()
        except BaseException:
            # Ownership has not reached save_token yet when this test's
            # pre-write assertion fails; clean up our synthetic stage here.
            os.close(descriptor)
            Path(name).unlink(missing_ok=True)
            raise
        observed.append(True)
        return descriptor, name
    monkeypatch.setattr(auth, "_create_private_token_stage", inspect)
    _save_synthetic_with_diagnostics(path)
    assert observed == [True]
    assert json.loads(path.read_text(encoding="utf-8")) == TOKEN
    _assert_private(_dacl(path=path), user_sid)
    assert list(tmp_path.glob(".token.json.*")) == []


def test_windows_handle_conversion_failure_preserves_token_and_cleans_stage(tmp_path, monkeypatch):
    import msvcrt

    path = tmp_path / "token.json"
    old = b'{"access_token":"synthetic-old"}'
    path.write_bytes(old)
    monkeypatch.setattr(msvcrt, "open_osfhandle", lambda *_a: (_ for _ in ()).throw(OSError("synthetic failure")))
    with pytest.raises(auth.GmailAuthError, match="Could not save"):
        auth.save_token(TOKEN, path)
    assert path.read_bytes() == old
    assert list(tmp_path.glob(".token.json.*")) == []
