#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only V0.1 (65-chat) baseline ID exporter for V0.2 migration.

Uses only the Python standard library. Never opens a database for writing.
Does not modify ZIPs, R22, Google Drive or Obsidian. No network access.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from urllib.parse import quote

EXPECTED_COUNT = 65
SCHEMA = "cgx-v01-baseline-v1"


class BaselineError(RuntimeError):
    pass


def open_readonly(db_path: Path) -> sqlite3.Connection:
    if not db_path.is_file():
        raise BaselineError("Database does not exist: " + str(db_path))
    # SQLite URI with mode=ro; never creates a new database.
    url = "file:" + quote(str(db_path.resolve()).replace("\\", "/"), safe="/:") + "?mode=ro"
    conn = sqlite3.connect(url, uri=True, timeout=5)
    try:
        conn.execute("PRAGMA query_only=ON")
        return conn
    except BaseException:
        conn.close()
        raise


def verify_baseline(db_path: Path) -> dict:
    # sqlite3.Connection.__exit__ commits/rolls back but does NOT close.
    # Explicit closing is required for Windows TemporaryDirectory cleanup.
    with closing(open_readonly(db_path)) as conn:
        tables = {
            row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        required = {"meta", "conversations", "versions"}
        if not required.issubset(tables):
            raise BaselineError("Not a known V0.1 baseline database (missing tables).")

        def columns(table: str) -> set[str]:
            # Names here are hardcoded, never user-supplied SQL.
            return {row[1] for row in conn.execute("PRAGMA table_info(" + table + ")")}

        if not {"key", "value"}.issubset(columns("meta")):
            raise BaselineError("Unexpected meta schema.")
        if not {"conversation_id", "workspace_id"}.issubset(columns("conversations")):
            raise BaselineError("Unexpected conversations schema.")
        if not {"conversation_id", "workspace_id", "kind"}.issubset(columns("versions")):
            raise BaselineError("Unexpected versions schema.")

        meta = dict(conn.execute(
            "SELECT key, value FROM meta WHERE key IN "
            "('baseline_exported_at', 'baseline_conversation_count')"
        ).fetchall())
        if not meta.get("baseline_exported_at"):
            raise BaselineError("No confirmed V0.1 baseline timestamp.")
        if str(meta.get("baseline_conversation_count")) != str(EXPECTED_COUNT):
            raise BaselineError("Baseline count in meta is not 65.")

        # Versions with kind='baseline' are the immutable historical cohort;
        # the newer synthetic 66th conversation and its changed version must
        # not be included. Never infer the cohort from all current rows.
        records = conn.execute(
            "SELECT workspace_id, conversation_id FROM versions "
            "WHERE kind='baseline' ORDER BY conversation_id, workspace_id"
        ).fetchall()
        pairs = [(str(workspace), str(conv)) for workspace, conv in records]
        ids = [conv for _, conv in pairs]

        if len(pairs) != EXPECTED_COUNT or len(set(pairs)) != EXPECTED_COUNT:
            raise BaselineError("Expected exactly 65 unique baseline version records.")
        if len(set(ids)) != EXPECTED_COUNT:
            raise BaselineError("Baseline contains repeated IDs across workspaces.")
        if any(not cid or len(cid) > 160 or not all(
            x.isascii() and (x.isalnum() or x in "_-") for x in cid
        ) or len(cid) < 8 for cid in ids):
            raise BaselineError("Invalid conversation ID in baseline.")
        if not all(conn.execute(
            "SELECT 1 FROM conversations WHERE workspace_id=? "
            "AND conversation_id=? LIMIT 1", (workspace, conv)
        ).fetchone() for workspace, conv in pairs):
            raise BaselineError("A baseline record is absent from conversations.")

    return {"schema": SCHEMA, "conversation_ids": sorted(ids)}


def save_new(path: Path, payload: dict) -> None:
    if path.is_dir():
        raise BaselineError("Output is a directory.")
    content = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    # Exclusive creation: never overwrite an existing baseline or report.
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
    except BaseException:
        # Incomplete new output is not a valid handoff. Never touch originals.
        try:
            path.unlink()
        except OSError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read-only V0.1 baseline (65 real IDs) exporter."
    )
    parser.add_argument("--db", required=True, type=Path,
                        help="Path to the actual frozen V0.1 SQLite database")
    parser.add_argument("--out", required=True, type=Path,
                        help="New local JSON filename (must not already exist)")
    args = parser.parse_args(argv)
    try:
        payload = verify_baseline(args.db)
        save_new(args.out, payload)
    except (BaselineError, sqlite3.Error, OSError, FileExistsError) as exc:
        print("FAILED:", exc, file=sys.stderr)
        return 2
    print("PASS: 65 V0.1 historical IDs verified; local JSON written to:", args.out)
    print("No ZIP, original database, or historical data was modified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
