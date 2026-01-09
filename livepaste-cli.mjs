#!/usr/bin/env node
/**
 * LivePaste CLI - Allows Claude Code to interact with LivePaste rooms
 *
 * Recommended workflow:
 *   1. tree  - List file paths (small output, for orientation)
 *   2. cat   - Read specific files by path (targeted context)
 *   3. write - Update files directly
 *
 * Commands:
 *   tree <roomUrl>                     List all file paths
 *   cat <roomUrl> <path> [paths...]    Read specific file(s)
 *   read <roomUrl>                     Full dump (use sparingly)
 *   write <roomUrl> <path> <content>   Write/update a file
 *   propose <roomUrl> ...              Propose changeset for review
 *
 * Password-protected rooms:
 *   Use -p <password> or --password <password> before the room URL
 *   Example: node livepaste-cli.mjs tree -p mypassword "http://..."
 */

import { webcrypto, createHash } from 'crypto';
const crypto = webcrypto;

// Hash a path for deterministic lookups
function hashPath(path) {
  return createHash('sha256').update(path).digest('hex');
}

// Hash password for transmission (Client-side protection)
function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

// Parse room URL to extract server, roomId, and encryption key
function parseRoomUrl(url) {
  const parsed = new URL(url);
  const roomId = parsed.pathname.split('/').pop();
  const encryptionKey = parsed.hash.slice(1); // Remove #
  const server = `${parsed.protocol}//${parsed.host}`;
  return { server, roomId, encryptionKey };
}

// Convert base64url key to CryptoKey
async function importKey(base64urlKey) {
  // Pad base64url to base64
  let base64 = base64urlKey.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';

  const keyData = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Encrypt plaintext to base64
async function encrypt(plaintext, cryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

// Decrypt base64 to plaintext
async function decrypt(base64, cryptoKey) {
  if (!base64) return '';
  try {
    const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch (e) {
    return '[Decryption Error]';
  }
}

// Fetch and decrypt room data (shared helper)
async function fetchRoom(roomUrl, password = null) {
  const { server, roomId, encryptionKey } = parseRoomUrl(roomUrl);
  const cryptoKey = await importKey(encryptionKey);

  const headers = {};
  if (password) {
    headers['X-Room-Password'] = password;
  }

  const res = await fetch(`${server}/api/room/${roomId}`, { headers });
  if (res.status === 401) {
    const data = await res.json();
    if (data.password_required) {
      throw new Error('Room is password protected. Use -p <password> or --password <password>');
    }
    throw new Error(`Authentication failed: ${data.error || 'Unknown error'}`);
  }
  if (!res.ok) throw new Error(`Failed to fetch room: ${res.status}`);

  const data = await res.json();
  return { data, cryptoKey, server, roomId };
}

// Read all files from a room (full content)
async function readRoom(roomUrl, password = null) {
  const { data, cryptoKey } = await fetchRoom(roomUrl, password);

  const files = await Promise.all(data.files.map(async f => ({
    id: f.id,
    path: await decrypt(f.path_encrypted, cryptoKey),
    content: f.is_syncable ? await decrypt(f.content_encrypted, cryptoKey) : '[binary]',
    is_syncable: f.is_syncable,
    version: f.version
  })));

  return { version: data.version, files };
}

// List file paths only (for orientation without bloating context)
async function listTree(roomUrl, password = null) {
  const { data, cryptoKey } = await fetchRoom(roomUrl, password);

  const paths = await Promise.all(data.files.map(async f => {
    const path = await decrypt(f.path_encrypted, cryptoKey);
    return { path, syncable: f.is_syncable, size: f.size_bytes };
  }));

  // Sort by path for nice tree view
  paths.sort((a, b) => a.path.localeCompare(b.path));
  return paths;
}

// Read a specific file by path
async function catFile(roomUrl, targetPath, password = null) {
  const { data, cryptoKey } = await fetchRoom(roomUrl, password);

  for (const f of data.files) {
    const path = await decrypt(f.path_encrypted, cryptoKey);
    if (path === targetPath) {
      if (!f.is_syncable) return { path, content: '[binary file]' };
      return { path, content: await decrypt(f.content_encrypted, cryptoKey) };
    }
  }
  throw new Error(`File not found: ${targetPath}`);
}

// Read multiple files by path (batch cat)
async function catFiles(roomUrl, targetPaths, password = null) {
  const { data, cryptoKey } = await fetchRoom(roomUrl, password);
  const pathSet = new Set(targetPaths);
  const results = [];

  for (const f of data.files) {
    const path = await decrypt(f.path_encrypted, cryptoKey);
    if (pathSet.has(path)) {
      if (!f.is_syncable) {
        results.push({ path, content: '[binary file]' });
      } else {
        results.push({ path, content: await decrypt(f.content_encrypted, cryptoKey) });
      }
      pathSet.delete(path);
    }
  }

  // Report missing files
  for (const missing of pathSet) {
    results.push({ path: missing, error: 'File not found' });
  }

  return results;
}

// Write/update a file in a room
async function writeFile(roomUrl, filePath, content, password = null) {
  const { server, roomId, encryptionKey } = parseRoomUrl(roomUrl);
  const cryptoKey = await importKey(encryptionKey);

  const headers = { 'Content-Type': 'application/json' };
  if (password) {
    headers['X-Room-Password'] = password;
  }

  const res = await fetch(`${server}/api/room/${roomId}/files`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      path_hash: hashPath(filePath),
      path_encrypted: await encrypt(filePath, cryptoKey),
      content_encrypted: await encrypt(content, cryptoKey),
      is_syncable: true
    })
  });

  if (res.status === 401) {
    const data = await res.json();
    if (data.password_required) {
      throw new Error('Room is password protected. Use -p <password> or --password <password>');
    }
  }
  if (!res.ok) throw new Error(`Failed to write file: ${res.status}`);
  return res.json();
}

// Propose a changeset
async function proposeChangeset(roomUrl, author, message, changes, password = null) {
  const { server, roomId, encryptionKey } = parseRoomUrl(roomUrl);
  const cryptoKey = await importKey(encryptionKey);

  const headers = { 'Content-Type': 'application/json' };
  if (password) {
    headers['X-Room-Password'] = password;
  }

  const encryptedChanges = await Promise.all(changes.map(async c => ({
    file_path_encrypted: await encrypt(c.filePath, cryptoKey),
    old_content_encrypted: await encrypt(c.oldContent, cryptoKey),
    new_content_encrypted: await encrypt(c.newContent, cryptoKey),
    diff_encrypted: await encrypt(c.diff || '', cryptoKey)
  })));

  const res = await fetch(`${server}/api/room/${roomId}/changesets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      author_encrypted: await encrypt(author, cryptoKey),
      message_encrypted: await encrypt(message, cryptoKey),
      changes: encryptedChanges
    })
  });

  if (res.status === 401) {
    const data = await res.json();
    if (data.password_required) {
      throw new Error('Room is password protected. Use -p <password> or --password <password>');
    }
  }
  if (!res.ok) throw new Error(`Failed to create changeset: ${res.status}`);
  return res.json();
}

// Kill/Delete a room
async function killRoom(roomUrl, password = null) {
  const { server, roomId } = parseRoomUrl(roomUrl);

  const headers = {};
  if (password) {
    headers['X-Room-Password'] = password;
  }

  const res = await fetch(`${server}/api/room/${roomId}`, {
    method: 'DELETE',
    headers
  });

  if (res.status === 401) {
    const data = await res.json();
    if (data.password_required) {
      throw new Error('Room is password protected. Use -p <password> or --password <password>');
    }
  }
  if (!res.ok && res.status !== 404) throw new Error(`Failed to kill room: ${res.status}`);
  return { success: true };
}

// CLI interface - parse password option first
function parseArgs(rawArgs) {
  let password = null;
  const args = [];

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '-p' || rawArgs[i] === '--password') {
      password = rawArgs[++i];
    } else {
      args.push(rawArgs[i]);
    }
  }

  return { password, args };
}

const [,, command, ...rawArgs] = process.argv;
const { password: rawPassword, args } = parseArgs(rawArgs);
// Hash the password immediately so we never send plaintext
const password = rawPassword ? hashPassword(rawPassword) : null;

async function main() {
  try {
    switch (command) {
      case 'tree': {
        const [roomUrl] = args;
        if (!roomUrl) {
          console.error('Usage: node livepaste-cli.mjs tree [-p password] <roomUrl>');
          process.exit(1);
        }
        const paths = await listTree(roomUrl, password);
        // Output as simple tree for easy reading
        for (const f of paths) {
          const suffix = f.syncable ? '' : ` [binary, ${f.size || '?'} bytes]`;
          console.log(f.path + suffix);
        }
        break;
      }

      case 'cat': {
        const [roomUrl, ...filePaths] = args;
        if (!roomUrl || filePaths.length === 0) {
          console.error('Usage: node livepaste-cli.mjs cat [-p password] <roomUrl> <path1> [path2]...');
          process.exit(1);
        }
        if (filePaths.length === 1) {
          const result = await catFile(roomUrl, filePaths[0], password);
          console.log(result.content);
        } else {
          const results = await catFiles(roomUrl, filePaths, password);
          for (const r of results) {
            console.log(`\n=== ${r.path} ===`);
            console.log(r.error || r.content);
          }
        }
        break;
      }

      case 'read': {
        const [roomUrl] = args;
        if (!roomUrl) {
          console.error('Usage: node livepaste-cli.mjs read [-p password] <roomUrl>');
          process.exit(1);
        }
        const result = await readRoom(roomUrl, password);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'write': {
        const [roomUrl, filePath, ...contentParts] = args;
        const content = contentParts.join(' ');
        if (!roomUrl || !filePath) {
          console.error('Usage: node livepaste-cli.mjs write [-p password] <roomUrl> <filePath> <content>');
          process.exit(1);
        }
        const result = await writeFile(roomUrl, filePath, content, password);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'propose': {
        const [roomUrl, author, message, filePath, oldContent, newContent] = args;
        if (!roomUrl || !author || !message || !filePath) {
          console.error('Usage: node livepaste-cli.mjs propose [-p password] <roomUrl> <author> <message> <filePath> <oldContent> <newContent>');
          process.exit(1);
        }
        const result = await proposeChangeset(roomUrl, author, message, [{
          filePath,
          oldContent: oldContent || '',
          newContent: newContent || ''
        }], password);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'kill': {
        const [roomUrl] = args;
        if (!roomUrl) {
          console.error('Usage: node livepaste-cli.mjs kill [-p password] <roomUrl>');
          process.exit(1);
        }
        await killRoom(roomUrl, password);
        console.log(JSON.stringify({ success: true, message: 'Room deleted' }, null, 2));
        break;
      }

      default:
        console.log(`LivePaste CLI - Claude Code Integration

Commands:
  tree [-p password] <roomUrl>                           List all file paths (lightweight)
  cat [-p password] <roomUrl> <path> [path2...]          Read specific file(s) by path
  read [-p password] <roomUrl>                           Read ALL files (full dump, use sparingly)
  write [-p password] <roomUrl> <filePath> <content>     Write/update a file
  propose [-p password] <roomUrl> <author> <msg> ...     Propose a changeset
  kill [-p password] <roomUrl>                           Delete the room and all content

Password Options:
  -p, --password <password>   Password for password-protected rooms

Workflow for Claude Code:
  1. Run 'tree' first to see what files exist
  2. Run 'cat' for specific files you need to read
  3. Use 'write' to update files or 'propose' for review

Examples:
  # Public room
  node livepaste-cli.mjs tree "http://localhost:8080/room/abc123#keyhere"

  # Password-protected room
  node livepaste-cli.mjs tree -p secret123 "http://localhost:8080/room/abc123#keyhere"
  node livepaste-cli.mjs cat -p secret123 "http://localhost:8080/room/abc123#keyhere" src/app.js
  node livepaste-cli.mjs write -p secret123 "http://localhost:8080/room/abc123#keyhere" test.txt "Hello"
`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
