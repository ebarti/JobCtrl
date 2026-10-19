"""Bounded, descriptor-relative I/O for owned cover-letter files."""

from __future__ import annotations

import os
import stat
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def _parent(root: Path, file: Path):
    spelling = root.absolute()
    resolved = root.resolve(strict=True)
    absolute = file.absolute()
    if absolute.is_relative_to(spelling):
        parts = absolute.relative_to(spelling).parts
    elif absolute.is_relative_to(resolved):
        parts = absolute.relative_to(resolved).parts
    else:
        raise ValueError("cover_letter_path_forbidden")
    if not parts or any(part in (".", "..") for part in parts):
        raise ValueError("cover_letter_path_forbidden")
    descriptor = os.open(resolved, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor, parts[-1]
    finally:
        os.close(descriptor)


def read_owned_cover_file(root: Path, file: Path, maximum: int) -> bytes:
    with _parent(root, file) as (parent, leaf):
        descriptor = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
                raise ValueError("cover_letter_file_invalid")
            data = stream.read(maximum + 1)
            after = os.fstat(stream.fileno())
            if (len(data) != before.st_size or len(data) > maximum
                    or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns):
                raise ValueError("cover_letter_file_changed")
            return data


def write_owned_cover_file(root: Path, file: Path, data: bytes, *, exclusive: bool = True) -> None:
    with _parent(root, file) as (parent, leaf):
        flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
        flags |= os.O_EXCL if exclusive else 0
        descriptor = os.open(leaf, flags, 0o600, dir_fd=parent)
        with os.fdopen(descriptor, "wb") as stream:
            current = os.fstat(stream.fileno())
            if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                raise ValueError("cover_letter_file_invalid")
            if not exclusive:
                os.ftruncate(stream.fileno(), 0)
            stream.write(data)


def require_cover_review_paths(root: Path, source: Path, pdf: Path) -> None:
    import uuid

    # Paths supplied by the local API name one immutable attempt. Arbitrary
    # registered RPC inputs never gain filesystem authority from their spelling.
    base = root.resolve(strict=True) / "generated" / "cover-letter-previews"
    absolute = source.absolute()
    source_relative = absolute.relative_to(root.absolute()) if absolute.is_relative_to(root.absolute()) else absolute.relative_to(root.resolve(strict=True))
    parts = source_relative.parts
    if (len(parts) != 4 or parts[:2] != ("generated", "cover-letter-previews")
            or str(uuid.UUID(parts[2])) != parts[2] or parts[3] != "source.txt"
            or pdf.absolute() != source.absolute().with_name("letter.pdf")):
        raise ValueError("cover_letter_path_forbidden")
    # Opening parent components refuses prepared directory symlinks. Writing
    # later also uses descriptor-relative I/O rather than reopening this path.
    with _parent(root, base / parts[2] / "source.txt"):
        pass
    with _parent(root, pdf) as (parent, leaf):
        try:
            os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise ValueError("cover_letter_output_exists")
