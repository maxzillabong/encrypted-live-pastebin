/**
 * LivePaste - E2E Encrypted Real-Time Collaborative Code Sharing
 * Express server with short polling (simple & proxy-friendly)
 */

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const BCRYPT_ROUNDS = 10;

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

// Get room info including password status
async function getRoomInfo(roomId) {
  const result = await pool.query(
    'SELECT id, version, password_hash IS NOT NULL as has_password FROM rooms WHERE id = $1',
    [roomId]
  );
  return result.rows[0] || null;
}

// Verify password for a room
async function verifyRoomPassword(roomId, password) {
  if (!password) return false;
  const result = await pool.query(
    'SELECT password_hash FROM rooms WHERE id = $1',
    [roomId]
  );
  const room = result.rows[0];
  if (!room || !room.password_hash) return true; // No password required
  return bcrypt.compare(password, room.password_hash);
}

// Middleware to check room password
function requireRoomPassword(req, res, next) {
  const roomId = req.params.id;
  const password = req.headers['x-room-password'] || req.query.password || '';

  getRoomInfo(roomId).then(room => {
    if (!room) {
      return next(); // Room doesn't exist yet, let ensureRoom handle it
    }
    if (!room.has_password) {
      return next(); // No password required
    }
    verifyRoomPassword(roomId, password).then(valid => {
      if (valid) {
        return next();
      }
      res.status(401).json({ error: 'Password required', password_required: true });
    }).catch(err => {
      console.error('[Auth] Password verification error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }).catch(err => {
    console.error('[Auth] Room info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });
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

// Serve room UI (no password check - UI handles password prompt)
app.get('/room/:id', async (req, res) => {
  await ensureRoom(req.params.id);
  res.type('html').send(htmlTemplate);
});

// Check if room has password (public endpoint)
app.get('/api/room/:id/info', async (req, res) => {
  try {
    await ensureRoom(req.params.id);
    const info = await getRoomInfo(req.params.id);
    res.json({
      id: info.id,
      has_password: info.has_password
    });
  } catch (err) {
    console.error('[API] Get room info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set or update room password (only if no password exists, or correct current password provided)
app.post('/api/room/:id/password', async (req, res) => {
  const roomId = req.params.id;
  const { password, current_password } = req.body;

  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  try {
    await ensureRoom(roomId);
    const room = await getRoomInfo(roomId);

    // If room already has a password, verify current password
    if (room.has_password) {
      const valid = await verifyRoomPassword(roomId, current_password);
      if (!valid) {
        return res.status(401).json({ error: 'Current password incorrect' });
      }
    }

    // Hash and store new password
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.query(
      'UPDATE rooms SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, roomId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[API] Set password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify password (for login)
app.post('/api/room/:id/verify-password', async (req, res) => {
  const roomId = req.params.id;
  const { password } = req.body;

  try {
    const valid = await verifyRoomPassword(roomId, password);
    if (valid) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Incorrect password' });
    }
  } catch (err) {
    console.error('[API] Verify password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get room state (password protected)
app.get('/api/room/:id', requireRoomPassword, async (req, res) => {
  try {
    await ensureRoom(req.params.id);
    const state = await getRoomState(req.params.id);
    const info = await getRoomInfo(req.params.id);
    res.json({ ...state, has_password: info.has_password });
  } catch (err) {
    console.error('[API] Get room error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get room version only (for short polling, password protected)
app.get('/api/room/:id/version', requireRoomPassword, async (req, res) => {
  try {
    const result = await pool.query('SELECT version FROM rooms WHERE id = $1', [req.params.id]);
    const version = result.rows[0]?.version || 0;
    res.json({ version });
  } catch (err) {
    console.error('[API] Get version error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create/update file (password protected)
app.post('/api/room/:id/files', requireRoomPassword, async (req, res) => {
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

// Delete file (password protected)
app.delete('/api/room/:id/files/:fileId', requireRoomPassword, async (req, res) => {
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

// Bulk sync files (password protected)
app.post('/api/room/:id/sync', requireRoomPassword, async (req, res) => {
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

// Create changeset (password protected)
app.post('/api/room/:id/changesets', requireRoomPassword, async (req, res) => {
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

// Accept entire changeset (password protected)
app.post('/api/room/:id/changesets/:changesetId/accept', requireRoomPassword, async (req, res) => {
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

// Reject entire changeset (password protected)
app.post('/api/room/:id/changesets/:changesetId/reject', requireRoomPassword, async (req, res) => {
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

// Accept single change (password protected)
app.post('/api/room/:id/changes/:changeId/accept', requireRoomPassword, async (req, res) => {
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

// Reject single change (password protected)
app.post('/api/room/:id/changes/:changeId/reject', requireRoomPassword, async (req, res) => {
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

// Delete room (kill switch)
app.delete('/api/room/:id', requireRoomPassword, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM rooms WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Delete room error:', err);
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
