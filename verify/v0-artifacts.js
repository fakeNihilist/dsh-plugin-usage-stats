/**
 * Probe the v0 session artifacts the persistence service refuses to read.
 *
 * The service reports `@deepseek-ai/dsh-session-format-v0-to-v1 refuses this
 * format v0 Session`, so the plugin currently loses those sessions entirely.
 * This script answers two questions from the raw bytes:
 *
 *  1. Is the v0 log structurally readable on its own (plain JSONL, no migration)?
 *  2. Do its `assistant/message` events carry a `usage` report the fold can use?
 *
 * It also quantifies the retry amplification: how many sessions the service can
 * never read, so the Host stops re-attempting them.
 *
 * Run: `node verify/v0-artifacts.js`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;

/** Decompress every zstd frame in one buffer. */
function decompressAllFrames(input) {
  const parts = [];
  let offset = 0;
  while (offset + 4 <= input.length && input.readUInt32LE(offset) === ZSTD_MAGIC) {
    let decoded;
    try {
      decoded = zstdDecompressSync(input.subarray(offset));
    } catch {
      return { text: parts.join(''), error: 'zstd frame decode failed' };
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

/** Every session directory with its available log generations. */
function scanSessions() {
  const root = join(homedir(), '.dsh', 'sessions');
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      let files;
      try {
        files = readdirSync(full);
      } catch {
        walk(full);
        continue;
      }
      const logs = files.filter((name) => name.endsWith('.jsonl.zstd'));
      if (logs.length > 0) {
        out.push({
          id: entry.name,
          dir: full,
          v0: logs.includes('session.jsonl.zstd') ? join(full, 'session.jsonl.zstd') : null,
          versioned: logs.filter((name) => name !== 'session.jsonl.zstd').map((name) => join(full, name)),
        });
      }
      walk(full);
    }
  };
  walk(root);
  return out;
}

const sessions = scanSessions();
const v0Only = sessions.filter((session) => session.v0 !== null && session.versioned.length === 0);
const withVersioned = sessions.filter((session) => session.versioned.length > 0);

console.log(`session directories with logs : ${sessions.length}`);
console.log(`  readable generation (vN)     : ${withVersioned.length}`);
console.log(`  v0 artifact only             : ${v0Only.length}`);
console.log(`  both                         : ${sessions.filter((s) => s.v0 !== null && s.versioned.length > 0).length}`);
console.log('');

if (v0Only.length === 0) {
  console.log('No v0-only sessions: nothing is being lost.');
  process.exit(0);
}

const shape = { headers: 0, settlements: 0, withUsage: 0, eventTypes: new Map() };
let totalInput = 0;
let totalOutput = 0;
let totalCacheRead = 0;
let totalCacheWrite = 0;
let unusable = 0;
const versionFieldSamples = new Set();

for (const session of v0Only) {
  const { text, error } = decompressAllFrames(readFileSync(session.v0));
  if (error !== null) {
    unusable += 1;
    console.log(`  ${session.id.slice(0, 24)} UNREADABLE: ${error}`);
    continue;
  }
  let settlements = 0;
  let usage = 0;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const type = typeof parsed.type === 'string' ? parsed.type : '(none)';
    shape.eventTypes.set(type, (shape.eventTypes.get(type) ?? 0) + 1);
    if (parsed.version !== undefined) versionFieldSamples.add(String(parsed.version));
    if (type === 'session') {
      shape.headers += 1;
      continue;
    }
    if (type !== 'assistant/message') continue;
    settlements += 1;
    shape.settlements += 1;
    const report = parsed.data !== undefined && parsed.data !== null ? parsed.data.usage : undefined;
    if (report === undefined || report === null) continue;
    usage += 1;
    shape.withUsage += 1;
    // v0 may name the buckets differently; accept the documented names only.
    totalInput += typeof report.inputTokens === 'number' ? report.inputTokens : 0;
    totalOutput += typeof report.outputTokens === 'number' ? report.outputTokens : 0;
    totalCacheRead += typeof report.cacheReadTokens === 'number' ? report.cacheReadTokens : 0;
    totalCacheWrite += typeof report.cacheWriteTokens === 'number' ? report.cacheWriteTokens : 0;
  }
  console.log(`  ${session.id.slice(0, 24)} settlements=${String(settlements).padEnd(5)} usage=${String(usage).padEnd(5)} bytes=${statSync(session.v0).size}`);
}

console.log('');
console.log(`v0 generations read          : ${shape.headers}`);
console.log(`v0 settlements               : ${shape.settlements}`);
console.log(`  carrying a usage report    : ${shape.withUsage}`);
console.log(`  without a usage report     : ${shape.settlements - shape.withUsage}`);
console.log(`unreadable v0 artifacts      : ${unusable}`);
console.log(`v0 token totals              : input=${totalInput} output=${totalOutput} cacheRead=${totalCacheRead} cacheWrite=${totalCacheWrite}`);
console.log(`total                        : ${totalInput + totalOutput + totalCacheRead + totalCacheWrite}`);
console.log('');
console.log('v0 event types:');
for (const [type, count] of [...shape.eventTypes].sort((left, right) => right[1] - left[1]).slice(0, 14)) {
  console.log(`  ${String(count).padStart(6)}  ${type}`);
}
console.log('');
console.log(`version field values seen    : ${[...versionFieldSamples].join(', ') || '(none)'}`);
