/**
 * Decision harness: which cut source yields the correct dedup without dropping a
 * session's own settlements?
 *
 * Candidates:
 *   A. `isSeeded` false  -> cut 0                          (assume no inheritance)
 *   B. last `session/end-seed` marker + 1 -> cut          (marker-derived)
 *   C. cut 0 always                                        (upper bound: no dedup)
 *
 * A seeded fork's log is a byte-identical copy of its parent's prefix, so the
 * correct cut is the one making each settlement counted exactly once corpus-wide.
 * A large `settlements` count with a mid-log marker is the tell that a marker is
 * a lifecycle boundary rather than an inheritance boundary.
 *
 * Run: `node verify/cut-compare.js`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

import { emptyAggregate, foldSessionIntoAggregate, totalOf } from '../usage-fold.js';

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
      break;
    }
    if (decoded === undefined || decoded.length === 0) break;
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
  return parts.join('');
}

/** Recursively collect every session log. */
function collectLogs(root) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...collectLogs(full));
    else if (entry.name.endsWith('.jsonl.zstd')) found.push(full);
  }
  return found;
}

/** Parse one log into a foldable session plus its observed markers. */
function parseLog(file) {
  const text = decompressAllFrames(readFileSync(file));
  const events = [];
  let cwd = null;
  let sessionId = file.split(/[\\/]/).slice(-2)[0];
  let isSeeded = false;
  let parentSession = null;
  let lastEndSeedSeq = -1;
  let inheritedMarkerSeq = -1;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type === 'session') {
      cwd = typeof parsed.cwd === 'string' ? parsed.cwd : null;
      sessionId = typeof parsed.id === 'string' ? parsed.id : sessionId;
      isSeeded = parsed.isSeeded === true;
      parentSession = typeof parsed.parentSession === 'string' ? parsed.parentSession : null;
      continue;
    }
    if (parsed.type === 'session/end-seed' && typeof parsed.seq === 'number') {
      lastEndSeedSeq = parsed.seq;
      if (parsed.data !== undefined && parsed.data !== null && parsed.data.inherited === true) {
        inheritedMarkerSeq = parsed.seq;
      }
    }
    events.push(parsed);
  }
  return { file, sessionId, cwd, isSeeded, parentSession, lastEndSeedSeq, inheritedMarkerSeq, events };
}

const byId = new Map();
for (const file of collectLogs(join(homedir(), '.dsh', 'sessions'))) {
  const id = file.split(/[\\/]/).slice(-2)[0];
  const size = statSync(file).size;
  const previous = byId.get(id);
  if (previous === undefined || size > previous.size) byId.set(id, file);
}

const sessions = [...byId.values()].map((file) => parseLog(file));
const tzOffsetMinutes = -new Date().getTimezoneOffset();

/** Total folded tokens for one cut strategy. */
function foldAll(cutOf) {
  const aggregate = emptyAggregate();
  for (const session of sessions) {
    foldSessionIntoAggregate(
      aggregate,
      { events: session.events, inheritedEventCount: cutOf(session), sessionId: session.sessionId, cwd: session.cwd },
      { tzOffsetMinutes },
    );
  }
  return aggregate;
}

const strategies = {
  'A: isSeeded ? lastEndSeed : 0  (NAIVE, over-cuts false seeds)': (session) => (
    session.isSeeded ? session.lastEndSeedSeq + 1 : 0
  ),
  'B: marker-derived cut always   (WRONG, over-cuts)': (session) => session.lastEndSeedSeq + 1,
  'C: tagged `inherited: true` marker only': (session) => session.inheritedMarkerSeq + 1,
  'D: no dedup (cut 0 everywhere) (double-counts forks)': () => 0,
  'E: SHIPPED RULE - isSeeded ? taggedMarker : 0': (session) => (
    session.isSeeded ? session.inheritedMarkerSeq + 1 : 0
  ),
};

for (const [label, cutOf] of Object.entries(strategies)) {
  const aggregate = foldAll(cutOf);
  console.log(`${label}`);
  console.log(`   calls=${aggregate.totals.calls} tokens=${totalOf(aggregate.totals)} days=${Object.keys(aggregate.byDay).length}`);
}

// Cross-check: the shipped rule must agree with the tagged-marker rule wherever
// a tagged marker exists, since those sessions are the only ones that inherit.
const shipped = foldAll(strategies['E: SHIPPED RULE - isSeeded ? taggedMarker : 0']);
const tagged = foldAll(strategies['C: tagged `inherited: true` marker only']);
const agrees = totalOf(shipped.totals) === totalOf(tagged.totals)
  && shipped.totals.calls === tagged.totals.calls;
console.log('');
if (agrees) {
  console.log(`CROSS-CHECK OK: shipped rule == tagged-marker rule (${shipped.totals.calls} calls, ${totalOf(shipped.totals)} tokens)`);
} else {
  // This script compares cut strategies, and the cross-check is the one comparison on
  // which the shipped rule itself is the subject. It used to print the mismatch and
  // exit 0, so a broken shipped rule reported success to anything reading the status.
  console.log(`CROSS-CHECK MISMATCH: shipped=${shipped.totals.calls}/${totalOf(shipped.totals)} tagged=${tagged.totals.calls}/${totalOf(tagged.totals)}`);
  process.exitCode = 1;
}

console.log('');
console.log('session detail (seeded-ness vs markers):');
console.log('  id                     isSeeded parent present  endSeed inheritedMark settlements');
for (const session of sessions) {
  const settlements = session.events.filter((event) => event.type === 'assistant/message' && event.data?.usage !== undefined).length;
  const endSeed = session.lastEndSeedSeq >= 0 ? String(session.lastEndSeedSeq) : '-';
  const inheritedMark = session.inheritedMarkerSeq >= 0 ? String(session.inheritedMarkerSeq) : '-';
  const parent = session.parentSession !== null ? 'yes' : 'no';
  console.log(`  ${session.sessionId.slice(0, 22).padEnd(22)} ${String(session.isSeeded).padEnd(8)} ${parent.padEnd(8)} ${endSeed.padEnd(9)} ${inheritedMark.padEnd(15)} ${settlements}`);
}
