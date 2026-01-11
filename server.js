/**
 * LivePaste - E2E Encrypted Real-Time Collaborative Code Sharing
 * Express server with short polling (simple & proxy-friendly)
 */

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BCRYPT_ROUNDS = 10;

const app = express();
app.use(express.json({ limit: '50mb' }));

// === Traffic Obfuscation Utilities ===
const STANDARD_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

function generatePadding(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function padPayload(data) {
  try {
    const json = JSON.stringify(data);
    const len = Buffer.byteLength(json, 'utf8');
    const targetSize = STANDARD_SIZES.find(s => s > len + 20) || len + 100; // +20 buffer
    const padLen = Math.max(0, targetSize - len - 10); // -10 for json overhead of _pad field
    if (padLen > 0) {
      return { ...data, _pad: generatePadding(padLen) };
    }
    return data;
  } catch (e) {
    return data;
  }
}

// Middleware to strip decoy fields
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    delete req.body._pad;
    delete req.body._analytics;
    delete req.body._sync;
    delete req.body._meta;
  }
  
  // Monkey-patch res.json to auto-pad responses
  const originalJson = res.json;
  res.json = function (obj) {
    if (obj && typeof obj === 'object') {
      // Add fake analytics to response too
      obj._meta = {
        server_ts: Date.now(),
        process_id: crypto.randomUUID().slice(0, 8),
        region: 'eu-central-1'
      };
      const padded = padPayload(obj);
      return originalJson.call(this, padded);
    }
    return originalJson.call(this, obj);
  };
  next();
});

// Fake Sync Endpoint (for cover traffic)
app.post('/api/workspace/sync', (req, res) => {
  // Just return success with some fake status
  res.json({
    sync_status: 'synced',
    cursor: req.body.cursor || '0',
    server_time: new Date().toISOString()
  });
});

// Database connection
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://livepaste:livepaste@localhost:5432/livepaste';
const pool = new Pool({ connectionString: DATABASE_URL });

// Room retention (default 24h, max 120h/5 days)
const RETENTION_HOURS = Math.max(1, Math.min(parseInt(process.env.RETENTION_HOURS, 10) || 24, 120));
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run cleanup every hour

// Load HTML template (serve from src/ in dev mode, public/ in production)
const SERVE_SRC = process.env.SERVE_SRC === '1';
const HTML_PATH = path.join(__dirname, SERVE_SRC ? 'src' : 'public', 'index.html');

function loadHtmlTemplate() {
  try {
    return fs.readFileSync(HTML_PATH, 'utf8');
  } catch (err) {
    console.error(`Failed to load HTML from ${HTML_PATH}:`, err.message);
    console.error('Run "npm run build" to generate public/index.html');
    process.exit(1);
  }
}
let htmlTemplate = loadHtmlTemplate();

// Hot-reload in dev mode
if (SERVE_SRC) {
  fs.watchFile(HTML_PATH, () => {
    console.log('Reloading HTML template...');
    htmlTemplate = loadHtmlTemplate();
  });
}

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
async function getRoomState(roomId, sinceVersion = 0, limit = 1000, offset = 0) {
  const roomResult = await pool.query(
    'SELECT version, op_seq FROM rooms WHERE id = $1',
    [roomId]
  );
  const version = roomResult.rows[0]?.version || 0;
  const opSeq = roomResult.rows[0]?.op_seq || 0;

  const filesResult = await pool.query(
    'SELECT id, path_hash, path_encrypted, content_encrypted, is_syncable, size_bytes, version, snapshot_seq FROM files WHERE room_id = $1 AND version > $2 ORDER BY path_encrypted LIMIT $3 OFFSET $4',
    [roomId, sinceVersion, limit, offset]
  );

  // Get deleted files since the requested version (for delta sync)
  let deletedPathHashes = [];
  if (sinceVersion > 0) {
    const deletedResult = await pool.query(
      'SELECT path_hash FROM deleted_files WHERE room_id = $1 AND deleted_at_version > $2',
      [roomId, sinceVersion]
    );
    deletedPathHashes = deletedResult.rows.map(r => r.path_hash);
  }

  const changesetsResult = await pool.query(
    "SELECT c.id, c.author_encrypted, c.message_encrypted, c.status, c.created_at, json_agg(json_build_object('id', ch.id, 'file_path_encrypted', ch.file_path_encrypted, 'old_content_encrypted', ch.old_content_encrypted, 'new_content_encrypted', ch.new_content_encrypted, 'diff_encrypted', ch.diff_encrypted, 'status', ch.status)) FILTER (WHERE ch.id IS NOT NULL) as changes FROM changesets c LEFT JOIN changes ch ON ch.changeset_id = c.id WHERE c.room_id = $1 AND c.status = 'pending' GROUP BY c.id ORDER BY c.created_at DESC",
    [roomId]
  );

  return {
    version,
    op_seq: opSeq,
    files: filesResult.rows,
    deleted_path_hashes: deletedPathHashes,
    has_more: filesResult.rows.length === limit,
    changesets: changesetsResult.rows.map(cs => ({
      ...cs,
      changes: cs.changes || []
    }))
  };
}

// Track file deletion for delta sync
async function trackDeletion(client, roomId, pathHash, version) {
  await client.query(
    'INSERT INTO deleted_files (room_id, path_hash, deleted_at_version) VALUES ($1, $2, $3)',
    [roomId, pathHash, version]
  );
}

// === API Routes ===

// === Disguised Routes (masquerade as document management app) ===
// These aliases make traffic look like a typical SaaS collaboration tool

// Workspace = Room
app.get('/api/workspace/:id', requireRoomPassword, async (req, res) => {
  try {
    await ensureRoom(req.params.id);
    const since = parseInt(req.query.since, 10) || 0;
    const limit = parseInt(req.query.limit, 10) || 1000;
    const offset = parseInt(req.query.offset, 10) || 0;
    
    const state = await getRoomState(req.params.id, since, limit, offset);
    const info = await getRoomInfo(req.params.id);
    // Wrap in document-like response
    res.json({
      workspace_id: req.params.id,
      documents: state.files.map(f => ({
        id: f.id,
        title: f.path_encrypted,
        content: f.content_encrypted,
        metadata: {
          refs: [f.path_hash],
          tracking: { utm_source: f.version?.toString() || '1' }
        },
        is_syncable: f.is_syncable,
        size_bytes: f.size_bytes,
        updated_at: f.updated_at
      })),
      version: state.version,
      op_seq: state.op_seq,
      has_more: state.has_more,
      has_password: info.has_password,
      proposals: state.changesets
    });
  } catch (err) {
    console.error('[API] Get workspace error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/workspace/:id/info', async (req, res) => {
  try {
    await ensureRoom(req.params.id);
    const info = await getRoomInfo(req.params.id);
    res.json({
      workspace_id: info.id,
      requires_auth: info.has_password,
      type: 'collaborative'
    });
  } catch (err) {
    console.error('[API] Get workspace info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/workspace/:id/status', requireRoomPassword, async (req, res) => {
  try {
    const result = await pool.query('SELECT version FROM rooms WHERE id = $1', [req.params.id]);
    res.json({
      workspace_id: req.params.id,
      revision: result.rows[0]?.version || 0,
      sync_status: 'current'
    });
  } catch (err) {
    console.error('[API] Get workspace status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Document save = File create/update
app.post('/api/documents/save', requireRoomPassword, async (req, res) => {
  const { workspace_id, title, content, metadata } = req.body;
  const roomId = workspace_id || req.query.workspace;

  // Extract real data from disguised payload
  const path_hash = metadata?.refs?.[0] || await hashString(title);
  const path_encrypted = title;
  const content_encrypted = content;

  try {
    await ensureRoom(roomId);
    const result = await pool.query(
      'INSERT INTO files (room_id, path_hash, path_encrypted, content_encrypted, is_syncable) VALUES ($1, $2, $3, $4, true) ON CONFLICT (room_id, path_hash) DO UPDATE SET path_encrypted = $3, content_encrypted = $4, version = files.version + 1, updated_at = NOW() RETURNING id, path_hash, version',
      [roomId, path_hash, path_encrypted, content_encrypted]
    );

    res.json({
      id: `doc_${result.rows[0].id.slice(0, 8)}`,
      title: path_encrypted,
      revision: result.rows[0].version,
      status: 'saved',
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[API] Document save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Document edits = Operations (tiny deltas)
app.post('/api/documents/:docId/edits', requireRoomPassword, async (req, res) => {
  const { workspace_id, edit_data, author_id, base_revision } = req.body;
  const roomId = workspace_id || req.query.workspace;
  const file_path_hash = req.params.docId;

  try {
    await ensureRoom(roomId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seqResult = await client.query(
        'UPDATE rooms SET op_seq = op_seq + 1, version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING op_seq',
        [roomId]
      );
      const seq = seqResult.rows[0].op_seq;

      await client.query(
        'INSERT INTO operations (room_id, file_path_hash, seq, op_encrypted, client_id, base_version) VALUES ($1, $2, $3, $4, $5, $6)',
        [roomId, file_path_hash, seq, edit_data, author_id, base_revision || 0]
      );
      await client.query('COMMIT');

      res.json({
        edit_id: `edit_${seq}`,
        revision: seq,
        status: 'applied',
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[API] Document edit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/documents/:docId/edits', requireRoomPassword, async (req, res) => {
  const roomId = req.query.workspace;
  const since = parseInt(req.query.since, 10) || 0;
  const filePathHash = req.params.docId;

  try {
    const result = await pool.query(
      'SELECT seq, op_encrypted, client_id, created_at FROM operations WHERE room_id = $1 AND file_path_hash = $2 AND seq > $3 ORDER BY seq ASC LIMIT 1000',
      [roomId, filePathHash, since]
    );
    const roomResult = await pool.query('SELECT op_seq FROM rooms WHERE id = $1', [roomId]);

    res.json({
      edits: result.rows.map(r => ({
        edit_id: `edit_${r.seq}`,
        data: r.op_encrypted,
        author_id: r.client_id,
        timestamp: r.created_at
      })),
      current_revision: roomResult.rows[0]?.op_seq || 0,
      has_more: result.rows.length === 1000
    });
  } catch (err) {
    console.error('[API] Get document edits error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Batch document sync = Chunked sync
app.post('/api/workspace/:id/session', requireRoomPassword, async (req, res) => {
  const roomId = req.params.id;
  const { client_id, batch_count, document_count } = req.body;

  try {
    await ensureRoom(roomId);
    const sessionId = crypto.randomUUID();
    syncSessions.set(`${roomId}:${sessionId}`, {
      roomId,
      clientId: client_id,
      totalChunks: batch_count,
      totalFiles: document_count,
      receivedChunks: 0,
      pathHashes: new Set(),
      startedAt: Date.now()
    });

    res.json({
      session_token: sessionId,
      status: 'ready',
      expires_at: new Date(Date.now() + SYNC_SESSION_TIMEOUT).toISOString()
    });
  } catch (err) {
    console.error('[API] Workspace session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/documents/batch', requireRoomPassword, async (req, res) => {
  const { workspace_id, session_token, batch_index, documents } = req.body;
  const roomId = workspace_id;
  const sessionKey = `${roomId}:${session_token}`;
  const session = syncSessions.get(sessionKey);

  if (!session) {
    return res.status(400).json({ error: 'Session expired' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const doc of documents) {
        const pathHash = doc.metadata?.refs?.[0] || doc.id;
        session.pathHashes.add(pathHash);
        await client.query(
          'INSERT INTO files (room_id, path_hash, path_encrypted, content_encrypted, is_syncable, size_bytes) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (room_id, path_hash) DO UPDATE SET path_encrypted = $3, content_encrypted = $4, is_syncable = $5, size_bytes = $6, version = files.version + 1, updated_at = NOW()',
          [roomId, pathHash, doc.title, doc.content, doc.is_syncable !== false, doc.size_bytes || null]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    session.receivedChunks++;
    res.json({
      status: 'ok',
      batch_index,
      documents_saved: documents.length,
      batches_remaining: session.totalChunks - session.receivedChunks
    });
  } catch (err) {
    console.error('[API] Batch save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/workspace/:id/finalize', requireRoomPassword, async (req, res) => {
  const roomId = req.params.id;
  const { session_token } = req.body;
  const sessionKey = `${roomId}:${session_token}`;
  const session = syncSessions.get(sessionKey);

  if (!session) {
    return res.status(400).json({ error: 'Session expired' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existingResult = await client.query('SELECT id, path_hash FROM files WHERE room_id = $1', [roomId]);

      // Find files to delete
      const filesToDelete = existingResult.rows.filter(row => !session.pathHashes.has(row.path_hash));

      // Only increment version and track deletions if files were actually deleted
      if (filesToDelete.length > 0) {
        const versionResult = await client.query(
          'UPDATE rooms SET version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING version',
          [roomId]
        );
        const newVersion = versionResult.rows[0].version;

        for (const row of filesToDelete) {
          await client.query('DELETE FROM files WHERE id = $1', [row.id]);
          // Track deletion for delta sync
          await trackDeletion(client, roomId, row.path_hash, newVersion);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    syncSessions.delete(sessionKey);
    const state = await getRoomState(roomId);

    // Return consistent format with both files[] and documents[] for compatibility
    res.json({
      status: 'complete',
      workspace_id: roomId,
      // Standard format (consistent with other endpoints)
      files: state.files,
      // Disguised format (for backward compatibility)
      documents: state.files.map(f => ({
        id: f.id,
        title: f.path_encrypted,
        content: f.content_encrypted,
        metadata: {
          refs: [f.path_hash],
          tracking: { utm_source: f.version?.toString() || '1' }
        },
        is_syncable: f.is_syncable,
        size_bytes: f.size_bytes,
        updated_at: f.updated_at
      })),
      version: state.version,
      op_seq: state.op_seq,
      deleted_path_hashes: state.deleted_path_hashes,
      documents_synced: session.pathHashes.size
    });
  } catch (err) {
    console.error('[API] Finalize error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper for generating path hash from title
async function hashString(str) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(str).digest('hex');
}

// === Original Routes (kept for backward compatibility) ===

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
    const since = parseInt(req.query.since, 10) || 0;
    const limit = parseInt(req.query.limit, 10) || 1000;
    const offset = parseInt(req.query.offset, 10) || 0;

    const state = await getRoomState(req.params.id, since, limit, offset);
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get the file's path_hash before deleting
      const fileResult = await client.query(
        'SELECT path_hash FROM files WHERE id = $1 AND room_id = $2',
        [fileId, roomId]
      );

      if (fileResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'File not found' });
      }

      const pathHash = fileResult.rows[0].path_hash;

      // Delete the file
      await client.query('DELETE FROM files WHERE id = $1', [fileId]);

      // Update room version and get new version
      const versionResult = await client.query(
        'UPDATE rooms SET version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING version',
        [roomId]
      );
      const newVersion = versionResult.rows[0].version;

      // Track deletion for delta sync
      await trackDeletion(client, roomId, pathHash, newVersion);

      await client.query('COMMIT');
      res.json({ success: true, version: newVersion });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[API] Delete file error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sync sessions for chunked uploads (in-memory, cleared on restart)
const syncSessions = new Map();
const SYNC_SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Clean up old sync sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of syncSessions) {
    if (now - session.startedAt > SYNC_SESSION_TIMEOUT) {
      syncSessions.delete(key);
    }
  }
}, 60 * 1000);

// Begin chunked sync session
app.post('/api/room/:id/sync/begin', requireRoomPassword, async (req, res) => {
  const roomId = req.params.id;
  const { client_id, total_chunks, total_files, metadata } = req.body;

  try {
    await ensureRoom(roomId);

    const sessionId = crypto.randomUUID();
    syncSessions.set(`${roomId}:${sessionId}`, {
      roomId,
      clientId: client_id,
      totalChunks: total_chunks,
      totalFiles: total_files,
      receivedChunks: 0,
      pathHashes: new Set(),
      startedAt: Date.now(),
      metadata
    });

    res.json({
      session_id: sessionId,
      status: 'ready',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[API] Sync begin error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload a chunk of files
app.post('/api/room/:id/sync/chunk', requireRoomPassword, async (req, res) => {
  const roomId = req.params.id;
  const { session_id, chunk_index, files, client_timestamp, request_id } = req.body;

  const sessionKey = `${roomId}:${session_id}`;
  const session = syncSessions.get(sessionKey);

  if (!session) {
    return res.status(400).json({ error: 'Invalid or expired sync session' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const file of files) {
        session.pathHashes.add(file.path_hash);
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

    session.receivedChunks++;

    res.json({
      status: 'ok',
      chunk_index,
      files_received: files.length,
      chunks_remaining: session.totalChunks - session.receivedChunks,
      request_id,
      server_timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[API] Sync chunk error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete chunked sync - delete files not in sync
app.post('/api/room/:id/sync/complete', requireRoomPassword, async (req, res) => {
  const roomId = req.params.id;
  const { session_id, client_checksum, finalize } = req.body;

  const sessionKey = `${roomId}:${session_id}`;
  const session = syncSessions.get(sessionKey);

  if (!session) {
    return res.status(400).json({ error: 'Invalid or expired sync session' });
  }

  let deletedCount = 0;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Find files not in the sync session
      const existingResult = await client.query(
        'SELECT id, path_hash FROM files WHERE room_id = $1',
        [roomId]
      );

      const filesToDelete = existingResult.rows.filter(row => !session.pathHashes.has(row.path_hash));
      deletedCount = filesToDelete.length;

      // Only increment version and track deletions if files were actually deleted
      if (filesToDelete.length > 0) {
        const versionResult = await client.query(
          'UPDATE rooms SET version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING version',
          [roomId]
        );
        const newVersion = versionResult.rows[0].version;

        for (const row of filesToDelete) {
          await client.query('DELETE FROM files WHERE id = $1', [row.id]);
          // Track deletion for delta sync
          await trackDeletion(client, roomId, row.path_hash, newVersion);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Clean up session
    syncSessions.delete(sessionKey);

    const state = await getRoomState(roomId);
    res.json({
      ...state,
      sync_complete: true,
      files_synced: session.pathHashes.size,
      files_deleted: deletedCount,
      server_timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[API] Sync complete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy bulk sync (kept for backward compatibility)
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

      // Find files to delete
      const pathsToDelete = [...existingPaths.entries()].filter(([pathHash]) => !newPaths.has(pathHash));

      // Only increment version and track deletions if files were actually deleted
      if (pathsToDelete.length > 0) {
        const versionResult = await client.query(
          'UPDATE rooms SET version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING version',
          [roomId]
        );
        const newVersion = versionResult.rows[0].version;

        for (const [pathHash, id] of pathsToDelete) {
          await client.query('DELETE FROM files WHERE id = $1', [id]);
          // Track deletion for delta sync
          await trackDeletion(client, roomId, pathHash, newVersion);
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

// === Operations (tiny deltas for real-time editing) ===
// These endpoints enable Google Docs-style traffic patterns with OT conflict detection

// Submit an operation (tiny encrypted delta)
app.post('/api/room/:id/ops', requireRoomPassword, async (req, res) => {
  const roomId = req.params.id;
  const { file_path_hash, op_encrypted, client_id, base_version, metadata } = req.body;

  try {
    await ensureRoom(roomId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the room row to prevent concurrent operations from racing
      await client.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);

      // Check for OT conflicts: get file's current version and pending ops
      // Use FOR UPDATE to lock the file row and prevent race conditions
      const fileResult = await client.query(
        'SELECT version, snapshot_seq FROM files WHERE room_id = $1 AND path_hash = $2 FOR UPDATE',
        [roomId, file_path_hash]
      );

      const currentFileVersion = fileResult.rows[0]?.version || 0;
      const snapshotSeq = fileResult.rows[0]?.snapshot_seq || 0;

      // If base_version is provided, check for conflicts
      // Also check when file exists but client has base_version=0 (stale client)
      if (base_version !== undefined && (base_version > 0 || currentFileVersion > 0)) {
        // Get operations that happened since the client's base version
        const conflictOpsResult = await client.query(
          'SELECT seq, op_encrypted, client_id FROM operations WHERE room_id = $1 AND file_path_hash = $2 AND seq > $3 ORDER BY seq ASC',
          [roomId, file_path_hash, snapshotSeq]
        );

        // Filter out own client's ops
        const conflictingOps = conflictOpsResult.rows.filter(op => op.client_id !== client_id);

        // If there are conflicting ops from other clients and client is behind, return conflict
        if (conflictingOps.length > 0 && base_version < currentFileVersion) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'conflict',
            message: 'Operation conflicts with concurrent edits',
            current_version: currentFileVersion,
            base_version: base_version,
            conflicting_ops: conflictingOps.map(op => ({
              seq: op.seq,
              op_encrypted: op.op_encrypted,
              client_id: op.client_id
            })),
            server_timestamp: new Date().toISOString()
          });
        }
      }

      // Get next sequence number atomically
      const seqResult = await client.query(
        'UPDATE rooms SET op_seq = op_seq + 1, version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING op_seq',
        [roomId]
      );
      const seq = seqResult.rows[0].op_seq;

      // Insert operation
      await client.query(
        'INSERT INTO operations (room_id, file_path_hash, seq, op_encrypted, client_id, base_version) VALUES ($1, $2, $3, $4, $5, $6)',
        [roomId, file_path_hash, seq, op_encrypted, client_id, base_version || 0]
      );

      await client.query('COMMIT');

      res.json({
        seq,
        status: 'ok',
        current_version: currentFileVersion + 1,
        server_timestamp: new Date().toISOString()
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[API] Submit operation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get operations since a sequence number
app.get('/api/room/:id/ops', requireRoomPassword, async (req, res) => {
  const roomId = req.params.id;
  const since = parseInt(req.query.since, 10) || 0;
  const filePathHash = req.query.file; // Optional: filter by file

  try {
    let query = 'SELECT seq, file_path_hash, op_encrypted, client_id, base_version, created_at FROM operations WHERE room_id = $1 AND seq > $2';
    const params = [roomId, since];

    if (filePathHash) {
      query += ' AND file_path_hash = $3';
      params.push(filePathHash);
    }

    query += ' ORDER BY seq ASC LIMIT 1000'; // Cap at 1000 ops per request

    const result = await pool.query(query, params);

    // Get current sequence
    const roomResult = await pool.query('SELECT op_seq FROM rooms WHERE id = $1', [roomId]);
    const currentSeq = roomResult.rows[0]?.op_seq || 0;

    res.json({
      ops: result.rows,
      current_seq: currentSeq,
      has_more: result.rows.length === 1000
    });
  } catch (err) {
    console.error('[API] Get operations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Snapshot a file (compact operations into content)
app.post('/api/room/:id/files/:pathHash/snapshot', requireRoomPassword, async (req, res) => {
  const { id: roomId, pathHash } = req.params;
  const { content_encrypted, through_seq } = req.body;

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update file content and snapshot_seq
      await client.query(
        `UPDATE files SET
          content_encrypted = $1,
          snapshot_seq = $2,
          version = version + 1,
          updated_at = NOW()
        WHERE room_id = $3 AND path_hash = $4`,
        [content_encrypted, through_seq, roomId, pathHash]
      );

      // Delete old operations for this file that are now in the snapshot
      await client.query(
        'DELETE FROM operations WHERE room_id = $1 AND file_path_hash = $2 AND seq <= $3',
        [roomId, pathHash, through_seq]
      );

      await client.query('COMMIT');

      res.json({
        status: 'ok',
        snapshot_seq: through_seq,
        server_timestamp: new Date().toISOString()
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[API] Snapshot error:', err);
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
const DELETION_HISTORY_VERSIONS = 100; // Keep deletion records for last N versions per room

async function runCleanup() {
  try {
    // Clean up expired rooms
    const result = await pool.query('SELECT cleanup_old_rooms($1) as deleted', [RETENTION_HOURS]);
    const deleted = result.rows[0]?.deleted || 0;
    if (deleted > 0) {
      console.log(`[Cleanup] Deleted ${deleted} room(s) older than ${RETENTION_HOURS}h`);
    }

    // Clean up old deletion records for active rooms (prevent unbounded growth)
    const cleanupResult = await pool.query(`
      DELETE FROM deleted_files df
      WHERE df.deleted_at_version < (
        SELECT r.version - $1 FROM rooms r WHERE r.id = df.room_id
      )
    `, [DELETION_HISTORY_VERSIONS]);

    if (cleanupResult.rowCount > 0) {
      console.log(`[Cleanup] Pruned ${cleanupResult.rowCount} old deletion record(s)`);
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
