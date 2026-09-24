/**
 * Real-corpus replay of the exact sequence that produced a wrong "today".
 *
 * Re-enacts the reported day against the on-disk corpus: the corpus pass sees only
 * the sessions that existed when the panel was first opened, then every later
 * settlement is fed through the plugin's own live `session/event` handler, in the
 * order the sessions produced them. The resulting payload is compared with raw
 * per-day ground truth computed straight from the logs.
 *
 * Run: node verify/live-replay.js [YYYY-MM-DD] [cutoff HH:MM]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

import { DATA_PATH, apply, inheritedCut } from '../index.js';
import { localDayKey, totalOf } from '../usage-fold.js';

const ZSTD_MAGIC = 0xfd2fb528;

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

const tzOffsetMinutes = -new Date().getTimezoneOffset();
const pad2 = (value) => (value < 10 ? `0${value}` : String(value));
function dayOf(ts) {
  const date = new Date(ts + tzOffsetMinutes * 60_000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}
function stamp(ts) {
  const date = new Date(ts + tzOffsetMinutes * 60_000);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}
/** Local wall-clock instant of `YYYY-MM-DD HH:MM`. */
function localInstant(day, hhmm) {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  return Date.UTC(year, month - 1, date, hour, minute) - tzOffsetMinutes * 60_000;
}

const today = process.argv[2] ?? localDayKey(Date.now(), tzOffsetMinutes);
const cutoffLabel = process.argv[3] ?? '09:30';
const cutoff = localInstant(today, cutoffLabel);
const root = join(homedir(), '.dsh', 'sessions');

// Newest artifact per session id: a session may keep several format revisions.
const byId = new Map();
for (const file of collectLogs(root)) {
  const id = file.slice(root.length + 1).split(/[\\/]/)[1];
  const stat = statSync(file);
  const previous = byId.get(id);
  if (previous === undefined || stat.mtimeMs > previous.mtimeMs) {
    byId.set(id, { file, mtimeMs: stat.mtimeMs });
  }
}

const sessions = [];
for (const [id, entry] of byId) {
  let text;
  try {
    text = decompressAllFrames(readFileSync(entry.file));
  } catch {
    continue;
  }
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
    if (parsed === null || typeof parsed !== 'object') continue;
    if (parsed.type === 'session') {
      cwd = typeof parsed.cwd === 'string' ? parsed.cwd : null;
      isSeeded = parsed.isSeeded === true;
      continue;
    }
    events.push(parsed);
  }
  if (events.length === 0) continue;
  const first = Math.min(...events.map((event) => event.time).filter((time) => typeof time === 'number'));
  sessions.push({ id, cwd, isSeeded, events, first });
}

// Raw ground truth: every settlement on the target day, no cut and no dedup games.
const rawByDay = new Map();
const rawBySession = new Map();
for (const session of sessions) {
  for (const event of session.events) {
    if (event.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (usage === undefined || usage === null) continue;
    const tokens =
      (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    const day = dayOf(event.time);
    rawByDay.set(day, (rawByDay.get(day) ?? 0) + tokens);
    if (day === today) {
      const row = rawBySession.get(session.id) ?? { tokens: 0, calls: 0 };
      row.tokens += tokens;
      row.calls += 1;
      rawBySession.set(session.id, row);
    }
  }
}

const listed = sessions.filter((session) => session.first <= cutoff);
const unlisted = sessions.filter((session) => session.first > cutoff);
console.log(`corpus      : ${sessions.length} sessions on disk`);
console.log(`cutoff      : ${today} ${cutoffLabel} local`);
console.log(`pass sees   : ${listed.length} sessions (existed by the cutoff)`);
console.log(`feed adopts : ${unlisted.length} sessions (created after it)`);
console.log(`raw ${today} : ${rawByDay.get(today) ?? 0} tokens (no cut, every artifact)`);

// The plugin's own Host half, over a corpus stub backed by those real logs.
let live = null;
let route = null;
const ctx = {
  effect: (fn) => {
    fn();
  },
  on: (name, fn) => {
    if (name === 'session/event') live = fn;
    return () => true;
  },
  connection: {
    fetch: {
      register: (entry) => {
        route = entry.fetch;
        return () => true;
      },
    },
  },
  sessionQuery: {
    listSessions: async () => listed.map((session) => ({ header: { id: session.id, cwd: session.cwd } })),
    readSession: async (id) => {
      const session = sessions.find((candidate) => candidate.id === id);
      if (session === undefined) throw new Error(`no such session: ${id}`);
      return {
        session: { cwd: session.cwd, isSeeded: session.isSeeded },
        events: session.events,
        inheritedEventCount: inheritedCut(session.events, 0, session.isSeeded),
      };
    },
  },
};
apply(ctx);

const request = async () => {
  const response = await route(new Request(`http://localhost${DATA_PATH}?days=371`));
  return response.json();
};

const before = await request();
console.log('');
console.log(`panel before the day's work : ${totalOf(before.today)} tokens, ${before.today.calls} calls`);
console.log(`  (the reported symptom: only the pre-cutoff session is visible)`);

// Now replay the day: every event the sessions produced after the cutoff, in time
// order, exactly as the live feed would have received them.
const pending = [];
for (const session of unlisted) {
  for (const event of session.events) pending.push({ session, event });
}
for (const session of listed) {
  for (const event of session.events) {
    if (typeof event.time === 'number' && event.time > cutoff) pending.push({ session, event });
  }
}
pending.sort((left, right) => left.event.time - right.event.time);
for (const { session, event } of pending) {
  live({ id: session.id, header: { cwd: session.cwd } }, event);
}

const after = await request();
console.log('');
console.log(`panel after the replay      : ${totalOf(after.today)} tokens, ${after.today.calls} calls`);
console.log(`raw ${today} settlements     : ${rawBySession.size} sessions, ${[...rawBySession.values()].reduce((sum, row) => sum + row.calls, 0)} calls`);
console.log('');
console.log('per-day: panel vs raw (raw double-counts fork-inherited prefixes)');
for (const day of [...rawByDay.keys()].sort()) {
  const row = after.days.find((candidate) => candidate.day === day);
  const panel = row === undefined ? 0 : totalOf(row);
  const raw = rawByDay.get(day);
  const delta = panel - raw;
  console.log(`  ${day}: panel=${String(panel).padStart(12)}  raw=${String(raw).padStart(12)}  delta=${delta >= 0 ? '+' : ''}${delta}`);
}
console.log('');
console.log(`today delta vs the pre-cutoff figure: +${totalOf(after.today) - totalOf(before.today)} tokens`);
