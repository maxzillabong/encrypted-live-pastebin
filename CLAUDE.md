# CLAUDE.md - LivePaste Project Specification

## Project Overview

LivePaste is an end-to-end encrypted, real-time collaborative code sharing tool with folder sync capabilities. It uses long polling (no WebSockets/SSE) for real-time updates and stores data in Postgres using LISTEN/NOTIFY for efficient pub/sub.

**Core concept:** Open browser, upload a folder (or grant folder access), share a URL (with encryption key in fragment), other browsers/users/AI agents see and edit the same files in real-time.

**Key constraint: 100% web-based. No CLI, no installation, everything runs in the browser.**

## Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│    Browser A    │         │   Node Server   │         │    Postgres     │
│                 │         │   (stateless)   │         │                 │
│ - File tree UI  │◄──HTTP──►│ - REST API     │◄──SQL───►│ - rooms table   │
│ - E2E encrypt   │         │ - Long poll     │         │ - files table   │
│ - Folder access │         │ - LISTEN/NOTIFY │         │ - changesets    │
│   (File System  │         │                 │         │ - NOTIFY trigger│
│    Access API)  │         │                 │         │                 │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │                                                       ▲
        │                                                       │
        │              ┌─────────────────┐                      │
        └──────────────│    Browser B    │──────────────────────┘
                       │  (or AI Agent)  │
                       └─────────────────┘
```

## Folder Access Methods (Browser-Only)

### Method 1: File System Access API (Chrome/Edge - Best Experience)
```javascript
// User grants persistent folder access
const dirHandle = await window.showDirectoryPicker();

// Read files
for await (const entry of dirHandle.values()) {
  if (entry.kind === 'file') {
    const file = await entry.getFile();
    const content = await file.text();
  }
}

// Write changes back directly to local disk!
const writable = await fileHandle.createWritable();
await writable.write(newContent);
await writable.close();
```
**This allows live bi-directional sync without any downloads.**

### Method 2: Drag & Drop / Input (All Browsers - Fallback)
```html
<input type="file" webkitdirectory multiple />
<!-- or drag & drop with webkitGetAsEntry() -->
```
- Upload folder contents on load
- Download as .zip when done (no live write-back)

### Method 3: ZIP Upload/Download
```javascript
// Upload: User drops a .zip file
import JSZip from 'jszip'; // via CDN: https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js

async function handleZipUpload(file) {
  const zip = await JSZip.loadAsync(file);
  const files = [];

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const content = await entry.async('string');
    if (isSyncable(path, content)) {
      files.push({ path, content });
    }
  }
  return files;
}

// Download: Bundle all files as .zip
async function downloadAsZip(files, roomName) {
  const zip = new JSZip();

  for (const file of files) {
    const decryptedPath = await decrypt(file.path_encrypted, key);
    const decryptedContent = await decrypt(file.content_encrypted, key);
    zip.file(decryptedPath, decryptedContent);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${roomName}.zip`;
  a.click();
}
```

### Method 4: Paste Single File
- Simple textarea paste for quick single-file sharing
- Original LivePaste behavior

## E2E Encryption Scheme

The encryption key lives in the URL fragment and NEVER reaches the server:

```
https://livepaste.app/room/abc123#K8x7mP2nQ9vR4sT6wY8zA1bC3dE5fG7hJ
                                  └──────── 256-bit AES key ────────┘
```

- Generate 256-bit random key if not in URL
- Use AES-256-GCM (WebCrypto API in browser)
- Encrypt file content AND file paths (server sees nothing)
- IV is random per encryption, prepended to ciphertext

```javascript
// Encryption
const iv = crypto.getRandomValues(new Uint8Array(12));
const ciphertext = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv }, key, plaintext
);
// Store: base64(iv + ciphertext)

// Decryption
const iv = data.slice(0, 12);
const ciphertext = data.slice(12);
const plaintext = await crypto.subtle.decrypt(
  { name: 'AES-GCM', iv }, key, ciphertext
);
```

## File Filtering (Syncable vs Local-Only)

**Critical: Binary files never leave the source browser.** Only text/code files sync.

### Syncable Extensions (sync content)
```javascript
const SYNCABLE_EXTENSIONS = new Set([
  // Code
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.pyi', '.pyw',
  '.java', '.kt', '.kts', '.scala', '.groovy',
  '.go', '.rs', '.rb', '.php', '.swift', '.m', '.mm',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  '.cs', '.fs', '.vb',
  '.lua', '.pl', '.pm', '.r', '.R', '.jl',
  '.zig', '.nim', '.v', '.d', '.dart', '.elm', '.ex', '.exs',
  '.clj', '.cljs', '.edn', '.lisp', '.scm', '.rkt',
  '.hs', '.ml', '.mli', '.erl', '.hrl',

  // Config
  '.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf',
  '.env', '.env.example', '.env.local', '.env.development', '.env.production',
  '.editorconfig', '.prettierrc', '.eslintrc', '.babelrc',

  // Web
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl',
  '.vue', '.svelte', '.astro',

  // Docs & Data
  '.md', '.mdx', '.txt', '.rst', '.adoc', '.tex',
  '.csv', '.tsv', '.sql',

  // Scripts
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',

  // Build & Package
  '.gradle', '.cmake', '.make', '.dockerfile',
  'Makefile', 'Dockerfile', 'Containerfile',
  'package.json', 'tsconfig.json', 'composer.json', 'Cargo.toml',
  'requirements.txt', 'Gemfile', 'go.mod', 'pom.xml', 'build.gradle',

  // Git
  '.gitignore', '.gitattributes',
]);
```

### Never Sync (binary/large - local only)
```javascript
const NEVER_SYNC_EXTENSIONS = new Set([
  // Compiled/Binary
  '.jar', '.war', '.ear', '.class',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib',
  '.pyc', '.pyo', '.pyd', '.wasm',
  '.node', '.beam',

  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.rar', '.7z', '.tgz',

  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp', '.tiff',
  '.psd', '.ai', '.sketch', '.fig',

  // Media
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.avi', '.mov', '.mkv', '.webm',

  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',

  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',

  // Database
  '.db', '.sqlite', '.sqlite3', '.mdb',

  // Keys/Certs (security)
  '.pem', '.key', '.crt', '.cer', '.p12', '.pfx', '.jks',
]);

const NEVER_SYNC_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', 'target', 'bin', 'obj',
  '__pycache__', '.pytest_cache', '.mypy_cache',
  '.next', '.nuxt', '.output', '.vercel', '.netlify',
  'vendor', 'venv', '.venv', 'env', '.env',
  'coverage', '.nyc_output',
  '.idea', '.vscode', '.vs',
  'Pods', 'DerivedData',
]);
```

### Content-Based Detection (fallback)
```javascript
function isSyncable(filename, content) {
  const ext = getExtension(filename);

  // Check extension first
  if (NEVER_SYNC_EXTENSIONS.has(ext)) return false;
  if (SYNCABLE_EXTENSIONS.has(ext)) return true;

  // Unknown extension - check content
  if (content instanceof ArrayBuffer) {
    const bytes = new Uint8Array(content);

    // Check for null bytes (binary indicator)
    for (let i = 0; i < Math.min(bytes.length, 8000); i++) {
      if (bytes[i] === 0) return false;
    }

    // Try to decode as UTF-8
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // If >30% non-printable, probably binary
      const nonPrintable = text.match(/[^\x20-\x7E\t\n\r]/g)?.length || 0;
      return (nonPrintable / text.length) < 0.3;
    } catch {
      return false;
    }
  }

  return true;
}
```

### UI Representation
```
📁 my-project
 ├── 📁 src
 │   ├── index.ts            ✓ synced
 │   └── utils.ts            ✓ synced
 ├── 📁 lib
 │   └── vendor.jar          ◌ local only (1.2 MB)
 ├── 📁 assets
 │   ├── logo.png            ◌ local only (45 KB)
 │   └── styles.css          ✓ synced
 ├── 📁 node_modules         ◌ ignored
 ├── package.json            ✓ synced
 └── README.md               ✓ synced
```

Non-syncable files show in tree (grayed out) with size, but content stays local.
Clicking a non-syncable file shows: "This file is only available on the source machine."

## Long Polling Flow

```
Client A                    Server                     Client B
   │                           │                           │
   │──GET /poll?v=1───────────►│                           │
   │         (hangs waiting)   │                           │
   │                           │◄──POST /files (update)────│
   │                           │                           │
   │                           │──NOTIFY room_xxx──────────│
   │                           │        (Postgres)         │
   │◄──response {files, v=2}───│                           │
   │                           │                           │
   │──GET /poll?v=2───────────►│  (immediately re-poll)    │
   │         (hangs waiting)   │                           │
```

**Key points:**
- Request hangs up to 30 seconds waiting for updates
- Postgres LISTEN/NOTIFY wakes up waiting requests
- Client immediately re-polls after receiving response
- On timeout (204), client re-polls anyway

## Database Schema

```sql
-- Rooms (tracks existence and version)
CREATE TABLE rooms (
    id VARCHAR(32) PRIMARY KEY,
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Files (encrypted content and paths)
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    path_encrypted TEXT NOT NULL,           -- encrypted file path
    content_encrypted TEXT,                 -- encrypted content (NULL for non-syncable)
    is_syncable BOOLEAN NOT NULL DEFAULT true,
    size_bytes BIGINT,                      -- for non-syncable files, show size
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(room_id, path_encrypted)
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

CREATE INDEX idx_files_room_id ON files(room_id);
CREATE INDEX idx_changesets_room_id ON changesets(room_id);
CREATE INDEX idx_changesets_status ON changesets(status);
CREATE INDEX idx_changes_changeset_id ON changes(changeset_id);
CREATE INDEX idx_rooms_updated_at ON rooms(updated_at);

-- Notify function for room updates
CREATE OR REPLACE FUNCTION notify_room_update()
RETURNS TRIGGER AS $
BEGIN
    UPDATE rooms SET version = version + 1, updated_at = NOW() WHERE id = NEW.room_id;
    PERFORM pg_notify('room_' || NEW.room_id, (SELECT version::text FROM rooms WHERE id = NEW.room_id));
    RETURN NEW;
END;
$ LANGUAGE plpgsql;

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

-- Notify on change status updates
CREATE TRIGGER change_updated
    AFTER UPDATE ON changes
    FOR EACH ROW
    EXECUTE FUNCTION notify_room_update();

-- Cleanup rooms older than 24h
CREATE OR REPLACE FUNCTION cleanup_old_rooms()
RETURNS INTEGER AS $
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM rooms WHERE updated_at < NOW() - INTERVAL '24 hours';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$ LANGUAGE plpgsql;
```

## API Endpoints

### Room Endpoints

#### `GET /`
Redirect to `/room/{random-8-char-id}`

#### `GET /room/:id`
Serve the web UI (single HTML page with embedded JS/CSS)

#### `GET /api/room/:id`
Get current room state (all files + pending changesets)

**Response:**
```json
{
  "version": 5,
  "files": [
    {
      "id": "uuid",
      "path_encrypted": "base64...",
      "content_encrypted": "base64...",
      "is_syncable": true,
      "version": 3
    },
    {
      "id": "uuid",
      "path_encrypted": "base64...",
      "content_encrypted": null,
      "is_syncable": false,
      "size_bytes": 1458923
    }
  ],
  "changesets": [
    {
      "id": "uuid",
      "author_encrypted": "base64...",
      "message_encrypted": "base64...",
      "status": "pending",
      "changes": [
        {
          "id": "uuid",
          "file_path_encrypted": "base64...",
          "diff_encrypted": "base64...",
          "status": "pending"
        }
      ]
    }
  ]
}
```

#### `GET /api/room/:id/poll?v={version}`
Long poll for updates. Hangs until room version > client version or 30s timeout.

**Response:** Same as GET /api/room/:id, or 204 No Content on timeout

### File Endpoints

#### `POST /api/room/:id/files`
Create or update a file

**Request:**
```json
{
  "path_encrypted": "base64...",
  "content_encrypted": "base64...",
  "is_syncable": true
}
```

**Response:**
```json
{
  "id": "uuid",
  "path_encrypted": "base64...",
  "content_encrypted": "base64...",
  "is_syncable": true,
  "version": 4,
  "room_version": 6
}
```

#### `DELETE /api/room/:id/files/:fileId`
Delete a file

#### `POST /api/room/:id/sync`
Bulk sync - upload entire folder state (for initial upload)

**Request:**
```json
{
  "files": [
    {
      "path_encrypted": "base64...",
      "content_encrypted": "base64...",
      "is_syncable": true
    },
    {
      "path_encrypted": "base64...",
      "content_encrypted": null,
      "is_syncable": false,
      "size_bytes": 245678
    }
  ]
}
```

### Changeset Endpoints (for AI/Collaborator Proposals)

#### `POST /api/room/:id/changesets`
Propose a new changeset (multiple file changes)

**Request:**
```json
{
  "author_encrypted": "base64...",
  "message_encrypted": "base64...",
  "changes": [
    {
      "file_path_encrypted": "base64...",
      "old_content_encrypted": "base64...",
      "new_content_encrypted": "base64...",
      "diff_encrypted": "base64..."
    }
  ]
}
```

**Response:**
```json
{
  "id": "uuid",
  "status": "pending",
  "changes": [...]
}
```

#### `POST /api/room/:id/changesets/:changesetId/accept`
Accept entire changeset (applies all changes to files)

#### `POST /api/room/:id/changesets/:changesetId/reject`
Reject entire changeset

#### `POST /api/room/:id/changes/:changeId/accept`
Accept single change within a changeset

#### `POST /api/room/:id/changes/:changeId/reject`
Reject single change within a changeset

## Web UI Specification

Single HTML page with embedded CSS/JS. No build step. **This is the ONLY client - no CLI.**

### Layout - Normal Mode (Editing Files)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🔐 LivePaste          [room-url-display]  [Share]       🔒E2E  ●Online  👤2 │
├─────────────────────────────────────────────────────────────────────────────┤
│ [Language ▼] [Copy] [Download All]  [🤖 Invite Agent]               v123   │
├────────────────────────┬────────────────────────────────────────────────────┤
│ 📁 my-project          │ src/index.ts                                       │
│  ├── 📁 src            │─────────────────────────────────────────────────────│
│  │   ├── index.ts    ◄─│ import { helper } from './utils';                  │
│  │   └── utils.ts      │                                                    │
│  ├── 📁 lib            │ async function main() {                            │
│  │   └── vendor.jar ○  │   const data = await fetch(url);                   │
│  ├── 📁 assets         │   // @claude: add error handling here              │
│  │   └── logo.png ○    │   return data.json();                              │
│  ├── package.json      │ }                                                  │
│  └── README.md         │                                                    │
│────────────────────────│                                                    │
│ [+ Add File]           │                                                    │
│ [📁 Upload Folder]     │                                                    │
│ [💾 Save to Disk]      │ (if File System Access API available)              │
└────────────────────────┴────────────────────────────────────────────────────┘

○ = local only (grayed out, not synced)
◄ = currently selected file
```

### Layout - Review Mode (Pending Changesets)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🔐 LivePaste          [room-url-display]  [Share]       🔒E2E  ●Online  👤2 │
├─────────────────────────────────────────────────────────────────────────────┤
│ ⚠️  Claude proposed 3 changes: "Add error handling to fetch calls"          │
│                                        [✓ Accept All] [✗ Reject All]        │
├────────────────────────┬────────────────────────────────────────────────────┤
│ 📁 my-project          │ ┌─ src/index.ts ─────────────────────────────────┐ │
│  ├── 📁 src            │ │  async function main() {                       │ │
│  │   ├── index.ts  [!] │ │ -  const data = await fetch(url);              │ │
│  │   └── utils.ts  [!] │ │ +  const response = await fetch(url);          │ │
│  ├── package.json      │ │ +  if (!response.ok) {                         │ │
│  └── README.md         │ │ +    throw new Error(`HTTP ${response.status}`);│ │
│                        │ │ +  }                                           │ │
│                        │ │ +  const data = await response.json();         │ │
│                        │ │                       [✓ Accept] [✗ Reject]    │ │
│                        │ └────────────────────────────────────────────────┘ │
│                        │ ┌─ src/utils.ts ─────────────────────────────────┐ │
│                        │ │ + export async function fetchWithRetry(        │ │
│                        │ │ +   url: string,                               │ │
│                        │ │ +   attempts = 3                               │ │
│                        │ │ + ): Promise<Response> {                       │ │
│                        │ │ +   // ... retry logic                         │ │
│                        │ │ + }                                            │ │
│                        │ │                       [✓ Accept] [✗ Reject]    │ │
│                        │ └────────────────────────────────────────────────┘ │
│                        │ ┌─ package.json ─────────────────────────────────┐ │
│                        │ │   "dependencies": {                            │ │
│                        │ │ +   "retry": "^0.13.1"                         │ │
│                        │ │   }                                            │ │
│                        │ │                       [✓ Accept] [✗ Reject]    │ │
│                        │ └────────────────────────────────────────────────┘ │
└────────────────────────┴────────────────────────────────────────────────────┘

[!] = file has pending changes
```

### Features

1. **File Tree Panel (left)**
   - Hierarchical folder view built from file paths
   - Click to select/view file
   - Right-click context menu: rename, delete
   - Visual indicators:
     - ○ grayed = local only (binary/non-syncable)
     - [!] badge = has pending changes
     - ◄ arrow = currently selected
   - "Add File" button - prompts for path, creates empty file
   - "Upload Folder" button:
     - Chrome/Edge: `window.showDirectoryPicker()` for live sync
     - Other browsers: `<input webkitdirectory>` for one-time upload
   - "Save to Disk" button (only if File System Access API granted):
     - Writes all changes back to local folder

2. **Editor Panel (right) - Normal Mode**
   - File path header with breadcrumb
   - Syntax highlighted view (Prism.js)
   - Editable mode (toggle or always-on)
   - Language auto-detect from extension, manual override dropdown
   - Copy button
   - Save indicator (auto-saves on change with debounce)

3. **Editor Panel (right) - Review Mode**
   - Shows when there are pending changesets
   - Diff view for each changed file:
     - Red background for removed lines (-)
     - Green background for added lines (+)
     - Context lines in normal color
   - Per-file Accept/Reject buttons
   - Accept All / Reject All in header
   - After all decisions, returns to normal mode

4. **Header**
   - Logo with encryption indicator
   - Room URL display (truncated, click to copy full URL with key)
   - Share button - copies full URL
   - E2E badge (green lock icon)
   - Connection status: ●Online / ●Reconnecting
   - User count (number of connected browsers)
   - "Invite Agent" button - shows instructions for AI connection

5. **Toolbar**
   - Language selector dropdown
   - Copy Code button
   - Download All button (downloads all files as .zip, decrypted)
   - Version badge (room version number)

### Styling

- Dark theme (similar to VS Code dark)
- Background: #1a1a2e
- Panel background: #16213e
- Border color: #0f3460
- Accent: #e94560
- Text: #eee
- Muted: #94a3b8
- Success: #22c55e
- Warning: #f59e0b

### External Dependencies (CDN)

```html
<!-- Prism.js for syntax highlighting -->
<link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-{lang}.min.js"></script>

<!-- JSZip for folder download -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
```

Languages to include: javascript, typescript, python, java, kotlin, csharp, cpp, go, rust, ruby, php, swift, sql, html, css, json, yaml, markdown, bash

## AI Agent Integration (Web-Based)

The AI agent connects via browser, same as any other user. No CLI needed.

### How It Works

1. **User clicks "Invite Agent"** - shows a URL specifically for the agent
2. **Agent opens URL in headless browser or via API**
3. **Agent watches for trigger patterns in code comments**
4. **Agent proposes changes via changesets**
5. **User reviews and accepts/rejects in the UI**

### Agent Trigger Patterns

The agent scans file content for these patterns:

```javascript
const AGENT_TRIGGERS = [
  /\/\/\s*@claude[:\s]+(.+)$/gm,           // // @claude: do something
  /\/\/\s*@ai[:\s]+(.+)$/gm,               // // @ai: do something
  /#\s*@claude[:\s]+(.+)$/gm,              // # @claude: do something (Python)
  /\/\*\s*@claude[:\s]+(.+?)\s*\*\//gs,    // /* @claude: do something */
  /\/\/\s*TODO:\s*claude[,:\s]+(.+)$/gmi,  // // TODO: claude, do something
  /<!--\s*@claude[:\s]+(.+?)\s*-->/gs,     // <!-- @claude: do something -->
];
```

### Agent Connection Options

#### Option 1: Browser Automation (Puppeteer/Playwright)
```javascript
// Agent runs a headless browser
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto('https://livepaste.app/room/abc123#encryptionkey');

// Poll for changes, analyze, propose changesets via UI automation
// or directly call API endpoints
```

#### Option 2: Direct API Integration
```javascript
// Agent connects directly to API (must handle encryption client-side)
const ROOM_URL = 'https://livepaste.app/room/abc123#K8x7mP2n...';
const [roomId, encryptionKey] = parseUrl(ROOM_URL);

// Poll for updates
const response = await fetch(`/api/room/${roomId}/poll?v=${version}`);
const data = await response.json();

// Decrypt files, analyze, create changeset
const decryptedFiles = await decryptFiles(data.files, encryptionKey);
const changes = await analyzeAndFix(decryptedFiles);

// Post changeset (encrypted)
await fetch(`/api/room/${roomId}/changesets`, {
  method: 'POST',
  body: JSON.stringify(await encryptChangeset(changes, encryptionKey))
});
```

#### Option 3: Claude Computer Use (Future)
```
Claude can directly use the web UI like a human:
1. Navigate to room URL
2. Read file contents visually
3. Click files, edit code
4. Submit changesets through the UI
```

### Agent Changeset Flow

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   User writes    │     │   Agent sees     │     │   User reviews   │
│   // @claude:    │────►│   trigger, runs  │────►│   proposed       │
│   add tests      │     │   analysis       │     │   changes        │
└──────────────────┘     └──────────────────┘     └──────────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │  Agent creates   │
                         │  changeset with  │
                         │  multiple files  │
                         └──────────────────┘
```

### Agent Safety Rules

1. **Never auto-apply changes** - always create a changeset for review
2. **Mark completion** - after user accepts, agent adds `// @claude: ✓ done`
3. **Rate limiting** - max 1 changeset per trigger, wait for resolution
4. **Scope limiting** - only modify files explicitly mentioned or clearly related
5. **No infinite loops** - ignore trigger patterns in own output

### Example Agent Prompts

When triggered by `// @claude: add error handling`, agent receives:

```
You are a code assistant. The user has requested: "add error handling"

Current file: src/index.ts
```typescript
async function main() {
  const data = await fetch(url);
  // @claude: add error handling
  return data.json();
}
```

Other files in project:
- src/utils.ts (helper functions)
- package.json (dependencies)

Create a changeset that:
1. Adds appropriate error handling
2. Uses project conventions (check existing code style)
3. May modify multiple files if needed
4. Explains changes in changeset message

Output format: JSON changeset with file paths and new content.
```

## Project Structure

```
livepaste/
├── docker-compose.yml       # Postgres + App
├── Dockerfile               # Node app container
├── init.sql                 # Database schema
├── package.json
├── server.js                # Express server (single file, serves everything)
└── README.md
```

The entire frontend is embedded in `server.js` as a template string. No separate HTML files, no build step.

## Implementation Order

### Phase 1: Core Infrastructure
1. **Database setup** - init.sql with complete schema (rooms, files, changesets, changes, triggers)
2. **Server skeleton** - Express with basic routes, Postgres pool connection
3. **Long poll endpoint** - LISTEN/NOTIFY working, test with curl

### Phase 2: Basic Web UI
4. **Single-file paste mode** - Textarea + preview, no file tree yet
5. **E2E encryption** - Key from fragment, encrypt/decrypt working
6. **Real-time sync** - Long poll updates UI, two tabs sync

### Phase 3: Multi-File Support
7. **File tree component** - Build tree from flat file paths
8. **File CRUD** - Create, read, update, delete files via API
9. **Folder upload** - webkitdirectory input + File System Access API
10. **Binary file filtering** - Detect and skip non-syncable files
11. **Download as zip** - JSZip to bundle all files

### Phase 4: Changeset System
12. **Changeset API** - Create, accept, reject changesets
13. **Diff generation** - Create unified diffs for changes
14. **Review UI** - Diff view with accept/reject buttons
15. **Changeset resolution** - Apply accepted changes to files

### Phase 5: Agent Support
16. **Agent documentation** - How to connect, API examples
17. **Trigger detection** - Scan files for @claude patterns
18. **Agent example** - Simple script showing API integration

### Phase 6: Polish
19. **Error handling** - Network errors, encryption failures
20. **Loading states** - Spinners, skeleton screens
21. **Mobile responsive** - Usable on phone (read-only at minimum)
22. **Rate limiting** - Protect API endpoints

## Key Technical Decisions

1. **Why long polling over WebSockets?**
   - Works through any proxy/firewall
   - No connection state on server
   - Simpler horizontal scaling
   - Postgres LISTEN/NOTIFY is the perfect backend

2. **Why encrypt paths too?**
   - Server learns nothing about project structure
   - True zero-knowledge

3. **Why Postgres over Redis?**
   - Single dependency
   - LISTEN/NOTIFY is built-in
   - Persistence for free
   - Can add full-text search later if needed

4. **Why single HTML file embedded in server.js?**
   - No build step
   - Easy to deploy (one container)
   - All logic visible in one place
   - Still use CDN for Prism.js, JSZip

5. **Why 100% web-based (no CLI)?**
   - Zero friction - just share a URL
   - Works on any device with a browser
   - No installation, no PATH issues
   - File System Access API enables live folder sync in Chrome/Edge

6. **Why changesets instead of direct edits for agents?**
   - User stays in control
   - Can review before applying
   - Audit trail of what changed
   - Prevents accidental damage

## Diff Generation

Use a simple unified diff format. Can use the `diff` library from npm or implement manually:

```javascript
// npm package 'diff' - include via CDN or bundle
import { createPatch } from 'diff';

const diff = createPatch(
  filename,
  oldContent,
  newContent,
  'original',
  'modified'
);

// Output:
// --- original
// +++ modified
// @@ -1,5 +1,7 @@
//  line 1
// -old line 2
// +new line 2
// +added line
//  line 3
```

For the UI, parse diff and render with colors:
- Lines starting with `-` → red background
- Lines starting with `+` → green background
- Lines starting with ` ` → normal (context)
- Lines starting with `@@` → gray (chunk header)

## Environment Variables

```bash
DATABASE_URL=postgres://user:pass@host:5432/livepaste
PORT=8080
NODE_ENV=production
```

## Docker Deployment

```bash
# Development
docker-compose up

# Production
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Resource Requirements

- **Postgres:** ~50-100MB RAM
- **Node.js:** ~30-50MB RAM
- **Total:** <200MB (fits on $4/mo VPS)

## Security Considerations

1. Key never leaves client (URL fragment not sent to server)
2. All content encrypted before transmission
3. Room IDs are random 8-char alphanumeric (62^8 = 218 trillion combinations)
4. Rooms auto-expire after 24h of inactivity
5. Rate limiting on API endpoints (TODO)
6. Content-Security-Policy headers (TODO)

## Future Enhancements (Not in MVP)

- [ ] Room passwords (additional encryption layer on top of URL key)
- [ ] File history / undo (store previous versions)
- [ ] Cursor presence (see where others are editing - needs more state)
- [ ] Comments / annotations on lines
- [ ] Custom domains (CNAME to livepaste)
- [ ] Team accounts with persistent rooms
- [ ] Syntax checking / linting in browser
- [ ] Git integration (commit changesets)
- [ ] Multiple AI agents (GPT-4, Gemini, etc.)
- [ ] Voice commands ("Hey Claude, refactor this function")
- [ ] Mobile app (React Native wrapper)
- [ ] VS Code extension (open room in editor)
- [ ] Conflict resolution UI (when two users edit same line)

---

## Quick Start for Claude Code

1. **Read this entire document first** - understand the architecture
2. **Start with `init.sql`** - get the schema right, test triggers work
3. **Build `server.js` incrementally:**
   - First: basic Express + static room page
   - Then: file CRUD endpoints
   - Then: long polling with LISTEN/NOTIFY
   - Then: changeset endpoints
4. **Test everything with curl before building UI**
5. **Build UI in phases:**
   - Single file mode first (like original LivePaste)
   - Then file tree
   - Then folder upload
   - Then changeset review
6. **Encryption is non-negotiable** - every file operation must encrypt/decrypt
7. **Test with two browser tabs** - should sync in real-time

**Test commands:**

```bash
# Start postgres
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

# Test basic endpoints
curl http://localhost:8080/api/room/test123

# Test file creation
curl -X POST http://localhost:8080/api/room/test123/files \
  -H "Content-Type: application/json" \
  -d '{"path_encrypted":"dGVzdC50eHQ=","content_encrypted":"aGVsbG8gd29ybGQ=","is_syncable":true}'

# Test long poll (run in one terminal - should hang)
curl "http://localhost:8080/api/room/test123/poll?v=0"

# In another terminal, update a file - the poll should return
curl -X POST http://localhost:8080/api/room/test123/files \
  -H "Content-Type: application/json" \
  -d '{"path_encrypted":"dGVzdC50eHQ=","content_encrypted":"dXBkYXRlZCE=","is_syncable":true}'

# Test changeset creation
curl -X POST http://localhost:8080/api/room/test123/changesets \
  -H "Content-Type: application/json" \
  -d '{
    "author_encrypted":"Y2xhdWRl",
    "message_encrypted":"Rml4ZWQgYnVn",
    "changes":[{
      "file_path_encrypted":"dGVzdC50eHQ=",
      "old_content_encrypted":"aGVsbG8=",
      "new_content_encrypted":"aGVsbG8gd29ybGQ=",
      "diff_encrypted":"QEAgLTEgKzEgQEAKLWhlbGxvCitoZWxsbyB3b3JsZA=="
    }]
  }'
```

## CDN Dependencies

Include these in the HTML:

```html
<!-- Syntax highlighting -->
<link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
<!-- Add language components as needed -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js"></script>
<!-- ... etc -->

<!-- ZIP file generation -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>

<!-- Diff generation (optional - can implement manually) -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jsdiff/5.1.0/diff.min.js"></script>
```

Languages to support: javascript, typescript, jsx, tsx, python, java, kotlin, csharp, cpp, c, go, rust, ruby, php, swift, sql, html, css, scss, json, yaml, markdown, bash, dockerfile
