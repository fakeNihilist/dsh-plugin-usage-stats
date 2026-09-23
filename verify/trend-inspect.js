/**
 * Print the trend chart's inputs exactly as the browser half computes them, so
 * the picture can be sanity-checked against the headline cards.
 *
 * Mirrors the render suite's real-corpus build on purpose: newest file per
 * session, the fork-inherited prefix cut, and the same payload options. A
 * simpler fold reads zero tokens here, which is a trap worth avoiding.
 *
 * usage: node verify/trend-inspect.js [sessions-dir]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { emptyAggregate, foldSessionIntoAggregate, buildPayload, localDayKey, totalOf } from '../usage-fold.js';
import { inheritedCut } from '../index.js';

const ZSTD_MAGIC = 0xfd2fb528;

function decompressAllFrames(input) {
  const parts = [];
  let offset = 0;
  while (offset + 4 <= input.length && input.readUInt32LE(offset) === ZSTD_MAGIC) {
    let decoded;
    try {
      decoded = zstdDecompressSync(input.subarray(offset));
    } catch {
      return parts.join('');
    }
    if (decoded === undefined || decoded.length === 0) return parts.join('');
    parts.push(decoded.toString('utf8'));
    let next = -1;
    for (let index = offset + 4; index + 4 <= input.length; index += 1) {
      if (input.readUInt32LE(index) === ZSTD_MAGIC) { next = index; break; }
    }
    if (next === -1) return parts.join('');
    offset = next;
  }
  return parts.join('');
}

function collectLogs(root, found = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) collectLogs(full, found);
    else if (entry.name.endsWith('.jsonl.zstd')) found.push(full);
  }
  return found;
}

const root = process.argv[2] ?? join(homedir(), '.dsh', 'sessions');
if (!existsSync(root)) {
  console.error(`no session directory at ${root}`);
  process.exit(1);
}

const logs = collectLogs(root);
if (logs.length === 0) {
  console.error(`no session logs under ${root}`);
  process.exit(1);
}

const newest = new Map();
for (const file of logs) {
  const id = file.split(/[\\/]/).slice(-2)[0];
  const size = statSync(file).size;
  const previous = newest.get(id);
  if (previous === undefined || size > previous.size) newest.set(id, file);
}

const tzOffsetMinutes = -new Date().getTimezoneOffset();
const aggregate = emptyAggregate();
let folded = 0;
for (const file of newest.values()) {
  let text;
  try {
    text = decompressAllFrames(readFileSync(file));
  } catch {
    continue;
  }
  const events = [];
  let cwd = null;
  let isSeeded = false;
  let sessionId = file.split(/[\\/]/).slice(-2)[0];
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
      continue;
    }
    events.push(parsed);
  }
  foldSessionIntoAggregate(
    aggregate,
    { events, inheritedEventCount: inheritedCut(events, 0, isSeeded), sessionId, cwd },
    { tzOffsetMinutes },
  );
  folded += 1;
}

const today = localDayKey(Date.now(), tzOffsetMinutes);
const payload = buildPayload(aggregate, {
  revision: 7,
  seeding: false,
  tzOffsetMinutes,
  from: Object.keys(aggregate.byDay).sort()[0],
  to: today,
  today,
  telemetry: { sessionsScanned: folded, sessionsFailed: 0 },
});

/**
 * Trend windows the browser half offers, and the one this report inspects.
 *
 * The panel also offers "all" (the payload's own span, which with no `days`
 * parameter is the corpus start). This script keeps inspecting the 30-day window
 * because its figures are meant to be comparable between runs.
 */
const TREND_RANGES = [7, 30];
const TREND_DAYS = 30;

const rows = payload.days.slice(-TREND_DAYS);
const stacked = rows.map((row) => (row.inputTokens ?? 0) + (row.outputTokens ?? 0));
const sum = (pick) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
const input = sum((row) => row.inputTokens);
const output = sum((row) => row.outputTokens);
const cacheRead = sum((row) => row.cacheReadTokens);

console.log(`folded sessions   ${folded} of ${logs.length} logs (newest per session)`);
console.log(`payload days      ${payload.days.length}   window ${payload.days[0]?.day} .. ${payload.days[payload.days.length - 1]?.day}`);
console.log(`plotted rows      ${rows.length}   window ${rows[0]?.day} .. ${rows[rows.length - 1]?.day}   (range control offers ${TREND_RANGES.join(' / ')} days)`);
console.log(`non-zero stacks   ${stacked.filter((value) => value > 0).length} of ${rows.length}`);
console.log('');
console.log(`payload totals    tokens=${totalOf(payload.totals)} input=${payload.totals.inputTokens} output=${payload.totals.outputTokens} cacheRead=${payload.totals.cacheReadTokens}`);
console.log(`plotted sums      input=${input} output=${output} cacheRead=${cacheRead}`);
console.log(`bar stacks total  ${input + output}`);
console.log(`cache rate        ${cacheRead + input === 0 ? 'n/a' : `${((cacheRead / (cacheRead + input)) * 100).toFixed(1)}%`}`);
console.log('');
const noRatio = rows.filter((row) => (row.inputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0) === 0);
console.log(`rows with no cache ratio (no bar drawn): ${noRatio.length}`);
const nonZero = stacked.filter((value) => value > 0);
console.log(`peak stack        ${Math.max(...stacked, 0)}`);
console.log(`min non-zero      ${nonZero.length > 0 ? Math.min(...nonZero) : 0}`);
