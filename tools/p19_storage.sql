PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;

CREATE TABLE snapshot (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
    active_board_id TEXT NOT NULL REFERENCES boards(id),
    state TEXT NOT NULL CHECK (state = 'verified')
);
CREATE TABLE boards (
    id TEXT PRIMARY KEY NOT NULL,
    position INTEGER NOT NULL UNIQUE,
    payload TEXT NOT NULL
);
CREATE TABLE columns (
    board_id TEXT NOT NULL REFERENCES boards(id),
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    is_done INTEGER NOT NULL CHECK (is_done IN (0, 1)),
    payload TEXT NOT NULL,
    PRIMARY KEY (board_id, id),
    UNIQUE (board_id, position)
);
CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    board_id TEXT NOT NULL,
    column_id TEXT NOT NULL,
    parent_id TEXT CHECK (parent_id IS NULL OR parent_id <> id),
    position REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    payload TEXT NOT NULL,
    FOREIGN KEY (board_id, column_id) REFERENCES columns(board_id, id),
    FOREIGN KEY (parent_id, board_id, column_id) REFERENCES tasks(id, board_id, column_id)
        DEFERRABLE INITIALLY DEFERRED,
    UNIQUE(id, board_id, column_id)
);
CREATE INDEX tasks_in_column ON tasks(board_id, column_id, position);
CREATE INDEX tasks_by_parent ON tasks(parent_id, position);

CREATE TABLE task_results (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (task_id, id),
    UNIQUE (task_id, position)
);
CREATE TABLE checklist_items (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (task_id, id),
    UNIQUE (task_id, position)
);
CREATE TABLE blobs (
    sha256 TEXT PRIMARY KEY NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    size INTEGER NOT NULL CHECK (size >= 0)
);
CREATE TABLE media (
    id TEXT PRIMARY KEY NOT NULL,
    blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
    thumb_sha256 TEXT REFERENCES blobs(sha256),
    mime TEXT NOT NULL,
    thumb_mime TEXT,
    CHECK ((thumb_sha256 IS NULL) = (thumb_mime IS NULL))
);
CREATE TABLE attachments (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    position INTEGER NOT NULL,
    media_id TEXT NOT NULL REFERENCES media(id),
    result_id TEXT,
    payload TEXT NOT NULL,
    FOREIGN KEY (task_id, result_id) REFERENCES task_results(task_id, id),
    PRIMARY KEY (task_id, position)
);
CREATE INDEX attachments_by_media ON attachments(media_id);
CREATE INDEX attachments_by_result ON attachments(task_id, result_id, position);
CREATE TABLE settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
