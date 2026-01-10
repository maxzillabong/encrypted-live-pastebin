# LivePaste

End-to-end encrypted, real-time collaborative code sharing that works through enterprise proxies.

## Why LivePaste?

**The problem:** You're behind a corporate proxy (Zscaler, Menlo, etc.) and need to share code with external collaborators. Traditional tools either get blocked or expose your content to inspection.

**The solution:** LivePaste encrypts everything client-side before transmission. The server only sees encrypted blobs. Your encryption key stays in the URL fragment and never leaves your browser.

## Features

- **Zero-knowledge encryption** - AES-256-GCM, key in URL fragment (never sent to server)
- **Enterprise proxy compatible** - Works through Zscaler, corporate firewalls, DLP systems
- **Real-time collaboration** - See changes as others type
- **Folder upload** - Drag & drop entire project folders
- **Syntax highlighting** - 100+ languages via CodeMirror
- **Password protection** - Optional room passwords
- **BIP39-style keys** - Human-readable word-based encryption keys for easier sharing
- **Browser isolation aware** - Detects isolation environments, offers QR code fallback
- **Self-destructing rooms** - Auto-expire after configurable time

## How It Works

```
https://livepaste.app/room/abc123#K8x7mP2nQ9vR4sT6wY8zA1bC3dE5fG7hJ
                                  └──────── Your encryption key ────────┘
                                  (never sent to server)
```

1. Open LivePaste - a new room is created
2. Upload files or paste code
3. Share the URL (includes encryption key in fragment)
4. Collaborators see and edit the same files in real-time

### BIP39-Style Key Sharing

For easier verbal sharing or when copy/paste is blocked, the encryption key can be displayed as human-readable words:

```
# Standard base64 format
https://livepaste.app/room/abc123#K8x7mP2nQ9vR4sT6wY8zA1bC3dE5fG7hJ

# BIP39-style words (click "Words" button)
https://livepaste.app/room/abc123#ability-above-absent-absorb-abstract-absurd-abuse-access
```

8 words = ~88 bits of entropy. The words look like a document section anchor to network inspection tools.

## Quick Start

### Docker (Recommended)

```bash
# Clone the repo
git clone https://github.com/maxzillabong/encrypted-live-pastebin.git
cd encrypted-live-pastebin

# Start with Docker Compose
docker compose up -d

# Open http://localhost:8080
```

### Manual Setup

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

# Install and run
npm install
npm start

# Open http://localhost:8080
```

## Enterprise Proxy Compatibility

LivePaste is specifically designed to work through enterprise security proxies:

| Feature | Why It Helps |
|---------|--------------|
| **Short polling** | Simple 2-second HTTP requests (no WebSockets) |
| **Chunked uploads** | ~150KB per request (under DLP thresholds) |
| **Randomized timing** | 200-800ms delays mimic human patterns |
| **Low-entropy metadata** | JSON wrapper makes payloads look normal |
| **API disguise** | Routes masquerade as document management SaaS |

### Browser Isolation

If you're in a browser isolation environment (Menlo, Zscaler BI), LivePaste will:
- Detect the isolation and show a warning badge
- Offer QR code sharing when clipboard is blocked
- Still work for collaboration (isolation doesn't break the core features)

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `DATABASE_URL` | - | Postgres connection string |
| `PORT` | 8080 | Server port |
| `RETENTION_HOURS` | 24 | Room auto-expiry (1-120 hours) |

## Deployment

### GitHub Actions + Hetzner

The repo includes a GitHub Actions workflow for automated deployment:

1. **Set up secrets** in your GitHub repo:
   - `HETZNER_HOST` - Your VPS IP/hostname
   - `HETZNER_USER` - SSH username
   - `HETZNER_SSH_KEY` - SSH private key
   - `DATABASE_URL` - Postgres connection string

2. **Push to main** - The workflow will:
   - Build the Docker image
   - Push to GitHub Container Registry (ghcr.io)
   - SSH to your Hetzner VPS and deploy

See `.github/workflows/deploy.yml` for details.

### Manual Docker Deployment

```bash
# Build
docker build -t livepaste .

# Run
docker run -d \
  -p 8080:8080 \
  -e DATABASE_URL=postgres://user:pass@host:5432/livepaste \
  -e RETENTION_HOURS=24 \
  livepaste
```

## Security

- **Encryption key never leaves client** - URL fragment is not sent in HTTP requests
- **All content encrypted before transmission** - Server sees only encrypted blobs
- **Both file content AND paths encrypted** - True zero-knowledge
- **Password hashed twice** - SHA-256 client-side, bcrypt server-side
- **Random room IDs** - 62^8 = 218 trillion combinations
- **Auto-expiry** - Rooms deleted after configurable inactivity period
- **Kill switch** - Instantly delete room and all content

## Development

```bash
# Development with hot reload (uses src/index.html)
npm run dev:src

# Production build (minifies to public/index.html)
npm run build

# Production start (builds then runs)
npm start
```

## Tech Stack

- **Backend:** Node.js, Express, PostgreSQL
- **Frontend:** Vanilla JS, CodeMirror
- **Encryption:** Web Crypto API (AES-256-GCM)
- **Deployment:** Docker, GitHub Actions

## License

MIT

---

For technical documentation, see [CLAUDE.md](CLAUDE.md).
