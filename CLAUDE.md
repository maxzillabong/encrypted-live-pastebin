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

### API Disguise Layer

All API routes masquerade as a document management SaaS to avoid pattern detection:

| Actual Function | Disguised Route | Cover Story |
|----------------|-----------------|-------------|
| Get room state | `GET /api/workspace/:id` | Fetch workspace |
| Check version | `GET /api/workspace/:id/status` | Sync status |
| Save file | `POST /api/documents/save` | Save document |
| Submit edit | `POST /api/documents/:id/edits` | Collaborative edit |
| Get edits | `GET /api/documents/:id/edits` | Fetch edit history |
| Begin sync | `POST /api/workspace/:id/session` | Start editing session |
| Upload chunk | `POST /api/documents/batch` | Batch document save |
| Complete sync | `POST /api/workspace/:id/finalize` | Finalize session |

**Disguised request payload:**
```json
{
  "workspace_id": "abc123",
  "documents": [
    {
      "id": "doc_8f3a2b1c",
      "title": "Q4 Planning Notes",
      "content": "encrypted_base64...",
      "metadata": {
        "refs": ["a1b2c3d4"],
        "tracking": {"utm_source": "editor", "utm_medium": "direct"}
      }
    }
  ]
}
```

Encrypted content hidden in fields that look like analytics/tracking metadata.

### BIP39-Style Key Encoding

The encryption key can be displayed as human-readable words instead of base64:

```
# Base64 format (default)
https://app.example.com/room/abc123#K8x7mP2nQ9vR4sT6wY8zA1bC3dE5fG7hJ

# BIP39-style words (optional)
https://app.example.com/room/abc123#ability-above-absent-absorb-abstract-absurd-abuse-access
```

Words look like a document section anchor. 8 words = ~88 bits entropy.

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

**Simple 2-second polling with delta sync** (not long polling):

```javascript
// Client polls every 2 seconds
setInterval(async () => {
  const { version } = await fetch('/api/room/:id/version');
  if (version > localVersion) {
    // Fetch only files updated since our last known version
    const state = await fetch(`/api/room/:id?since=${localVersion}`);
    mergeState(state); // Merge, don't replace
  }
}, 2000);
```

**Polling pauses during typing** to prevent overwrites:
```javascript
const POLLING_PAUSE_MS = 2000;
if (Date.now() - lastActivityTime < POLLING_PAUSE_MS) return;
```

## Chunked Download System

Initial room state is fetched in chunks for large file counts (proxy-friendly):

```javascript
const CHUNK_LIMIT = 50; // Files per chunk
let offset = 0;
let allFiles = [];

while (true) {
  const res = await fetch(`/api/room/:id?since=0&limit=${CHUNK_LIMIT}&offset=${offset}`);
  const { files, has_more } = await res.json();
  allFiles.push(...files);
  if (!has_more) break;
  offset += CHUNK_LIMIT;
  await delay(50); // Brief pause between chunks
}
```

This prevents large responses that might trigger DLP alerts on initial load.

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

## Real-Time Delta Sync (Operations)

For ongoing edits, we use tiny encrypted deltas instead of full file content. This looks exactly like Google Docs traffic.

### Why Operations?

| Full Content | Operations |
|-------------|------------|
| Edit 5 chars → Send 50KB file | Edit 5 chars → Send ~200 bytes |
| High entropy in large blob | Small encrypted payload |
| Looks like data exfil | Looks like real-time editing |

### Operation Format

```javascript
// Before encryption
{
  "pos": 1234,    // Character offset
  "del": 5,       // Characters deleted
  "ins": "hello"  // Text inserted
}

// After encryption: ~100-300 bytes base64
```

### Operation Flow

```
User types → Capture change → Encrypt op → POST /ops (tiny payload)
                                              ↓
                            ← Poll /ops?since=N ← Other clients
```

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/room/:id/ops` | Submit operation (~200 bytes) |
| GET | `/api/room/:id/ops?since=N` | Get ops since sequence N |
| POST | `/api/room/:id/files/:hash/snapshot` | Compact ops into content |

### Automatic Snapshots

After 50 operations on a file, the client sends a snapshot to compact:
- Updates file content in database
- Deletes old operations
- New clients start from snapshot + recent ops

## Database Schema

```sql
-- Rooms with optional password protection
CREATE TABLE rooms (
    id VARCHAR(32) PRIMARY KEY,
    version BIGINT NOT NULL DEFAULT 0,
    op_seq BIGINT NOT NULL DEFAULT 0,        -- operation sequence counter
    password_hash TEXT,                      -- bcrypt hash (NULL = no password)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Files with encrypted content and paths
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    path_hash VARCHAR(64) NOT NULL,          -- SHA-256 hash for upsert
    path_encrypted TEXT NOT NULL,            -- encrypted path
    content_encrypted TEXT,                  -- encrypted content (NULL for binary)
    is_syncable BOOLEAN NOT NULL DEFAULT true,
    size_bytes BIGINT,                       -- for non-syncable files
    version BIGINT NOT NULL DEFAULT 1,
    snapshot_seq BIGINT NOT NULL DEFAULT 0,  -- op_seq when last snapshotted
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(room_id, path_hash)
);

-- Operations (tiny deltas for real-time editing)
CREATE TABLE operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    file_path_hash VARCHAR(64) NOT NULL,     -- which file
    seq BIGINT NOT NULL,                     -- sequence number for ordering
    op_encrypted TEXT NOT NULL,              -- encrypted: {pos, del, ins}
    client_id VARCHAR(64),                   -- for filtering own ops
    base_version BIGINT NOT NULL DEFAULT 0,  -- for OT conflict detection
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deleted files (for delta sync propagation)
CREATE TABLE deleted_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    path_hash VARCHAR(64) NOT NULL,
    deleted_at_version BIGINT NOT NULL,      -- room version when deleted
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

**Room state query parameters** (for delta sync and chunked loading):
- `?since=N` - Only return files with `version > N` (for delta updates)
- `?limit=N` - Maximum files to return (default: 1000)
- `?offset=N` - Skip first N files (for pagination)
- Response includes `has_more: true` if more files available

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

### Operations (Real-Time Deltas)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/room/:id/ops` | Submit tiny operation |
| GET | `/api/room/:id/ops?since=N` | Get ops since sequence N |
| POST | `/api/room/:id/files/:hash/snapshot` | Compact ops to snapshot |

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

## Browser Isolation Detection

LivePaste detects when it's running inside a browser isolation environment (Menlo, Zscaler Browser Isolation, etc.) and displays a warning badge.

### Detection Methods

1. **Clipboard API blocked** - Isolation often blocks clipboard access
2. **Known user agents** - Menlo, Zscaler, Symantec-WS patterns
3. **Injected scripts** - Isolation proxies inject monitoring scripts
4. **Global variables** - `__isolation__`, `__menlo__`, `__zscaler__`
5. **High input latency** - Pixel streaming typically adds 50-200ms

### QR Code Sharing

When copy/paste is blocked (common in isolation), users can share via QR code:
- Click "QR" button in header
- Scan with mobile device
- Full URL including encryption key fragment

## Build System

The frontend is minified for production to remove comments and shorten variable names.

### Build Commands

```bash
npm run build      # Build minified public/index.html from src/
npm run start      # Build + start server (production)
npm run dev        # Start server with public/ (no rebuild)
npm run dev:src    # Start server with src/ + hot reload (development)
```

### Minification Results

| Component | Source | Built | Reduction |
|-----------|--------|-------|-----------|
| JavaScript | 51 KB | 29 KB | 43% |
| CSS | 8 KB | 6 KB | 30% |
| Total HTML | 70 KB | 45 KB | 36% |

### What Gets Minified

- **JavaScript**: All comments stripped, variable names shortened (terser)
- **CSS**: Comments removed, whitespace collapsed
- **HTML**: Comments removed, whitespace between tags collapsed

## Project Structure

```
livepaste/
├── server.js              # Express server (all backend logic)
├── build.js               # Build script (minification)
├── src/
│   └── index.html         # Source frontend (readable, with comments)
├── public/
│   └── index.html         # Built frontend (minified, no comments)
├── init.sql               # Database schema
├── docker-compose.yml     # Postgres + App (internal network only)
├── Dockerfile             # Multi-stage Node app container
├── Caddyfile              # Caddy reverse proxy config (reference)
├── .github/
│   └── workflows/
│       └── deploy.yml     # CI/CD workflow for Hetzner deployment
├── package.json
├── README.md              # User-facing documentation
└── CLAUDE.md              # This file (technical documentation)
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

<!-- QR code generation (for browser isolation fallback) -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
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

## Deployment

### Docker Build

The Dockerfile uses a multi-stage build:

```dockerfile
# Stage 1: Build (minify JS/CSS)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY build.js ./
COPY src ./src
RUN npm run build

# Stage 2: Runtime (production only)
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY --from=builder /app/public ./public
EXPOSE 8080
CMD ["node", "server.js"]
```

### GitHub Actions CI/CD

The workflow in `.github/workflows/deploy.yml` automates deployment to Hetzner VPS:

1. **On push to main:**
   - Builds Docker image with multi-stage Dockerfile
   - Pushes to GitHub Container Registry (ghcr.io)
   - SSHs to Hetzner VPS
   - Pulls and restarts the container

2. **Required GitHub Secrets:**
   - `HETZNER_HOST` - VPS IP or hostname
   - `HETZNER_USER` - SSH username
   - `HETZNER_SSH_KEY` - SSH private key (ed25519 or RSA)
   - `DATABASE_URL` - Postgres connection string

3. **On Hetzner VPS:**
   ```bash
   # Docker must be installed and configured to pull from ghcr.io
   docker login ghcr.io -u USERNAME -p GITHUB_PAT
   ```

### Manual Deployment

```bash
# Build image
docker build -t livepaste .

# Run with environment variables
docker run -d \
  --name livepaste \
  -p 8080:8080 \
  -e DATABASE_URL=postgres://user:pass@host:5432/livepaste \
  -e RETENTION_HOURS=24 \
  livepaste
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

## Known Limitations & Remaining Work

### Browser Isolation Detection - Limited Coverage

The isolation detection (Menlo, Zscaler BI, etc.) relies on heuristics that may not catch all isolation environments. False negatives are possible with newer or custom isolation solutions.

### Full CRDT Not Implemented

While basic OT conflict detection is implemented (server returns 409 with conflicting ops), true CRDT or full OT transformation is not implemented. The client is responsible for resolving conflicts when they occur.

## Recently Implemented Features

### Delta Sync - File Deletions (Implemented)

File deletions are now propagated via delta sync:
- Server tracks deletions in `deleted_files` table with version numbers
- Delta sync response includes `deleted_path_hashes[]` array
- Client removes deleted files from local state automatically

### OT Conflict Detection (Implemented)

The ops endpoint now includes conflict detection:
- Server checks `base_version` against file's current version
- Returns HTTP 409 with `conflicting_ops[]` when conflicts detected
- Client receives all conflicting operations to enable resolution

```javascript
// Conflict response (HTTP 409)
{
  "error": "conflict",
  "current_version": 5,
  "base_version": 3,
  "conflicting_ops": [
    { "seq": 4, "op_encrypted": "...", "client_id": "other-client" }
  ]
}
```

### Response Format Unified (Implemented)

The `/api/workspace/:id/finalize` endpoint now returns both formats:
- `files[]` - Standard format for consistency
- `documents[]` - Disguised format for backward compatibility
- `deleted_path_hashes[]` - For delta sync support

### Traffic Obfuscation Suite (Implemented)

To evade traffic analysis and anomaly detection, LivePaste now mimics standard SaaS traffic patterns:

1. **Request Padding:** All POST payloads and JSON responses are padded to powers of 2 (256, 512, 1024...) using a `_pad` field filled with random characters. This masks the exact size of the encrypted content.
2. **Jitter:** Client introduces random 30-150ms delays before API calls to disrupt timing analysis.
3. **Decoy Headers:** Realistic headers (`X-Feature-Flags`, `X-Client-Version`) are injected to resemble complex SaaS applications.
4. **Fake Sync:** Background heartbeat requests (`/api/workspace/sync`) occur every 25-45s to mimic "keep-alive" traffic of active collaboration tools.
5. **Field Stripping:** The server automatically strips decoy fields (`_analytics`, `_meta`, `_pad`) before processing requests.

### Streaming Upload (Implemented)

Folder uploads now use streaming to minimize memory usage for large codebases:

**Before (accumulated):**
```
Scan all files → fileList[] (plaintext) → encrypted[] → chunks[] → upload
Peak memory: ~2x total file content size
```

**After (streaming):**
```
Scan batch → encrypt batch → upload → release memory → next batch
Peak memory: ~(batch_size × avg_file_size) ≈ 200KB-2MB
```

Key improvements:
1. **Async generators** - `streamingScan()` yields file batches as they're discovered
2. **Immediate upload** - Each batch is encrypted and uploaded before loading next
3. **Early GC** - Plaintext content nulled immediately after encryption
4. **Configurable batch size** - `SCAN_BATCH_SIZE = 20` files per batch

This reduces memory usage from O(n) to O(1) relative to codebase size, enabling upload of large Java/enterprise monorepos without browser memory issues.

