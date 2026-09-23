/**
 * Verification harness: fold REAL session logs through the plugin's pure fold
 * layer and print the resulting payload. Two purposes:
 *
 *  1. confirms the assumed durable event shapes (`assistant/message` carrying
 *     provider `usage`, `request/header` nesting `config.provider/model`) against
 *     actual on-disk logs rather than documentation alone;
 *  2. cross-checks the aggregate arithmetic independently of the HTTP route,
 *     which needs browser credentials.
 *
 * Session logs are multi-frame zstd JSONL, so frames are walked one at a time.
 * Run: `node verify/real-logs.js`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

import { buildPayload, cacheRateOf, emptyAggregate, foldSessionIntoAggregate, localDayKey, totalOf } from '../usage-fold.js';
import { inheritedCut } from '../index.js';

/** Read the 4-byte little-endian magic of a zstd frame. */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Decompress every zstd frame in one buffer and concatenate the results.
 * @param {Buffer} input - multi-frame zstd bytes.
 * @returns {string} the decoded UTF-8 text.
 */
function decompressAllFrames(input) {
  const parts = [];
  let offset = 0;
  while (offset + 4 <= input.length) {
    if (input.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    // `zstdDecompressSync` decodes exactly the frame at `offset` and reports how
    // many source bytes it consumed via the second return value.
    let decoded;
    try {
      decoded = zstdDecompressSync(input.subarray(offset));
    } catch {
      break;
    }
    if (decoded === undefined || decoded.length === 0) break;
    parts.push(decoded.toString('utf8'));
    // The frame length is not returned directly, so re-derive it by asking the
    // decoder for the consumed input via a bounded search on the next magic.
    const next = findNextMagic(input, offset + 4);
    if (next === -1) break;
    offset = next;
  }
  return parts.join('');
}

/** Index of the next zstd magic at or after `from`, or -1. */
function findNextMagic(input, from) {
  for (let index = from; index + 4 <= input.length; index += 1) {
    if (input.readUInt32LE(index) === ZSTD_MAGIC) return index;
  }
  return -1;
}

/** Recursively collect every `*.jsonl.zstd` session log. */
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
    if (entry.isDirectory()) {
      found.push(...collectLogs(full));
    } else if (entry.name.endsWith('.jsonl.zstd')) {
      found.push(full);
    }
  }
  return found;
}

const sessionsRoot = join(homedir(), '.dsh', 'sessions');
const logs = collectLogs(sessionsRoot);
console.log(`session logs found: ${logs.length}`);

const tzOffsetMinutes = -new Date().getTimezoneOffset();
console.log(`tz offset minutes: ${tzOffsetMinutes}`);

const aggregate = emptyAggregate();
const shapes = { assistantMessage: 0, withUsage: 0, headers: 0, seededSessions: 0, routeSamples: new Set() };
let sessionsFolded = 0;
let sessionsFailed = 0;
let eventsSeen = 0;
/** Newest file per session id (a session may carry several format revisions). */
const newestById = new Map();
for (const file of logs) {
  const id = file.split(/[\\/]/).slice(-2)[0];
  const previous = newestById.get(id);
  const size = statSync(file).size;
  if (previous === undefined || size > previous.size) newestById.set(id, { file, size });
}

for (const [id, entry] of newestById) {
  let text;
  try {
    text = decompressAllFrames(readFileSync(entry.file));
  } catch {
    sessionsFailed += 1;
    continue;
  }
  const lines = text.split('\n').filter((line) => line.length > 0);
  const events = [];
  let cwd = null;
  let isSeeded = false;
  let sessionId = id;
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type === 'session') {
      cwd = typeof parsed.cwd === 'string' ? parsed.cwd : null;
      sessionId = typeof parsed.id === 'string' ? parsed.id : id;
      isSeeded = parsed.isSeeded === true;
      continue;
    }
    if (parsed.type === 'assistant/message') {
      shapes.assistantMessage += 1;
      if (parsed.data !== undefined && parsed.data !== null && parsed.data.usage !== undefined) {
        shapes.withUsage += 1;
      }
    }
    if (parsed.type === 'request/header') {
      shapes.headers += 1;
      const route = parsed.data?.header?.config;
      if (route !== undefined && shapes.routeSamples.size < 5) {
        shapes.routeSamples.add(`${route.provider}/${route.model}`);
      }
    }
    events.push(parsed);
    eventsSeen += 1;
  }
  // Use the SAME cut rule the Host plugin applies, so these numbers describe
  // what the panel would actually show.
  const cut = inheritedCut(events, 0, isSeeded);
  if (isSeeded) shapes.seededSessions += 1;
  foldSessionIntoAggregate(
    aggregate,
    { events, inheritedEventCount: cut, sessionId, cwd },
    { tzOffsetMinutes },
  );
  sessionsFolded += 1;
}

console.log('--- observed durable shapes ---');
console.log(`events parsed           : ${eventsSeen}`);
console.log(`assistant/message       : ${shapes.assistantMessage}`);
console.log(`  ...carrying usage     : ${shapes.withUsage}`);
console.log(`request/header          : ${shapes.headers}`);
console.log(`route samples           : ${[...shapes.routeSamples].join(', ') || '(none)'}`);
console.log(`seeded (fork) sessions  : ${shapes.seededSessions}`);
console.log(`sessions folded         : ${sessionsFolded} (failed ${sessionsFailed})`);
console.log(`malformed usage records : ${aggregate.malformedUsageEvents}`);

const today = localDayKey(Date.now(), tzOffsetMinutes);
const payload = buildPayload(aggregate, {
  revision: 1,
  seeding: false,
  tzOffsetMinutes,
  from: today,
  to: today,
  today,
  telemetry: { sessionsScanned: sessionsFolded, sessionsFailed },
});

console.log('--- aggregate ---');
console.log(`totals        : ${JSON.stringify(aggregate.totals)}`);
console.log(`total tokens  : ${totalOf(aggregate.totals)}`);
console.log(`cache rate    : ${cacheRateOf(aggregate.totals)}`);
console.log(`distinct days : ${Object.keys(aggregate.byDay).length}`);
console.log(`min day       : ${aggregate.minDay}`);
console.log(`workspaces    : ${JSON.stringify(Object.values(aggregate.byWorkspace).map((row) => ({ label: row.label, calls: row.calls, tokens: totalOf(row) })))}`);
console.log('routes:');
for (const route of payload.routes) {
  console.log(`  ${route.provider}/${route.model}: calls=${route.calls} in=${route.inputTokens} out=${route.outputTokens} cRead=${route.cacheReadTokens} cWrite=${route.cacheWriteTokens} total=${totalOf(route)}`);
}
console.log('last 5 days with usage:');
const days = Object.keys(aggregate.byDay).sort().slice(-5);
for (const day of days) {
  console.log(`  ${day}: ${totalOf(aggregate.byDay[day])} tokens (${aggregate.byDay[day].calls} calls)`);
}
console.log('--- payload window (today only) ---');
console.log(JSON.stringify(payload.days));
