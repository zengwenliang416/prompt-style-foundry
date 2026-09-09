#!/usr/bin/env python3
"""Hash the Git-visible worktree without emitting file names or contents."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import subprocess

ROOT = Path(__file__).resolve().parents[1]
_FORMAT = b"onepic-git-visible-worktree-v1\0"


def _frame(digest: "hashlib._Hash", value: bytes) -> None:
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)


def _visible_paths(root: Path) -> list[bytes]:
    result = subprocess.run(
        ["git", "-C", os.fspath(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise RuntimeError("unable to enumerate the Git-visible worktree")
    return sorted(set(path for path in result.stdout.split(b"\0") if path))


def _entry_type(mode: int) -> bytes:
    if stat.S_ISREG(mode):
        return b"regular+x" if mode & 0o111 else b"regular"
    if stat.S_ISLNK(mode):
        return b"symlink"
    if stat.S_ISDIR(mode):
        return b"directory"
    if stat.S_ISFIFO(mode):
        return b"fifo"
    if stat.S_ISSOCK(mode):
        return b"socket"
    if stat.S_ISCHR(mode):
        return b"character-device"
    if stat.S_ISBLK(mode):
        return b"block-device"
    return b"unknown"


def fingerprint_worktree(root: Path = ROOT) -> str:
    root = root.resolve()
    root_bytes = os.fsencode(root)
    digest = hashlib.sha256(_FORMAT)
    for relative in _visible_paths(root):
        if relative.startswith(b"/") or b"\0" in relative or b".." in relative.split(b"/"):
            raise RuntimeError("Git returned an unsafe worktree path")
        full_path = os.path.join(root_bytes, relative)
        _frame(digest, relative)
        try:
            metadata = os.lstat(full_path)
        except FileNotFoundError:
            _frame(digest, b"missing")
            _frame(digest, b"")
            continue

        entry_type = _entry_type(metadata.st_mode)
        _frame(digest, entry_type)
        if stat.S_ISLNK(metadata.st_mode):
            _frame(digest, os.readlink(full_path))
        elif stat.S_ISREG(metadata.st_mode):
            digest.update(metadata.st_size.to_bytes(8, "big"))
            bytes_read = 0
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(full_path, flags)
            try:
                while True:
                    chunk = os.read(descriptor, 1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    bytes_read += len(chunk)
            finally:
                os.close(descriptor)
            if bytes_read != metadata.st_size:
                raise RuntimeError("worktree changed while its fingerprint was being calculated")
        else:
            _frame(digest, b"")
    return digest.hexdigest()


def main() -> None:
    print(fingerprint_worktree())


if __name__ == "__main__":
    main()
