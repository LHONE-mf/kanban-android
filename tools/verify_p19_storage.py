#!/usr/bin/env python3
"""Prepare and verify an offline SQLite snapshot from a Comrade ZIP v1, in a new directory."""
import argparse
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from zipfile import ZipFile

SCHEMA = Path(__file__).resolve().parents[1] / "app/src/main/assets/p19_storage.sql"
MEMBER = re.compile(r"media/[0-9]{6}\.(bin|thumb)")
SHA256 = re.compile(r"[0-9a-f]{64}")
LIMIT = 2_000_000_000
BUFFER = 64 * 1024


def check(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha256_file(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def archive_index(archive):
    records = {}
    total = 0
    entries = archive.infolist()
    check(2 <= len(entries) <= 12001, "Invalid number of ZIP entries")
    for entry in entries:
        name = entry.filename
        check(name not in records and not entry.is_dir(), "Duplicate or directory ZIP entry")
        if name == "manifest.json":
            limit = 2_000_000
        elif name == "state.json":
            limit = 32 * 1024 * 1024
        else:
            check(MEMBER.fullmatch(name), "Invalid ZIP member name")
            limit = 1024 * 1024 if name.endswith(".thumb") else 50 * 1024 * 1024
        total += entry.file_size
        check(0 <= entry.file_size <= limit and total <= LIMIT, "ZIP exceeds storage limits")
        records[name] = entry.file_size
    check("manifest.json" in records and "state.json" in records, "Missing manifest or state")
    manifest = json.loads(archive.read("manifest.json"))
    check(manifest["format"] == "comrade-backup" and manifest["version"] == 1, "Unsupported archive version")
    records.pop("manifest.json")
    check(len(manifest["entries"]) == len(records), "Incomplete manifest")
    result = {}
    for row in manifest["entries"]:
        name, size, digest = row["path"], row["size"], row["sha256"]
        check(name in records and records.pop(name) == size and SHA256.fullmatch(digest), "Invalid ZIP manifest entry")
        result[name] = (size, digest)
    return result


def copy_verified_blob(archive, name, expected, directory):
    size, digest = expected
    destination = directory / digest
    temporary = directory / (digest + ".part")
    check(not destination.is_symlink() and not temporary.is_symlink(), "Unexpected staged file link")
    if destination.is_file():
        check(destination.stat().st_size == size and sha256_file(destination) == digest, "Existing staged file is corrupt")
        # Verify this archive entry as well, including another reference to the same bytes.
        with archive.open(name) as source:
            check(hashlib.file_digest(source, "sha256").hexdigest() == digest, "ZIP member hash mismatch")
        return
    measured, remaining = hashlib.sha256(), size
    with archive.open(name) as source, temporary.open("wb") as output:
        while chunk := source.read(BUFFER):
            remaining -= len(chunk)
            check(remaining >= 0, "ZIP member exceeds declared size")
            measured.update(chunk)
            output.write(chunk)
        check(remaining == 0 and measured.hexdigest() == digest, "ZIP member hash or size mismatch")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, destination)


def sync_directory(path):
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def payload(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def validate_parents(tasks):
    parents = {task["id"]: task["parentId"] for task in tasks}
    check(len(parents) == len(tasks), "Duplicate task ID")
    checked = set()
    for task in parents:
        trail = set()
        while task and task not in checked:
            check(task in parents and task not in trail, "Invalid parent reference or cycle")
            trail.add(task)
            task = parents[task]
        checked.update(trail)


def stage_database(database, state, archive, index, directory, fingerprint):
    validate_parents(state["tasks"])
    paths = {"state.json"}
    with closing(sqlite3.connect(database)) as db:
        db.executescript(SCHEMA.read_text())
        with db:
            for board_position, board in enumerate(state["boards"]):
                db.execute("INSERT INTO boards VALUES (?, ?, ?)", (board["id"], board_position, payload(board)))
                for column_position, column in enumerate(board["columns"]):
                    db.execute("INSERT INTO columns VALUES (?, ?, ?, ?, ?)",
                               (board["id"], column["id"], column_position, int(bool(column.get("isDone"))), payload(column)))
            for media in state["media"]:
                binary = media["path"]
                check(MEMBER.fullmatch(binary) and binary.endswith(".bin") and binary not in paths, "Invalid media mapping")
                paths.add(binary)
                check(index[binary][0] == media["size"], "Inconsistent media size")
                copy_verified_blob(archive, binary, index[binary], directory)
                size, digest = index[binary]
                db.execute("INSERT OR IGNORE INTO blobs VALUES (?, ?)", (digest, size))
                thumb_digest = thumb_mime = None
                if thumb := media.get("thumb"):
                    thumb_path = thumb["path"]
                    check(thumb_path == binary.removesuffix(".bin") + ".thumb" and thumb_path not in paths, "Invalid thumbnail")
                    paths.add(thumb_path)
                    check(index[thumb_path][0] == thumb["size"], "Inconsistent thumbnail size")
                    copy_verified_blob(archive, thumb_path, index[thumb_path], directory)
                    thumb_digest, thumb_mime = index[thumb_path][1], thumb["mime"]
                    db.execute("INSERT OR IGNORE INTO blobs VALUES (?, ?)", (thumb_digest, thumb["size"]))
                db.execute("INSERT INTO media VALUES (?, ?, ?, ?, ?)",
                           (media["id"], digest, thumb_digest, media["mime"], thumb_mime))
            check(paths == index.keys(), "Unreferenced ZIP files")
            for task in state["tasks"]:
                task_id = task["id"]
                db.execute("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                           (task_id, task["boardId"], task["columnId"], task["parentId"] or None, task["order"],
                            task["createdAt"], task["updatedAt"], task.get("completedAt"), payload(task)))
                for table, values in (("task_results", task["results"]), ("checklist_items", task["checklist"])):
                    rows = ((task_id, entry["id"], position, payload(entry)) for position, entry in enumerate(values))
                    db.executemany(f"INSERT INTO {table} VALUES (?, ?, ?, ?)", rows)
                for position, attachment in enumerate(task["files"]):
                    db.execute("INSERT INTO attachments VALUES (?, ?, ?, ?, ?)",
                               (task_id, position, attachment["id"], attachment.get("resultId") or None, payload(attachment)))
            unreferenced = db.execute(
                "SELECT id FROM media WHERE NOT EXISTS (SELECT 1 FROM attachments WHERE media_id = media.id)").fetchone()
            check(unreferenced is None, "An archive attachment has no task")
            for key in ("settings", "web", "nativeJapanese", "pomo"):
                db.execute("INSERT INTO settings VALUES (?, ?)", (key, payload(state[key])))
            for table, records, ordering in (("boards", state["boards"], "position"), ("tasks", state["tasks"], "rowid")):
                rows = db.execute(f"SELECT payload FROM {table} ORDER BY {ordering}").fetchall()
                check([json.loads(row[0]) for row in rows] == records, f"Snapshot differs from source: {table}")
            check(db.execute("PRAGMA foreign_key_check").fetchone() is None, "Inconsistent references")
            check(db.execute("PRAGMA integrity_check").fetchone() == ("ok",), "SQLite integrity check failed")
            sync_directory(directory)
            db.execute("INSERT INTO snapshot VALUES (1, ?, ?, 'verified')", (fingerprint, state["activeBoardId"]))


def verify_prepared(path, fingerprint):
    with closing(sqlite3.connect(f"{(path / 'snapshot.sqlite').resolve().as_uri()}?mode=ro", uri=True)) as db:
        check(db.execute("SELECT source_sha256 FROM snapshot WHERE slot = 1").fetchone() == (fingerprint,),
              "Destination belongs to a different archive")
        check(db.execute("PRAGMA integrity_check").fetchone() == ("ok",), "SQLite integrity check failed")
        check(db.execute("PRAGMA foreign_key_check").fetchone() is None, "Inconsistent references")
        for digest, size in db.execute("SELECT sha256, size FROM blobs"):
            path_to_blob = path / "blobs" / digest
            check(path_to_blob.stat().st_size == size and sha256_file(path_to_blob) == digest, "Published file hash mismatch")
        return {
            "boards": db.execute("SELECT count(*) FROM boards").fetchone()[0],
            "tasks": db.execute("SELECT count(*) FROM tasks").fetchone()[0],
            "files": db.execute("SELECT count(*) FROM media").fetchone()[0],
            "unique_blobs": db.execute("SELECT count(*) FROM blobs").fetchone()[0],
        }


def prepare_locked(source, output):
    fingerprint = sha256_file(source)
    check(not output.is_symlink(), "Output must be a directory, not a symbolic link")
    if output.exists():
        return verify_prepared(output, fingerprint)
    staging = output.with_name(output.name + ".staging")
    check(not staging.is_symlink(), "Unexpected staging directory link")
    staging.mkdir(mode=0o700, exist_ok=True)
    marker = staging / "source.sha256"
    check(not marker.is_symlink(), "Unexpected staging marker link")
    if marker.exists():
        check(marker.read_text().strip() == fingerprint, "Staging belongs to a different archive")
    else:
        check(not any(staging.iterdir()), "Unrecognized staging directory")
        with marker.open("x") as f:
            f.write(fingerprint + "\n")
            f.flush()
            os.fsync(f.fileno())
        sync_directory(staging)
    directory = staging / "blobs"
    check(not directory.is_symlink(), "Unexpected blob directory link")
    directory.mkdir(mode=0o700, exist_ok=True)
    database = staging / "snapshot.sqlite"
    for candidate in (database, staging / "snapshot.sqlite-journal"):
        check(not candidate.is_symlink(), "Unexpected staging database link")
        if candidate.exists():
            candidate.unlink()
    with ZipFile(source) as archive:
        index = archive_index(archive)
        state_bytes = archive.read("state.json")
        check(len(state_bytes) == index["state.json"][0] and
              hashlib.sha256(state_bytes).hexdigest() == index["state.json"][1], "Invalid state checksum")
        state = json.loads(state_bytes)
        check(state["version"] == 1, "Unsupported state version")
        stage_database(database, state, archive, index, directory, fingerprint)
    result = verify_prepared(staging, fingerprint)
    sync_directory(staging)
    check(not output.exists(), "Destination already exists")
    staging.rename(output)
    sync_directory(output.parent)
    return result


def prepare(source, output):
    directory = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(directory, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return prepare_locked(source, output)
    finally:
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(payload(prepare(args.archive, args.output)))


if __name__ == "__main__":
    main()
