/**
 * End-to-end check of the corpus pass against the REAL session store.
 *
 * Reproduces exactly what the Host does — list every session, read it, fall back
 * to the legacy archive when the service refuses the log, and record a permanent
 * failure otherwise — then runs the pass a SECOND time to prove the reported
 * counters stop growing.
 *
 * That growth was the reported bug: a handful of unreadable legacy artifacts were
 * re-attempted on every poll, so the failure tally climbed without bound while the
 * number of broken sessions stayed fixed.
 *
 * Run: `node verify/corpus-pass.js`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

import { emptyAggregate, foldSessionIntoAggregate, totalOf } from '../usage-fold.js';
import { inheritedCut, reasonOf } from '../index.js';

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

const root = join(homedir(), '.dsh', 'sessions');

/** Every session directory under the store root. */
function sessionDirs() {
  const out = [];
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    for (const session of readdirSync(join(root, workspace.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      out.push({ id: session.name, dir: join(root, workspace.name, session.name) });
    }
  }
  return out;
}

/**
 * Stand-in for `sessionQuery.readSession`.
 *
 * A session with a versioned generation reads cleanly; a v0-only session is
 * refused exactly as the format migration refuses it, so the fallback path is
 * exercised for real.
 */
async function readSession(entry) {
  const files = readdirSync(entry.dir);
  const versioned = files.filter((name) => name.startsWith('session.v') && name.endsWith('.jsonl.zstd'));
  if (versioned.length > 0) {
    const text = decompressAllFrames(readFileSync(join(entry.dir, versioned[versioned.length - 1])));
    const events = [];
    let cwd = null;
    let isSeeded = false;
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
        isSeeded = parsed.isSeeded === true;
        continue;
      }
      events.push(parsed);
    }
    return { events, cwd, isSeeded, inheritedEventCount: inheritedCut(events, 0, isSeeded) };
  }
  throw new Error(
    '@deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: '
    + 'assistant/message 360 message content[2] name must be a non-empty string; '
    + `source v0 artifact remains unchanged (raw log: ${join(entry.dir, 'session.jsonl.zstd')})`,
  );
}

/** The legacy archive beside a refused log, plus its declared workspace. */
function readLegacy(entry) {
  const path = join(entry.dir, 'session.jsonl.zstd');
  let text;
  try {
    text = decompressAllFrames(readFileSync(path));
  } catch {
    return null;
  }
  const events = [];
  let cwd = null;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type === 'session') {
      if (typeof parsed.cwd === 'string') cwd = parsed.cwd;
      continue;
    }
    events.push(parsed);
  }
  return events.length === 0 ? null : { events, cwd };
}

const entries = sessionDirs();
const tzOffsetMinutes = -new Date().getTimezoneOffset();

/** One process-lifetime corpus state, mirroring the Host ledger. */
function createCorpus() {
  return {
    aggregate: emptyAggregate(),
    cursor: new Map(),
    unreadable: new Map(),
    seeded: false,
    telemetry: { sessionsScanned: 0, sessionsFailed: 0, recovered: 0 },
    attempts: 0,
  };
}

/**
 * One corpus pass over whatever is still pending. A second pass on the same
 * state must find nothing to do.
 * @param {object} state - the process-lifetime state.
 * @returns {Promise<void>}
 */
async function runPass(state) {
  if (state.seeded) return;
  const pending = entries.filter((entry) => !state.cursor.has(entry.id) && !state.unreadable.has(entry.id));
  for (const entry of pending) {
    state.attempts += 1;
    try {
      const snapshot = await readSession(entry);
      foldSessionIntoAggregate(state.aggregate, {
        events: snapshot.events,
        inheritedEventCount: snapshot.inheritedEventCount,
        sessionId: entry.id,
        cwd: snapshot.cwd,
      }, { tzOffsetMinutes });
      state.cursor.set(entry.id, -1);
      state.telemetry.sessionsScanned += 1;
    } catch (error) {
      const legacy = readLegacy(entry);
      if (legacy !== null) {
        foldSessionIntoAggregate(state.aggregate, {
          events: legacy.events,
          inheritedEventCount: 0,
          sessionId: entry.id,
          cwd: legacy.cwd,
        }, { tzOffsetMinutes });
        state.cursor.set(entry.id, -1);
        state.telemetry.recovered += 1;
        state.unreadable.set(entry.id, reasonOf(error));
        continue;
      }
      state.unreadable.set(entry.id, reasonOf(error));
      state.telemetry.sessionsFailed += 1;
    }
  }
  state.seeded = true;
}

console.log(`sessions in the store: ${entries.length}`);
console.log('');

const state = createCorpus();
await runPass(state);
console.log('PASS 1');
console.log(`  read attempts          : ${state.attempts}`);
console.log(`  folded normally        : ${state.telemetry.sessionsScanned}`);
console.log(`  recovered from legacy  : ${state.telemetry.recovered}`);
console.log(`  permanently unreadable : ${state.telemetry.sessionsFailed}`);
console.log(`  total tokens           : ${totalOf(state.aggregate.totals)}`);
console.log(`  settlements            : ${state.aggregate.totals.calls}`);

const tokensAfterFirst = totalOf(state.aggregate.totals);
const scannedAfterFirst = state.telemetry.sessionsScanned;
const failedAfterFirst = state.telemetry.sessionsFailed;
const attemptsAfterFirst = state.attempts;

await runPass(state);
console.log('');
console.log('PASS 2 (later poll, same process state)');
console.log(`  read attempts          : ${state.attempts - attemptsAfterFirst}`);
console.log(`  folded normally        : ${state.telemetry.sessionsScanned - scannedAfterFirst}`);
console.log(`  permanently unreadable : ${state.telemetry.sessionsFailed - failedAfterFirst}`);
console.log(`  total tokens           : ${totalOf(state.aggregate.totals)}`);

const failures = [];
if (state.attempts !== attemptsAfterFirst) failures.push('a later pass re-attempted settled sessions');
if (totalOf(state.aggregate.totals) !== tokensAfterFirst) failures.push('totals changed across passes');
if (state.telemetry.sessionsScanned !== scannedAfterFirst) failures.push('the scanned counter grew across passes');
if (state.telemetry.sessionsFailed !== failedAfterFirst) failures.push('the failure counter grew across passes');
if (state.telemetry.sessionsScanned + state.telemetry.recovered + state.telemetry.sessionsFailed !== entries.length) {
  failures.push('sessions are unaccounted for');
}

console.log('');
const reasons = new Map();
for (const reason of state.unreadable.values()) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
if (reasons.size > 0) {
  console.log('Distinct reasons (sessions whose log had to be recovered):');
  for (const [reason, count] of reasons) console.log(`  x${count}  ${reason}`);
  console.log('');
}

if (failures.length > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`OK: every pass is idempotent; ${state.telemetry.recovered} session(s) recovered from legacy archives, ${state.telemetry.sessionsFailed} unreadable.`);
