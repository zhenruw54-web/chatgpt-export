from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "verify_v02_pilot_receipt.py"
SPEC = importlib.util.spec_from_file_location("verify_v02_pilot_receipt", MODULE_PATH)
verifier = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(verifier)


class PilotReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.zip_path = self.root / "pilot.zip"
        self.db_path = self.root / "test-copy.sqlite3"
        self.output = self.root / "receipt.json"
        self.conversation_id = "pilot-00000001"
        self.workspace_id = "workspace-1"
        self._make_zip()
        self.zip_sha256 = verifier.sha256_file(self.zip_path)
        self._make_database()

    @staticmethod
    def _sha(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def _make_zip(self, *, wrong_checksum: bool = False, raw_id: str | None = None) -> None:
        folder = "conversations/Pilot"
        payload = {
            folder + "/Pilot.md": b"# Pilot\n\nOne non-sensitive test conversation.\n",
            folder + "/metadata.json": json.dumps({
                "conversation_id": self.conversation_id,
                "workspace_id": self.workspace_id,
                "title": "Pilot",
            }).encode("utf-8"),
            folder + "/raw.json": json.dumps({
                "id": raw_id or self.conversation_id,
                "title": "Pilot",
            }).encode("utf-8"),
            "_capabilities.json": b"{}",
        }
        files = []
        for name, data in payload.items():
            digest = self._sha(data)
            if wrong_checksum and name.endswith("Pilot.md"):
                digest = "0" * 64
            files.append({"path": name, "size": len(data), "sha256": digest})
        manifest = {
            "schema_version": 4,
            "exported_at": "2026-11-17T09:00:00Z",
            "conversation_count": 1,
            "failures": 0,
            "image_failures": 0,
            "file_failures": 0,
            "workspace_ids": [self.workspace_id],
            "part": 1,
            "files": files,
        }
        with zipfile.ZipFile(self.zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in payload.items():
                archive.writestr(name, data)
            archive.writestr("manifest.json", json.dumps(manifest, indent=2).encode("utf-8"))

    def _make_database(self, *, kind: str = "new") -> None:
        if self.db_path.exists():
            self.db_path.unlink()
        with closing(sqlite3.connect(self.db_path)) as database, database:
            database.executescript("""
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE archives (
                    archive_sha256 TEXT PRIMARY KEY, mode TEXT NOT NULL,
                    conversation_count INTEGER NOT NULL, new_count INTEGER NOT NULL,
                    modified_count INTEGER NOT NULL, unchanged_count INTEGER NOT NULL
                );
                CREATE TABLE conversations (
                    workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                    last_archive_sha256 TEXT NOT NULL
                );
                CREATE TABLE versions (
                    workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                    archive_sha256 TEXT NOT NULL, kind TEXT NOT NULL
                );
            """)
            database.execute("INSERT INTO meta VALUES('baseline_conversation_count','65')")
            database.execute("INSERT INTO archives VALUES(?,?,?,?,?,?)", (
                self.zip_sha256, "incremental", 1,
                1 if kind == "new" else 0,
                1 if kind == "modified" else 0,
                0,
            ))
            database.execute("INSERT INTO conversations VALUES(?,?,?)", (
                self.workspace_id, self.conversation_id, self.zip_sha256,
            ))
            database.execute("INSERT INTO versions VALUES(?,?,?,?)", (
                self.workspace_id, self.conversation_id, self.zip_sha256, kind,
            ))

    def test_success_creates_exclusive_exact_receipt(self):
        receipt = verifier.build_receipt(self.zip_path, self.db_path)
        self.assertEqual(receipt["schema"], "cgx-v02-pilot-v01-receipt-v1")
        self.assertEqual(receipt["status"], "accepted")
        self.assertEqual(receipt["v01_status"], "processed_new")
        self.assertEqual(receipt["conversation_count"], 1)
        self.assertEqual(receipt["zip_sha256"], self.zip_sha256)
        verifier.save_new(self.output, receipt)
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8")), receipt)
        with self.assertRaises(FileExistsError):
            verifier.save_new(self.output, receipt)

    def test_rejects_manifest_checksum_mismatch(self):
        self._make_zip(wrong_checksum=True)
        with self.assertRaisesRegex(verifier.PilotReceiptError, "SHA-256"):
            verifier.verify_zip(self.zip_path)

    def test_rejects_raw_identity_mismatch(self):
        self._make_zip(raw_id="different-00000001")
        with self.assertRaisesRegex(verifier.PilotReceiptError, "identities"):
            verifier.verify_zip(self.zip_path)

    def test_rejects_modified_v01_result(self):
        self._make_database(kind="modified")
        with self.assertRaisesRegex(verifier.PilotReceiptError, "one new"):
            verifier.build_receipt(self.zip_path, self.db_path)

    def test_readonly_database_handle_closes_on_windows(self):
        verifier.build_receipt(self.zip_path, self.db_path)
        renamed = self.root / "renamed.sqlite3"
        self.db_path.rename(renamed)
        renamed.rename(self.db_path)
        self.assertTrue(self.db_path.is_file())


if __name__ == "__main__":
    unittest.main()
