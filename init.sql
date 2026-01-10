-- LivePaste Database Schema
-- E2E encrypted real-time collaborative code sharing

-- Rooms (tracks existence and version)
CREATE TABLE rooms (
    id VARCHAR(32) PRIMARY KEY,
    version BIGINT NOT NULL DEFAULT 0,
    op_seq BIGINT NOT NULL DEFAULT 0,        -- next operation sequence number
    password_hash TEXT,                      -- bcrypt hash of room password (NULL = no password)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Files (encrypted content and paths)
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    path_hash VARCHAR(64) NOT NULL,         -- SHA-256 hash of plaintext path (for upsert)
    path_encrypted TEXT NOT NULL,           -- encrypted file path
    content_encrypted TEXT,                 -- encrypted content (NULL for non-syncable)
    is_syncable BOOLEAN NOT NULL DEFAULT true,
    size_bytes BIGINT,                      -- for non-syncable files, show size
    version BIGINT NOT NULL DEFAULT 1,
    snapshot_seq BIGINT NOT NULL DEFAULT 0, -- op_seq when content was last snapshotted
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(room_id, path_hash)
);

-- Changesets (proposed changes from AI or collaborators)
CREATE TABLE changesets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    author_encrypted TEXT,                  -- encrypted: 'claude', 'user-abc', etc
    message_encrypted TEXT,                 -- encrypted: "Fixed async/await issues"
    status VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending, accepted, rejected, partial
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- Individual changes within a changeset
CREATE TABLE changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    changeset_id UUID NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
    file_path_encrypted TEXT NOT NULL,      -- encrypted file path
    old_content_encrypted TEXT,             -- encrypted: original content (for diff)
    new_content_encrypted TEXT NOT NULL,    -- encrypted: proposed new content
    diff_encrypted TEXT,                    -- encrypted: unified diff format
    status VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending, accepted, rejected
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Operations (real-time collaborative edits - tiny encrypted deltas)
-- This enables Google Docs-style traffic patterns that evade entropy detection
CREATE TABLE operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    file_path_hash VARCHAR(64) NOT NULL,    -- which file (matches files.path_hash)
    seq BIGINT NOT NULL,                     -- sequence number for ordering (per room)
    op_encrypted TEXT NOT NULL,              -- encrypted: {pos, del, ins} - typically <500 bytes
    client_id VARCHAR(64),                   -- which client sent this (for filtering own ops)
    base_version BIGINT NOT NULL DEFAULT 0,  -- file version this op was based on
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_files_room_id ON files(room_id);
CREATE INDEX idx_changesets_room_id ON changesets(room_id);
CREATE INDEX idx_changesets_status ON changesets(status);
CREATE INDEX idx_changes_changeset_id ON changes(changeset_id);
CREATE INDEX idx_rooms_updated_at ON rooms(updated_at);
CREATE INDEX idx_operations_room_seq ON operations(room_id, seq);
CREATE INDEX idx_operations_file ON operations(room_id, file_path_hash);

-- Notify function for room updates (files and changesets which have room_id)
CREATE OR REPLACE FUNCTION notify_room_update()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE rooms SET version = version + 1, updated_at = NOW() WHERE id = NEW.room_id;
    PERFORM pg_notify('room_' || NEW.room_id, (SELECT version::text FROM rooms WHERE id = NEW.room_id));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Notify function for changes (must look up room_id via changeset)
CREATE OR REPLACE FUNCTION notify_change_update()
RETURNS TRIGGER AS $$
DECLARE
    v_room_id VARCHAR(32);
BEGIN
    SELECT room_id INTO v_room_id FROM changesets WHERE id = NEW.changeset_id;
    IF v_room_id IS NOT NULL THEN
        UPDATE rooms SET version = version + 1, updated_at = NOW() WHERE id = v_room_id;
        PERFORM pg_notify('room_' || v_room_id, (SELECT version::text FROM rooms WHERE id = v_room_id));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Notify on file changes
CREATE TRIGGER file_updated
    AFTER INSERT OR UPDATE ON files
    FOR EACH ROW
    EXECUTE FUNCTION notify_room_update();

-- Notify on new changesets
CREATE TRIGGER changeset_created
    AFTER INSERT ON changesets
    FOR EACH ROW
    EXECUTE FUNCTION notify_room_update();

-- Notify on change status updates (uses different function since changes table has no room_id)
CREATE TRIGGER change_updated
    AFTER UPDATE ON changes
    FOR EACH ROW
    EXECUTE FUNCTION notify_change_update();

-- Notify on new operations (tiny deltas for real-time editing)
CREATE TRIGGER operation_created
    AFTER INSERT ON operations
    FOR EACH ROW
    EXECUTE FUNCTION notify_room_update();

-- Cleanup rooms older than specified hours (default 24, max 120/5 days)
CREATE OR REPLACE FUNCTION cleanup_old_rooms(retention_hours INTEGER DEFAULT 24)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
    safe_hours INTEGER;
BEGIN
    -- Clamp retention between 1 and 120 hours (5 days max)
    safe_hours := GREATEST(1, LEAST(retention_hours, 120));
    DELETE FROM rooms WHERE updated_at < NOW() - (safe_hours || ' hours')::INTERVAL;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
