/**
 * LivePaste - E2E Encrypted Real-Time Collaborative Code Sharing
 * Express server with short polling (simple & proxy-friendly)
 */

const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Database connection
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://livepaste:livepaste@localhost:5432/livepaste';
const pool = new Pool({ connectionString: DATABASE_URL });

// Room retention (default 24h, max 120h/5 days)
const RETENTION_HOURS = Math.max(1, Math.min(parseInt(process.env.RETENTION_HOURS, 10) || 24, 120));
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run cleanup every hour

// Load HTML template
const htmlTemplate = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// Generate random room ID
function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Ensure room exists
async function ensureRoom(roomId) {
  await pool.query(
    'INSERT INTO rooms (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
    [roomId]
  );
}

// Get room state
async function getRoomState(roomId) {
  const roomResult = await pool.query(
    'SELECT version FROM rooms WHERE id = $1',
    [roomId]
  );
  const version = roomResult.rows[0]?.version || 0;

  const filesResult = await pool.query(
    'SELECT id, path_hash, path_encrypted, content_encrypted, is_syncable, size_bytes, version FROM files WHERE room_id = $1 ORDER BY path_encrypted',
    [roomId]
  );

  const changesetsResult = await pool.query(
    "SELECT c.id, c.author_encrypted, c.message_encrypted, c.status, c.created_at, json_agg(json_build_object('id', ch.id, 'file_path_encrypted', ch.file_path_encrypted, 'old_content_encrypted', ch.old_content_encrypted, 'new_content_encrypted', ch.new_content_encrypted, 'diff_encrypted', ch.diff_encrypted, 'status', ch.status)) FILTER (WHERE ch.id IS NOT NULL) as changes FROM changesets c LEFT JOIN changes ch ON ch.changeset_id = c.id WHERE c.room_id = $1 AND c.status = 'pending' GROUP BY c.id ORDER BY c.created_at DESC",
    [roomId]
  );

  return {
    version,
    files: filesResult.rows,
    changesets: changesetsResult.rows.map(cs => ({
      ...cs,
      changes: cs.changes || []
    }))
  };
}

// === API Routes ===

// Redirect to new room
app.get('/', (req, res) => {
  res.redirect('/room/' + generateRoomId());
});

// Serve room UI
app.get('/room/:id', async (req, res) => {
  await ensureRoom(req.params.id);
  res.type('html').send(htmlTemplate);
});

// Get room state
app.get('/api/room/:id', async (req, res) => {
  try {
    await ensureRoom(req.params.id);
    const state = await getRoomState(req.params.id);
    res.json(state);
  } catch (err) {
    console.error('[API] Get room error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get room version only (for short polling)
app.get('/api/room/:id/version', async (req, res) => {
  try {
    const result = await pool.query('SELECT version FROM rooms WHERE id = $1', [req.params.id]);
    const version = result.rows[0]?.version || 0;
    res.json({ version });
  } catch (err) {
    console.error('[API] Get version error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create/update file
app.post('/api/room/:id/files', async (req, res) => {
  const roomId = req.params.id;
  const { path_hash, path_encrypted, content_encrypted, is_syncable, size_bytes } = req.body;

  try {
    await ensureRoom(roomId);

    const result = await pool.query(
      'INSERT INTO files (room_id, path_hash, path_encrypted, content_encrypted, is_syncable, size_bytes) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (room_id, path_hash) DO UPDATE SET path_encrypted = $3, content_encrypted = $4, is_syncable = $5, size_bytes = $6, version = files.version + 1, updated_at = NOW() RETURNING id, path_hash, path_encrypted, content_encrypted, is_syncable, size_bytes, version',
      [roomId, path_hash, path_encrypted, content_encrypted, is_syncable !== false, size_bytes || null]
    );

    const roomVersion = await pool.query('SELECT version FROM rooms WHERE id = $1', [roomId]);

    res.json({
      ...result.rows[0],
      room_version: roomVersion.rows[0]?.version || 0
    });
  } catch (err) {
    console.error('[API] Create file error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete file
app.delete('/api/room/:id/files/:fileId', async (req, res) => {
  const { id: roomId, fileId } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM files WHERE id = $1 AND room_id = $2 RETURNING id',
      [fileId, roomId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Update room version
    await pool.query('UPDATE rooms SET version = version + 1, updated_at = NOW() WHERE id = $1', [roomId]);

    res.json({ success: true });
  } catch (err) {
    console.error('[API] Delete file error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk sync files
app.post('/api/room/:id/sync', async (req, res) => {
  const roomId = req.params.id;
  const { files } = req.body;

  console.log(`[API] Sync request for room ${roomId}: ${files?.length || 0} files`);

  try {
    await ensureRoom(roomId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingResult = await client.query(
        'SELECT id, path_hash FROM files WHERE room_id = $1',
        [roomId]
      );
      const existingPaths = new Map(existingResult.rows.map(r => [r.path_hash, r.id]));
      const newPaths = new Set(files.map(f => f.path_hash));

      for (const [pathHash, id] of existingPaths) {
        if (!newPaths.has(pathHash)) {
          await client.query('DELETE FROM files WHERE id = $1', [id]);
        }
      }

      for (const file of files) {
        await client.query(
          'INSERT INTO files (room_id, path_hash, path_encrypted, content_encrypted, is_syncable, size_bytes) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (room_id, path_hash) DO UPDATE SET path_encrypted = $3, content_encrypted = $4, is_syncable = $5, size_bytes = $6, version = files.version + 1, updated_at = NOW()',
          [roomId, file.path_hash, file.path_encrypted, file.content_encrypted, file.is_syncable !== false, file.size_bytes || null]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const state = await getRoomState(roomId);
    res.json(state);
  } catch (err) {
    console.error('[API] Sync error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create changeset
app.post('/api/room/:id/changesets', async (req, res) => {
  const roomId = req.params.id;
  const { author_encrypted, message_encrypted, changes } = req.body;

  try {
    await ensureRoom(roomId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const changesetResult = await client.query(
        'INSERT INTO changesets (room_id, author_encrypted, message_encrypted) VALUES ($1, $2, $3) RETURNING *',
        [roomId, author_encrypted, message_encrypted]
      );
      const changeset = changesetResult.rows[0];

      const insertedChanges = [];
      for (const change of changes) {
        const changeResult = await client.query(
          'INSERT INTO changes (changeset_id, file_path_encrypted, old_content_encrypted, new_content_encrypted, diff_encrypted) VALUES ($1, $2, $3, $4, $5) RETURNING *',
          [changeset.id, change.file_path_encrypted, change.old_content_encrypted, change.new_content_encrypted, change.diff_encrypted]
        );
        insertedChanges.push(changeResult.rows[0]);
      }

      await client.query('COMMIT');

      res.json({
        ...changeset,
        changes: insertedChanges
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[API] Create changeset error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Accept entire changeset
app.post('/api/room/:id/changesets/:changesetId/accept', async (req, res) => {
  const { id: roomId, changesetId } = req.params;

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const changesResult = await client.query(
        "SELECT * FROM changes WHERE changeset_id = $1 AND status = 'pending'",
        [changesetId]
      );

      for (const change of changesResult.rows) {
        await client.query(
          'INSERT INTO files (room_id, path_encrypted, content_encrypted) VALUES ($1, $2, $3) ON CONFLICT (room_id, path_encrypted) DO UPDATE SET content_encrypted = $3, version = files.version + 1, updated_at = NOW()',
          [roomId, change.file_path_encrypted, change.new_content_encrypted]
        );
        await client.query("UPDATE changes SET status = 'accepted' WHERE id = $1", [change.id]);
      }

      await client.query(
        "UPDATE changesets SET status = 'accepted', resolved_at = NOW() WHERE id = $1",
        [changesetId]
      );

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[API] Accept changeset error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reject entire changeset
app.post('/api/room/:id/changesets/:changesetId/reject', async (req, res) => {
  const { changesetId } = req.params;

  try {
    await pool.query("UPDATE changes SET status = 'rejected' WHERE changeset_id = $1", [changesetId]);
    await pool.query(
      "UPDATE changesets SET status = 'rejected', resolved_at = NOW() WHERE id = $1",
      [changesetId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Reject changeset error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Accept single change
app.post('/api/room/:id/changes/:changeId/accept', async (req, res) => {
  const { id: roomId, changeId } = req.params;

  try {
    const changeResult = await pool.query('SELECT * FROM changes WHERE id = $1', [changeId]);
    const change = changeResult.rows[0];

    if (!change) {
      return res.status(404).json({ error: 'Change not found' });
    }

    await pool.query(
      'INSERT INTO files (room_id, path_encrypted, content_encrypted) VALUES ($1, $2, $3) ON CONFLICT (room_id, path_encrypted) DO UPDATE SET content_encrypted = $3, version = files.version + 1, updated_at = NOW()',
      [roomId, change.file_path_encrypted, change.new_content_encrypted]
    );

    await pool.query("UPDATE changes SET status = 'accepted' WHERE id = $1", [changeId]);

    const pendingResult = await pool.query(
      "SELECT COUNT(*) FROM changes WHERE changeset_id = $1 AND status = 'pending'",
      [change.changeset_id]
    );
    if (parseInt(pendingResult.rows[0].count, 10) === 0) {
      await pool.query(
        "UPDATE changesets SET status = 'partial', resolved_at = NOW() WHERE id = $1",
        [change.changeset_id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[API] Accept change error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reject single change
app.post('/api/room/:id/changes/:changeId/reject', async (req, res) => {
  const { changeId } = req.params;

  try {
    const changeResult = await pool.query('SELECT changeset_id FROM changes WHERE id = $1', [changeId]);
    const change = changeResult.rows[0];

    if (!change) {
      return res.status(404).json({ error: 'Change not found' });
    }

    await pool.query("UPDATE changes SET status = 'rejected' WHERE id = $1", [changeId]);

    const pendingResult = await pool.query(
      "SELECT COUNT(*) FROM changes WHERE changeset_id = $1 AND status = 'pending'",
      [change.changeset_id]
    );
    if (parseInt(pendingResult.rows[0].count, 10) === 0) {
      await pool.query(
        "UPDATE changesets SET status = 'partial', resolved_at = NOW() WHERE id = $1",
        [change.changeset_id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[API] Reject change error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// === Cleanup ===
async function runCleanup() {
  try {
    const result = await pool.query('SELECT cleanup_old_rooms($1) as deleted', [RETENTION_HOURS]);
    const deleted = result.rows[0]?.deleted || 0;
    if (deleted > 0) {
      console.log(`[Cleanup] Deleted ${deleted} room(s) older than ${RETENTION_HOURS}h`);
    }
  } catch (err) {
    console.error('[Cleanup] Error:', err.message);
  }
}

// === Start Server ===
const PORT = process.env.PORT || 8080;

async function start() {
  // Run cleanup on startup and then every hour
  await runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  console.log(`[Cleanup] Scheduled every hour (retention: ${RETENTION_HOURS}h)`);

  app.listen(PORT, () => {
    console.log('[Server] LivePaste running on http://localhost:' + PORT);
  });
}

start().catch(console.error);
