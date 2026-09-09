#!/usr/bin/env python3
"""Hash path names, symlink targets, and file bytes for generated-drift gates."""

from __future__ import annotations

import hashlib
from pathlib import Path
import sys


def fingerprint(arguments: list[str]) -> str:
    digest = hashlib.sha256()
    for argument in sorted(arguments):
        root = Path(argument)
        entries = sorted(root.rglob("*")) if root.is_dir() else [root]
        for entry in entries:
            if entry.is_dir():
                continue
            digest.update(entry.as_posix().encode("utf-8"))
            digest.update(b"\0")
            if entry.is_symlink():
                digest.update(b"symlink\0")
                digest.update(entry.readlink().as_posix().encode("utf-8"))
            elif entry.is_file():
                digest.update(entry.read_bytes())
            else:
                digest.update(b"missing-or-special")
            digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: scripts/fingerprint_paths.py PATH [PATH ...]")
    print(fingerprint(sys.argv[1:]))


if __name__ == "__main__":
    main()
