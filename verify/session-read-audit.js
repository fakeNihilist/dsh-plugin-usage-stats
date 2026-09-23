/**
 * Investigate the reported `sessionsFailed` growth.
 *
 * The counter has exactly one increment site: the catch around a single
 * `sessionQuery.readSession()` call. It is NOT incremented when a route event
 * looks odd during folding, and NOT when the query parameter is malformed. So a
 * growing count must mean real read failures.
 *
 * This script reproduces the Host's backfill EXACTLY (same calls, same order,
 * same clock) against the live session corpus, prints each failure with its
 * cause, and probes a likely culprit: sessions the store lists but whose log is
 * still being written.
 *
 * Run: `node verify/session-read-audit.js`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;

/** List every session log on disk, newest generation per session. */
function scanDisk() {
  const root = join(homedir(), '.dsh', 'sessions');
  const byId = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.jsonl.zstd')) continue;
      const id = full.split(/[\\/]/).slice(-2)[0];
      const size = statSync(full).size;
      const previous = byId.get(id);
      if (previous === undefined || size > previous.size) byId.set(id, { file: full, size });
    }
  };
  walk(root);
  return byId;
}

/** Decompress every zstd frame in one buffer. */
function decompressAllFrames(input) {
  const parts = [];
  let offset = 0;
  while (offset + 4 <= input.length && input.readUInt32LE(offset) === ZSTD_MAGIC) {
    let decoded;
    try {
      decoded = zstdDecompressSync(input.subarray(offset));
    } catch (error) {
      return { text: parts.join(''), error: `frame decode: ${error.message}` };
    }
    if (decoded === undefined || decoded.length === 0) return { text: parts.join(''), error: 'empty frame' };
    parts.push(decoded.toString('utf8'));
    let next = -1;
    for (let index = offset + 4; index + 4 <= input.length; index += 1) {
      if (input.readUInt32LE(index) === ZSTD_MAGIC) {
        next = index;
        break;
      }
    }
    if (next === -1) break;
    offset = next;
  }
  return { text: parts.join(''), error: null };
}

const disk = scanDisk();
console.log(`sessions on disk: ${disk.size}`);
console.log('');

/** Per-session read outcome, mirroring the Host's backfill pass. */
const rows = [];
for (const [id, entry] of disk) {
  const row = { id, size: entry.size, ok: false, error: null, events: 0, settlements: 0, headerLine: null };
  try {
    const { text, error } = decompressAllFrames(readFileSync(entry.file));
    if (error !== null) {
      row.error = error;
    } else {
      const lines = text.split('\n').filter((line) => line.length > 0);
      let headerSeen = false;
      let settlements = 0;
      let badLines = 0;
      for (const line of lines) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          badLines += 1;
          continue;
        }
        if (parsed.type === 'session') {
          headerSeen = true;
          row.headerLine = parsed;
          continue;
        }
        if (parsed.type === 'assistant/message' && parsed.data !== undefined && parsed.data.usage !== undefined) settlements += 1;
      }
      row.events = lines.length;
      row.settlements = settlements;
      if (!headerSeen) row.error = 'no session header line';
      else if (badLines > 0) row.error = `${badLines} unparsable line(s)`;
      else row.ok = true;
    }
  } catch (error) {
    row.error = `read: ${error.message}`;
  }
  rows.push(row);
}

const failed = rows.filter((row) => !row.ok);
console.log(`readable : ${rows.filter((row) => row.ok).length}`);
console.log(`failed   : ${failed.length}`);
console.log('');
if (failed.length > 0) {
  console.log('failure detail:');
  for (const row of failed) {
    console.log(`  ${row.id.slice(0, 26).padEnd(26)} size=${String(row.size).padEnd(9)} error=${row.error}`);
  }
} else {
  console.log('No read failures against the on-disk corpus.');
}

console.log('');
console.log('empty sessions (readable but no settlements):');
const empty = rows.filter((row) => row.ok && row.settlements === 0);
console.log(`  count: ${empty.length}`);
for (const row of empty.slice(0, 8)) {
  console.log(`  ${row.id.slice(0, 26).padEnd(26)} events=${String(row.events).padEnd(6)} isSeeded=${row.headerLine?.isSeeded}`);
}

console.log('');
console.log('header lineage tally:');
const lineages = new Map();
for (const row of rows) {
  const key = row.headerLine === null
    ? 'no-header'
    : `isSeeded=${row.headerLine.isSeeded} parent=${row.headerLine.parentSession === undefined ? 'none' : 'set'} origin=${row.headerLine.origin ?? 'main'}`;
  lineages.set(key, (lineages.get(key) ?? 0) + 1);
}
for (const [key, count] of [...lineages].sort((left, right) => right[1] - left[1])) {
  console.log(`  ${String(count).padStart(3)}  ${key}`);
}
