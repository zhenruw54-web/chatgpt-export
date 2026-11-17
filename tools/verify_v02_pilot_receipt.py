"""Verify one V0.2 pilot ZIP against a V0.1 test-copy database.

The ZIP and SQLite database are opened read-only. The output receipt is
created exclusively and contains the exact local identity needed by the
extension to commit only the accepted pilot conversation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import zipfile
from contextlib import closing
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote


class PilotReceiptError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_entry(archive: zipfile.ZipFile, name: str) -> str:
    digest = hashlib.sha256()
    with archive.open(name, "r") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_name(name: str) -> None:
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise PilotReceiptError("ZIP contains an unsafe path.")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", "..") for part in path.parts) or re.match(r"^[A-Za-z]:", name):
        raise PilotReceiptError("ZIP contains an unsafe path.")


def verify_zip(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.suffix.lower() != ".zip" or not zipfile.is_zipfile(path):
        raise PilotReceiptError("Pilot ZIP does not exist or is not a ZIP file.")
    zip_sha256 = sha256_file(path)
    with zipfile.ZipFile(path, "r") as archive:
        bad_crc = archive.testzip()
        if bad_crc is not None:
            raise PilotReceiptError("ZIP CRC failed.")
        infos = {item.filename: item for item in archive.infolist() if not item.is_dir()}
        for name in infos:
            safe_name(name)
        try:
            manifest_raw = archive.read("manifest.json")
            manifest = json.loads(manifest_raw.decode("utf-8-sig"))
        except (KeyError, UnicodeError, json.JSONDecodeError) as exc:
            raise PilotReceiptError("manifest.json is missing or invalid.") from exc
        if not isinstance(manifest, dict) or manifest.get("schema_version") != 4:
            raise PilotReceiptError("Pilot manifest schema_version must be 4.")
        if manifest.get("conversation_count") != 1:
            raise PilotReceiptError("Pilot manifest must contain exactly one conversation.")
        if any(manifest.get(key, 0) != 0 for key in ("failures", "image_failures", "file_failures")):
            raise PilotReceiptError("Pilot ZIP reports conversation or media failures.")
        entries = manifest.get("files")
        if not isinstance(entries, list):
            raise PilotReceiptError("Pilot manifest files list is missing.")
        declared: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise PilotReceiptError("Pilot manifest contains an invalid file entry.")
            name = entry.get("path")
            safe_name(name)
            if name in declared or name not in infos:
                raise PilotReceiptError("Pilot manifest file set is invalid.")
            declared.add(name)
            if infos[name].file_size != entry.get("size"):
                raise PilotReceiptError("Pilot manifest file size mismatch.")
            expected = entry.get("sha256")
            if not isinstance(expected, str) or sha256_entry(archive, name).lower() != expected.lower():
                raise PilotReceiptError("Pilot manifest file SHA-256 mismatch.")
        if declared != set(infos) - {"manifest.json"}:
            raise PilotReceiptError("Pilot ZIP payload differs from manifest files.")
        metadata_names = [name for name in declared if name.endswith("/metadata.json")]
        raw_names = [name for name in declared if name.endswith("/raw.json")]
        if len(metadata_names) != 1 or len(raw_names) != 1:
            raise PilotReceiptError("Pilot ZIP must contain one metadata.json and one raw.json.")
        metadata_name = metadata_names[0]
        parent = str(PurePosixPath(metadata_name).parent)
        if raw_names[0] != parent + "/raw.json":
            raise PilotReceiptError("Pilot raw.json is not paired with metadata.json.")
        markdown_names = [name for name in declared if name.startswith(parent + "/") and
                          name.lower().endswith(".md") and "/branches/" not in name]
        if len(markdown_names) != 1:
            raise PilotReceiptError("Pilot ZIP must contain one primary Markdown document.")
        try:
            metadata = json.loads(archive.read(metadata_name).decode("utf-8-sig"))
            raw = json.loads(archive.read(raw_names[0]).decode("utf-8-sig"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise PilotReceiptError("Pilot metadata or raw JSON is invalid.") from exc
        conversation_id = str(metadata.get("conversation_id") or "").strip()
        workspace_id = str(metadata.get("workspace_id") or "default").strip() or "default"
        raw_id = str(raw.get("conversation_id") or raw.get("id") or "").strip() if isinstance(raw, dict) else ""
        if not conversation_id or raw_id != conversation_id:
            raise PilotReceiptError("Pilot metadata and raw JSON identities do not match.")
        workspace_ids = [str(value) for value in (manifest.get("workspace_ids") or [])]
        if workspace_ids != [workspace_id]:
            raise PilotReceiptError("Pilot manifest workspace identity is not exact.")
        return {
            "conversation_id": conversation_id,
            "workspace_id": workspace_id,
            "zip_sha256": zip_sha256,
            "manifest_sha256": sha256_bytes(manifest_raw),
        }


def open_readonly(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise PilotReceiptError("V0.1 test-copy database does not exist.")
    uri = "file:" + quote(str(path.resolve()).replace("\\", "/"), safe="/:") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def verify_v01_database(path: Path, evidence: dict[str, Any]) -> None:
    with closing(open_readonly(path)) as database:
        tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"meta", "archives", "conversations", "versions"}.issubset(tables):
            raise PilotReceiptError("V0.1 test-copy database schema is incomplete.")
        baseline = database.execute("SELECT value FROM meta WHERE key='baseline_conversation_count'").fetchone()
        if baseline is None or baseline[0] != "65":
            raise PilotReceiptError("V0.1 test-copy does not preserve the 65-conversation baseline.")
        archive = database.execute(
            "SELECT mode,conversation_count,new_count,modified_count,unchanged_count FROM archives WHERE archive_sha256=?",
            (evidence["zip_sha256"],),
        ).fetchone()
        if archive is None or tuple(archive) != ("incremental", 1, 1, 0, 0):
            raise PilotReceiptError("V0.1 archive receipt is not exactly one new conversation.")
        identity = (evidence["workspace_id"], evidence["conversation_id"])
        conversation = database.execute(
            "SELECT last_archive_sha256 FROM conversations WHERE workspace_id=? AND conversation_id=?", identity
        ).fetchone()
        if conversation is None or conversation[0] != evidence["zip_sha256"]:
            raise PilotReceiptError("V0.1 current conversation record does not match the pilot ZIP.")
        versions = database.execute(
            "SELECT archive_sha256,kind FROM versions WHERE workspace_id=? AND conversation_id=? AND archive_sha256=?",
            (*identity, evidence["zip_sha256"]),
        ).fetchall()
        if len(versions) != 1 or tuple(versions[0]) != (evidence["zip_sha256"], "new"):
            raise PilotReceiptError("V0.1 version record is not one accepted new version.")


def build_receipt(zip_path: Path, database_path: Path) -> dict[str, Any]:
    evidence = verify_zip(zip_path)
    verify_v01_database(database_path, evidence)
    return {
        "schema": "cgx-v02-pilot-v01-receipt-v1",
        "status": "accepted",
        "v01_status": "processed_new",
        **evidence,
        "conversation_count": 1,
        "verified_at": datetime.now().astimezone().isoformat(),
    }


def save_new(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", required=True, type=Path)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    try:
        receipt = build_receipt(args.zip, args.db)
        save_new(args.out, receipt)
    except (PilotReceiptError, OSError, sqlite3.Error, zipfile.BadZipFile) as exc:
        print("FAILED: " + str(exc))
        return 1
    print("PASS: one pilot ZIP matched one new V0.1 test-copy record; receipt created locally.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
