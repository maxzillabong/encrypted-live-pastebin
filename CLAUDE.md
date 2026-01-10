# CLAUDE.md - LivePaste Technical Documentation

## Project Overview

LivePaste is an end-to-end encrypted, real-time collaborative code sharing tool designed for **enterprise proxy compatibility** (Zscaler, corporate firewalls, DLP systems).

**Core concept:** Open browser, upload a folder, share a URL (with encryption key in fragment), others see and edit the same files in real-time.

**Key constraints:**
- 100% web-based (no CLI, no installation)
- Works through enterprise proxies (Zscaler, etc.)
- Zero-knowledge encryption (server sees only encrypted blobs)

## Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│    Browser A    │         │   Node Server   │         │    Postgres     │
│                 │         │   (stateless)   │         │                 │
│ - File tree UI  │◄──HTTP──►│ - REST API     │◄──SQL───►│ - rooms table   │
│ - E2E encrypt   │  2s poll │ - No WebSocket │         │ - files table   │
│ - Chunked sync  │         │ - Chunked sync │         │ - changesets    │
│ - CodeMirror    │         │                 │         │                 │
└─────────────────┘         └─────────────────┘         └─────────────────┘
```

## Enterprise Proxy Compatibility

### Why It Works Through Zscaler

1. **Simple Short Polling** - 2-second HTTP GET requests (no long-held connections)
2. **No WebSockets/SSE** - Pure HTTP/HTTPS on standard ports
3. **Chunked Uploads** - ~150KB per request (under DLP thresholds)
4. **Randomized Timing** - 200-800ms delays between chunks (mimics human patterns)
5. **Low-Entropy Metadata** - JSON wrapper with normal-looking fields balances high-entropy encrypted content
6. **Base64 Encoding** - Encrypted content uses standard base64 (ubiquitous in web APIs)

### What Goes Over the Wire

```json
{
  "session_id": "abc123",
  "chunk_index": 0,
  "files": [
    {
      "path_hash": "a1b2c3d4...",
      "path_encrypted": "base64...",
      "content_encrypted": "base64...",
      "is_syncable": true
    }
  ],
  "client_timestamp": "2024-01-15T10:30:00.000Z",
  "request_id": "req_abc123",
  "metadata": {
    "action": "sync",
    "source": "browser",
    "client_version": "1.0.0",
    "platform": "MacIntel",
    "locale": "en-US",
    "timezone": "America/New_York",
    "screen": "1920x1080",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

The metadata fields provide low-entropy "cover" that makes the payload look like a standard web API call.

## E2E Encryption Scheme

The encryption key lives in the URL fragment and **NEVER** reaches the server:

```
https://livepaste.app/room/abc123#K8x7mP2nQ9vR4sT6wY8zA1bC3dE5fG7hJ
                                  └──────── 256-bit AES key ────────┘
```

- **Algorithm:** AES-256-GCM (WebCrypto API)
- **Key:** 256-bit random, base64url-encoded in URL fragment
- **IV:** Random 12 bytes per encryption, prepended to ciphertext
- **Encrypted:** Both file content AND file paths (true zero-knowledge)

```javascript
// Encryption
const iv = crypto.getRandomValues(new Uint8Array(12));
const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
// Store: base64(iv + ciphertext)

// Decryption
const iv = data.slice(0, 12);
const ciphertext = data.slice(12);
const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
```

## Polling Architecture

**Simple 2-second polling** (not long polling):

```javascript
// Client polls every 2 seconds
setInterval(async () => {
  const { version } = await fetch('/api/room/:id/version');
  if (version > localVersion) {
    const state = await fetch('/api/room/:id');
    applyState(state);
  }
}, 2000);
```

**Polling pauses during typing** to prevent overwrites:
```javascript
const POLLING_PAUSE_MS = 2000;
if (Date.now() - lastActivityTime < POLLING_PAUSE_MS) return;
```

## Chunked Upload System

Large folder uploads are split into small chunks for proxy compatibility:

```
400 files (4MB) → Encrypt → Split into ~150KB chunks → Upload with random delays
```

### Upload Flow

1. **POST /api/room/:id/sync/begin** - Start session, get session_id
2. **POST /api/room/:id/sync/chunk** (repeated) - Upload each chunk with 200-800ms delays
3. **POST /api/room/:id/sync/complete** - Finalize, delete files not in sync

### Chunk Configuration

```javascript
const CHUNK_TARGET_SIZE = 150 * 1024;  // ~150KB per chunk
const CHUNK_MIN_DELAY = 200;           // Min delay between chunks (ms)
const CHUNK_MAX_DELAY = 800;           // Max delay between chunks (ms)
```

## Database Schema

```sql
-- Rooms with optional password protection
CREATE TABLE rooms (
    id VARCHAR(32) PRIMARY KEY,
    version BIGINT NOT NULL DEFAULT 0,
    password_hash TEXT,                     -- bcrypt hash (NULL = no password)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Files with encrypted content and paths
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    path_hash VARCHAR(64) NOT NULL,         -- SHA-256 hash for upsert
    path_encrypted TEXT NOT NULL,           -- encrypted path
    content_encrypted TEXT,                 -- encrypted content (NULL for binary)
    is_syncable BOOLEAN NOT NULL DEFAULT true,
    size_bytes BIGINT,                      -- for non-syncable files
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(room_id, path_hash)
);

-- Changesets for AI/collaborator proposals
CREATE TABLE changesets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    author_encrypted TEXT,
    message_encrypted TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- Individual changes within a changeset
CREATE TABLE changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    changeset_id UUID NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
    file_path_encrypted TEXT NOT NULL,
    old_content_encrypted TEXT,
    new_content_encrypted TEXT NOT NULL,
    diff_encrypted TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## API Endpoints

### Room Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Redirect to new room |
| GET | `/room/:id` | Serve web UI |
| GET | `/api/room/:id/info` | Check if room has password |
| GET | `/api/room/:id` | Get room state (password protected) |
| GET | `/api/room/:id/version` | Get version only (for polling) |
| DELETE | `/api/room/:id` | Delete room (kill switch) |

### Password Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/room/:id/password` | Set/update password |
| POST | `/api/room/:id/verify-password` | Verify password |

### File Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/room/:id/files` | Create/update file |
| DELETE | `/api/room/:id/files/:fileId` | Delete file |

### Chunked Sync (Enterprise-Friendly)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/room/:id/sync/begin` | Start sync session |
| POST | `/api/room/:id/sync/chunk` | Upload file chunk |
| POST | `/api/room/:id/sync/complete` | Complete sync |
| POST | `/api/room/:id/sync` | Legacy bulk sync (backward compat) |

### Changesets

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/room/:id/changesets` | Create changeset |
| POST | `/api/room/:id/changesets/:id/accept` | Accept all changes |
| POST | `/api/room/:id/changesets/:id/reject` | Reject all changes |
| POST | `/api/room/:id/changes/:id/accept` | Accept single change |
| POST | `/api/room/:id/changes/:id/reject` | Reject single change |

## Features

### Password Protection
- Optional bcrypt-hashed password per room
- Password sent via `X-Room-Password` header (SHA-256 hashed client-side first)
- Stored in sessionStorage for session persistence

### Room Kill Switch
- DELETE `/api/room/:id` permanently deletes room and all files
- Cascades to files, changesets, and changes

### File Filtering

**Syncable extensions:**
```javascript
const SYNCABLE_EXT = new Set([
  '.js','.ts','.jsx','.tsx','.mjs','.cjs','.py','.java','.kt','.go',
  '.rs','.rb','.php','.swift','.c','.cpp','.h','.cs','.lua','.sh',
  '.bash','.json','.yaml','.yml','.toml','.xml','.html','.htm','.css',
  '.scss','.sass','.md','.mdx','.txt','.sql','.vue','.svelte','.env',
  '.gitignore','.dockerfile'
]);
```

**Never sync:**
```javascript
const NEVER_SYNC_EXT = new Set([
  '.jar','.exe','.dll','.so','.o','.pyc','.wasm','.zip','.tar','.gz',
  '.png','.jpg','.jpeg','.gif','.ico','.svg','.mp3','.mp4','.wav',
  '.woff','.woff2','.ttf','.pdf','.doc','.docx','.db','.sqlite','.pem'
]);

const NEVER_SYNC_DIRS = new Set([
  'node_modules','.git','dist','build','out','target','__pycache__',
  '.next','vendor','venv','.venv','coverage','.idea','.vscode'
]);
```

### Gitignore Support
- Parses `.gitignore` if present in uploaded folder
- Applies gitignore patterns during upload filtering

## Project Structure

```
livepaste/
├── server.js            # Express server (all backend logic)
├── public/
│   └── index.html       # Complete frontend (single file)
├── init.sql             # Database schema
├── docker-compose.yml   # Postgres + App
├── Dockerfile           # Node app container
├── package.json
└── CLAUDE.md            # This file
```

## External Dependencies (CDN)

```html
<!-- Editor -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/material-darker.min.css">

<!-- ZIP generation -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>

<!-- Diff generation -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jsdiff/5.1.0/diff.min.js"></script>
```

## Environment Variables

```bash
DATABASE_URL=postgres://user:pass@host:5432/livepaste
PORT=8080
RETENTION_HOURS=24   # Room expiry (1-120 hours, default 24)
```

## Running Locally

```bash
# Start Postgres
docker run -d --name livepaste-db \
  -e POSTGRES_USER=livepaste \
  -e POSTGRES_PASSWORD=livepaste \
  -e POSTGRES_DB=livepaste \
  -p 5432:5432 \
  postgres:16-alpine

# Apply schema
psql postgres://livepaste:livepaste@localhost:5432/livepaste < init.sql

# Run server
npm install
node server.js
# Open http://localhost:8080
```

## Security Considerations

1. **Encryption key never leaves client** - URL fragment not sent to server
2. **All content encrypted before transmission** - Server sees only encrypted blobs
3. **Password hashed twice** - SHA-256 client-side, then bcrypt server-side
4. **Room IDs random** - 8-char alphanumeric (62^8 = 218 trillion combinations)
5. **Auto-expiry** - Rooms deleted after RETENTION_HOURS of inactivity
6. **Kill switch** - Room owner can permanently delete room

## Key Technical Decisions

1. **Why short polling over WebSockets/long polling?**
   - Maximum proxy compatibility (Zscaler, corporate firewalls)
   - No connection state on server
   - Simple 2-second HTTP requests look like normal web traffic

2. **Why chunked uploads?**
   - Large payloads (4MB+) may trigger DLP alerts
   - 150KB chunks are under typical thresholds
   - Random delays mimic human interaction patterns

3. **Why encrypt paths too?**
   - Server learns nothing about project structure
   - True zero-knowledge architecture

4. **Why metadata wrapper fields?**
   - Low-entropy fields balance high-entropy encrypted content
   - Makes payloads look like standard API calls
   - Reduces likelihood of entropy-based detection

5. **Why CodeMirror over textarea?**
   - Syntax highlighting
   - Line numbers
   - Better editing experience
   - Auto-bracket matching

## Testing Chunked Uploads

```bash
# Test sync begin
curl -X POST http://localhost:8080/api/room/test123/sync/begin \
  -H "Content-Type: application/json" \
  -d '{"client_id":"test","total_chunks":2,"total_files":10}'

# Response: {"session_id":"abc123","status":"ready","timestamp":"..."}

# Test chunk upload
curl -X POST http://localhost:8080/api/room/test123/sync/chunk \
  -H "Content-Type: application/json" \
  -d '{
    "session_id":"abc123",
    "chunk_index":0,
    "files":[{"path_hash":"abc","path_encrypted":"dGVzdA==","content_encrypted":"aGVsbG8=","is_syncable":true}],
    "client_timestamp":"2024-01-15T10:00:00Z",
    "request_id":"req_123"
  }'

# Test sync complete
curl -X POST http://localhost:8080/api/room/test123/sync/complete \
  -H "Content-Type: application/json" \
  -d '{"session_id":"abc123","finalize":true}'
```
