"""Fake Win32 contract checks; native Windows DACL proof runs separately."""

from __future__ import annotations

import ctypes
import os
import sys
from ctypes import wintypes
from types import SimpleNamespace

import pytest

from jobctrl.infrastructure.gmail import windows_private_file


class _Function:
    def __init__(self, implementation):
        self.implementation = implementation

    def __call__(self, *args):
        return self.implementation(*args)


def _fake_win32(monkeypatch, *, acl_supported=True, conversion_fails=False):
    state = {"calls": [], "sddl": "", "fds": {}, "volume_acl": acl_supported}
    sid = ctypes.create_unicode_buffer("S-1-5-21-1174")

    def set_value(pointer, ctype, value):
        ctypes.cast(pointer, ctypes.POINTER(ctype))[0] = value

    def volume_path(_path, output, _size):
        output.value = "synthetic-volume"
        return 1

    def volume_info(_path, _name, _name_size, _serial, _maximum, flags, _fsname, _fsname_size):
        set_value(flags, wintypes.DWORD, 8 if state["volume_acl"] else 0)
        return 1

    def open_token(_process, _rights, token):
        set_value(token, wintypes.HANDLE, 77)
        return 1

    def token_info(_token, _kind, buffer, _size, needed):
        set_value(needed, wintypes.DWORD, 32)
        if buffer is not None:
            set_value(buffer, ctypes.c_void_p, 123)
        return 1

    def sid_string(_sid, result):
        set_value(result, wintypes.LPWSTR, ctypes.cast(sid, wintypes.LPWSTR))
        return 1

    def make_descriptor(sddl, _revision, result, _size):
        state["sddl"] = sddl
        set_value(result, ctypes.c_void_p, 333)
        return 1

    def create_file(path, desired, sharing, attrs, disposition, flags, template):
        class Attributes(ctypes.Structure):
            _fields_ = [("length", wintypes.DWORD), ("descriptor", ctypes.c_void_p),
                        ("inherit_handle", wintypes.BOOL)]
        attributes = ctypes.cast(attrs, ctypes.POINTER(Attributes)).contents
        state["calls"].append((desired, sharing, attributes.descriptor, bool(attributes.inherit_handle), disposition, flags, template))
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        handle = fd + 1000
        state["fds"][handle] = fd
        return handle

    def close_handle(handle):
        fd = state["fds"].pop(handle, None)
        if fd is not None:
            os.close(fd)
        return 1

    kernel = SimpleNamespace(
        GetCurrentProcess=_Function(lambda: 1), CloseHandle=_Function(close_handle),
        LocalFree=_Function(lambda _pointer: None), GetVolumePathNameW=_Function(volume_path),
        GetVolumeInformationW=_Function(volume_info), CreateFileW=_Function(create_file),
    )
    security = SimpleNamespace(
        OpenProcessToken=_Function(open_token), GetTokenInformation=_Function(token_info),
        ConvertSidToStringSidW=_Function(sid_string),
        ConvertStringSecurityDescriptorToSecurityDescriptorW=_Function(make_descriptor),
    )
    monkeypatch.setattr(ctypes, "WinDLL", lambda name, **_kwargs: kernel if name == "kernel32" else security, raising=False)
    monkeypatch.setattr(ctypes, "WinError", lambda code: OSError(code, "synthetic Win32 failure"), raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)
    monkeypatch.setattr(windows_private_file, "os", SimpleNamespace(**{**vars(os), "O_BINARY": 0, "O_NOINHERIT": 0}))
    def transfer(handle, _flags):
        if conversion_fails:
            raise OSError("synthetic conversion failure")
        return state["fds"].pop(handle)
    monkeypatch.setitem(sys.modules, "msvcrt", SimpleNamespace(open_osfhandle=transfer))
    return state


def test_windows_stage_requests_current_user_protected_dacl_and_exclusive_creation(tmp_path, monkeypatch):
    state = _fake_win32(monkeypatch)
    fd, name = windows_private_file.create_private_stage(tmp_path / "token.json")
    try:
        assert state["sddl"] == "D:P(A;;FA;;;S-1-5-21-1174)(A;;FA;;;SY)"
        assert state["calls"] == [(0x40020000, 0, 333, False, 1, 0x80, None)]
        assert os.fstat(fd).st_size == 0
    finally:
        os.close(fd)
        os.unlink(name)


def test_windows_stage_refuses_volume_without_acl_before_creation(tmp_path, monkeypatch):
    state = _fake_win32(monkeypatch, acl_supported=False)
    with pytest.raises(OSError, match="does not support private ACLs"):
        windows_private_file.create_private_stage(tmp_path / "token.json")
    assert state["calls"] == []
    assert list(tmp_path.iterdir()) == []


def test_windows_handle_conversion_failure_closes_and_removes_stage(tmp_path, monkeypatch):
    state = _fake_win32(monkeypatch, conversion_fails=True)
    with pytest.raises(OSError, match="synthetic conversion failure"):
        windows_private_file.create_private_stage(tmp_path / "token.json")
    assert len(state["calls"]) == 1 and state["fds"] == {}
    assert list(tmp_path.iterdir()) == []


def test_native_probe_surfaces_synthetic_cause_without_replacing_token(tmp_path, monkeypatch):
    from jobctrl.infrastructure.gmail import auth
    from tests.test_gmail_token_windows_acl import _save_synthetic_with_diagnostics

    path = tmp_path / "token.json"
    old = b'{"access_token":"synthetic-old"}'
    path.write_bytes(old)
    def fail(_destination):
        raise OSError("synthetic stage failure")
    monkeypatch.setattr(auth, "_create_private_token_stage", fail)
    with pytest.raises(OSError, match="synthetic stage failure"):
        _save_synthetic_with_diagnostics(path)
    assert path.read_bytes() == old
    assert list(tmp_path.glob(".token.json.*")) == []


def test_native_acl_check_compares_actual_trustees_instead_of_sddl_aliases():
    from tests.test_gmail_token_windows_acl import _Ace, _Dacl, _assert_private

    user = "S-1-5-21-1-2-3-500"
    good = _Dacl("D:P(A;;FA;;;LA)(A;;FA;;;SY)", (_Ace(0, 0, user), _Ace(0, 0, "S-1-5-18")))
    _assert_private(good, user)
    with pytest.raises(AssertionError):
        _assert_private(good, "S-1-5-21-1-2-3-501")
    with pytest.raises(AssertionError):
        _assert_private(_Dacl(good.sddl, (_Ace(0, 0, "S-1-1-0"), good.aces[1])), user)
    with pytest.raises(AssertionError):
        _assert_private(_Dacl(good.sddl, (_Ace(0, 0x10, user), good.aces[1])), user)
    with pytest.raises(AssertionError):
        _assert_private(_Dacl(good.sddl, (good.aces[0], good.aces[1], _Ace(1, 0, "S-1-1-0"))), user)
    with pytest.raises(AssertionError):
        _assert_private(_Dacl("D:(A;;FA;;;LA)(A;;FA;;;SY)", good.aces), user)


def test_native_acl_reader_extracts_trustee_sid_from_each_ace():
    from tests.test_gmail_token_windows_acl import _AccessAce, _Ace, _AclSizeInformation, _ace_trustees

    entries = [_AccessAce(), _AccessAce()]
    entries[0].header.kind = 0
    entries[1].header.kind = 1
    entries[1].header.flags = 0x10
    strings = [ctypes.create_unicode_buffer("S-1-5-21-1-2-3-500"), ctypes.create_unicode_buffer("S-1-5-18")]
    addresses = {ctypes.addressof(ace) + _AccessAce.sid_start.offset: value for ace, value in zip(entries, strings)}
    freed = []

    def get_dacl(_descriptor, present, acl, defaulted):
        ctypes.cast(present, ctypes.POINTER(wintypes.BOOL))[0] = 1
        ctypes.cast(acl, ctypes.POINTER(ctypes.c_void_p))[0] = 123
        ctypes.cast(defaulted, ctypes.POINTER(wintypes.BOOL))[0] = 0
        return 1

    def get_info(_acl, info, _size, _kind):
        ctypes.cast(info, ctypes.POINTER(_AclSizeInformation)).contents.ace_count = len(entries)
        return 1

    def get_ace(_acl, index, pointer):
        ctypes.cast(pointer, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(entries[index])
        return 1

    def to_string(sid, output):
        value = addresses[sid.value]
        ctypes.cast(output, ctypes.POINTER(wintypes.LPWSTR))[0] = ctypes.cast(value, wintypes.LPWSTR)
        return 1

    security = SimpleNamespace(GetSecurityDescriptorDacl=get_dacl, GetAclInformation=get_info,
                               GetAce=get_ace, ConvertSidToStringSidW=to_string)
    kernel = SimpleNamespace(LocalFree=lambda pointer: freed.append(pointer.value))
    assert _ace_trustees(ctypes.c_void_p(7), security, kernel) == (
        _Ace(0, 0, "S-1-5-21-1-2-3-500"), _Ace(1, 0x10, "S-1-5-18"),
    )
    assert len(freed) == 2
