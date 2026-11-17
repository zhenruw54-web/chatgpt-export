#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit tests for the read-only V0.1 baseline ID handoff.

Run from repository root:
    python -m unittest discover -s tests -p 'test_v01_baseline_export.py' -v
Uses only a temporary synthetic SQLite fixture; never opens the user's DB.
"""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "tools" / "export_v01_baseline_ids.py"
SPEC = importlib.util.spec_from_file_location("export_v01_baseline_ids", MODULE)
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class V01BaselineExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.db = self.dir / "state.sqlite3"
        self.out = self.dir / "baseline.json"
        self.ids = ["conv-" + str(i).zfill(8) for i in range(65)]
        with sqlite3.connect(self.db) as conn:
            conn.executescript("""
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE conversations (
                    workspace_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (workspace_id, conversation_id)
                );
                CREATE TABLE versions (
                    workspace_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL DEFAULT '',
                    kind TEXT NOT NULL
                );
            """)
            conn.executemany("INSERT INTO meta(key,value) VALUES(?,?)", [
                ("baseline_exported_at", "2026-11-16T00:00:00Z"),
                ("baseline_conversation_count", "65")
            ])
            for cid in self.ids:
                conn.execute(
                    "INSERT INTO conversations(workspace_id,conversation_id) VALUES (?,?)",
                    ("workspace-1", cid)
                )
                conn.execute(
                    "INSERT INTO versions(workspace_id,conversation_id,kind) VALUES (?,?,?)",
                    ("workspace-1", cid, "baseline")
                )

    def test_65_real_baseline_ids_only(self):
        # A synthetic increment and a modified existing version should not
        # leak into the frozen 65-chat historical cohort.
        with sqlite3.connect(self.db) as conn:
            conn.execute(
                "INSERT INTO conversations(workspace_id,conversation_id) VALUES (?,?)",
                ("workspace-1", "conv-99999999")
            )
            conn.execute(
                "INSERT INTO versions(workspace_id,conversation_id,kind) VALUES (?,?,?)",
                ("workspace-1", "conv-99999999", "new")
            )
            conn.execute(
                "INSERT INTO versions(workspace_id,conversation_id,kind) VALUES (?,?,?)",
                ("workspace-1", self.ids[0], "modified")
            )
        payload = exporter.verify_baseline(self.db)
        self.assertEqual(payload["schema"], "cgx-v01-baseline-v1")
        self.assertEqual(payload["conversation_ids"], self.ids)
        exporter.save_new(self.out, payload)
        result = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(result, payload)
        # Exclusive creation must not overwrite an existing output.
        with self.assertRaises(FileExistsError):
            exporter.save_new(self.out, payload)

    def test_reject_incomplete_baseline(self):
        with sqlite3.connect(self.db) as conn:
            conn.execute(
                "DELETE FROM versions WHERE kind='baseline' AND conversation_id=?",
                (self.ids[0],)
            )
        with self.assertRaisesRegex(exporter.BaselineError, "exactly 65"):
            exporter.verify_baseline(self.db)
        self.assertFalse(self.out.exists())

    def test_reject_meta_count_mismatch(self):
        with sqlite3.connect(self.db) as conn:
            conn.execute(
                "UPDATE meta SET value='66' WHERE key='baseline_conversation_count'"
            )
        with self.assertRaisesRegex(exporter.BaselineError, "not 65"):
            exporter.verify_baseline(self.db)

    def test_reject_missing_current_conversation(self):
        with sqlite3.connect(self.db) as conn:
            conn.execute(
                "DELETE FROM conversations WHERE conversation_id=?", (self.ids[0],)
            )
        with self.assertRaisesRegex(exporter.BaselineError, "absent"):
            exporter.verify_baseline(self.db)

    def test_read_only_never_creates_database(self):
        missing = self.dir / "nonexistent.sqlite3"
        with self.assertRaises(exporter.BaselineError):
            exporter.verify_baseline(missing)
        self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()
