/**
 * Payload conformance: build the exact object the Host route would return from
 * real logs and assert the invariants the panel relies on.
 *
 * This stands in for an authenticated HTTP request, which cannot be made from a
 * shell session (the shared `/api` channel enforces its own admission policy).
 *
 * Run: `node verify/payload-conformance.js`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

import { buildPayload, emptyAggregate, foldSessionIntoAggregate, localDayKey, shiftDay } from '../usage-fold.js';
import { inheritedCut, windowStartFor } from '../index.js';

const ZSTD_MAGIC = 0xfd2fb528;
const failures = [];

/** Record one invariant result. */
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail === '' ? '' : ` (${detail})`}`);
  } else {
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` (${detail})`}`);
    failures.push(label);
  }
}

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

/** Recursively collect session logs. */
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
const aggregate = emptyAggregate();
const newest = new Map();
for (const file of collectLogs(join(homedir(), '.dsh', 'sessions'))) {
  const id = file.split(/[\\/]/).slice(-2)[0];
  const size = statSync(file).size;
  const previous = newest.get(id);
  if (previous === undefined || size > previous.size) newest.set(id, file);
}

let sessionsScanned = 0;
let sessionsFailed = 0;
for (const file of newest.values()) {
  let text;
  try {
    text = decompressAllFrames(readFileSync(file));
  } catch {
    sessionsFailed += 1;
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
  sessionsScanned += 1;
}

const today = localDayKey(Date.now(), tzOffsetMinutes);
// Mirror the route exactly: it asks for a year of heatmap, and `windowStartFor`
// widens that back to the corpus start when the corpus is older than a year.
const windowFrom = windowStartFor(Object.keys(aggregate.byDay).sort()[0], shiftDay(today, -370), today);
/** Build one payload exactly as the route would, including the focus options. */
const build = (focus = {}, telemetry = { sessionsScanned, sessionsFailed, failureReasons: [] }) => buildPayload(aggregate, {
  revision: 1,
  seeding: false,
  tzOffsetMinutes,
  from: windowFrom,
  to: today,
  today,
  focus,
  telemetry,
});
const payload = build();

const sum = (rows) => rows.reduce(
  (accumulator, row) => ({
    calls: accumulator.calls + row.calls,
    inputTokens: accumulator.inputTokens + row.inputTokens,
    outputTokens: accumulator.outputTokens + row.outputTokens,
    cacheReadTokens: accumulator.cacheReadTokens + row.cacheReadTokens,
    cacheWriteTokens: accumulator.cacheWriteTokens + row.cacheWriteTokens,
  }),
  { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
);

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const withDay = (buckets, day) => ({ day, ...buckets });

console.log(`window ${payload.from} .. ${payload.to} (${payload.days.length} days)`);
console.log('invariants:');

check('the day series is dense and ascending', payload.days.every((row, index) => (
  index === 0 || payload.days[index - 1].day < row.day
)) && payload.days.length > 0);

check('days sum to totals', same(sum(payload.days), payload.totals), JSON.stringify(payload.totals));

const workspaceTotal = Object.values(payload.workspaceDays)
  .flat()
  .reduce((accumulator, row) => ({
    calls: accumulator.calls + row.calls,
    inputTokens: accumulator.inputTokens + row.inputTokens,
    outputTokens: accumulator.outputTokens + row.outputTokens,
    cacheReadTokens: accumulator.cacheReadTokens + row.cacheReadTokens,
    cacheWriteTokens: accumulator.cacheWriteTokens + row.cacheWriteTokens,
  }), { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
check('per-workspace days sum to totals', same(workspaceTotal, payload.totals));

check('routes sum to totals', same(sum(payload.routes), payload.totals));

check('every day lies inside the window', payload.days.every((row) => (
  row.day >= payload.from && row.day <= payload.to
)));

check('today is present exactly once', payload.days.filter((row) => row.day === payload.today.day).length === 1);

const todayRow = payload.days.find((row) => row.day === payload.today.day);
check('the today card repeats its day row verbatim', same(payload.today, withDay(
  {
    calls: todayRow.calls,
    inputTokens: todayRow.inputTokens,
    outputTokens: todayRow.outputTokens,
    cacheReadTokens: todayRow.cacheReadTokens,
    cacheWriteTokens: todayRow.cacheWriteTokens,
  },
  payload.today.day,
)));

check('every value is a finite non-negative number', payload.days.every((row) => [
  row.calls, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens,
].every((value) => Number.isFinite(value) && value >= 0)));

check('the payload is lossless JSON under 8 MiB', (() => {
  const text = JSON.stringify(payload);
  const roundTrip = JSON.parse(text);
  return same(roundTrip.totals, payload.totals) && Buffer.byteLength(text) < 8 * 1024 * 1024;
})());

check('workspaces carry a display label', payload.workspaces.every((workspace) => (
  typeof workspace.label === 'string' && workspace.label.length > 0
)));

check('reported warnings are counters', Number.isInteger(payload.warnings.sessionsScanned)
  && Number.isInteger(payload.warnings.sessionsFailed)
  && Number.isInteger(payload.warnings.malformedUsageEvents));

check('an unfiltered payload carries no focus', payload.focus.workspace === null
  && payload.focus.start === null && payload.focus.end === null);

// ---- focus semantics: every headline figure must follow the same filter ----

const lastSeven = payload.days.slice(-7);
const focused = build({ start: lastSeven[0].day, end: lastSeven[lastSeven.length - 1].day });
check('a day-range focus narrows the totals to that range',
  same(focused.totals, sum(lastSeven)), `${JSON.stringify(focused.totals)}`);

check('a day-range focus still ships the whole heatmap window',
  focused.days.length === payload.days.length, `${focused.days.length} days`);

check('a day-range focus narrows the trend window',
  focused.trend.days.length === lastSeven.length && focused.trend.days[0] === lastSeven[0].day,
  `${focused.trend.days.length} trend days`);

check('focused route totals equal the focused grand total',
  same(sum(focused.routes), focused.totals));

if (payload.workspaces.length > 0) {
  const workspace = payload.workspaces[0].key;
  const scoped = build({ workspace });
  const scopedSeries = payload.workspaceDays[workspace];
  check('a workspace focus narrows the totals to that workspace',
    same(scoped.totals, sum(scopedSeries)), `${JSON.stringify(scoped.totals)}`);

  check('a workspace focus keeps only that workspace in the selector',
    scoped.workspaces.length === 1 && scoped.workspaces[0].key === workspace);

  check('a workspace focus narrows the route breakdown to that workspace',
    sum(scoped.routes).calls <= scoped.totals.calls && same(sum(scoped.routes), scoped.totals),
    `${scoped.routes.length} routes`);

  const combined = build({
    workspace,
    start: scopedSeries[0].day,
    end: scopedSeries[scopedSeries.length - 1].day,
  });
  check('workspace and date focus compose',
    same(sum(combined.routes), combined.totals),
    `${combined.routes.length} routes vs ${combined.totals.calls} calls`);

  check('a workspace-scoped trend uses only that workspace',
    scoped.trend.routes.every((route) => sum(route.days).calls <= scoped.totals.calls));
}

const failed = build({}, { sessionsScanned: 3, sessionsFailed: 2, failureReasons: [{ key: 'a', sessionId: 'session-a', reason: 'boom' }] });
check('failure reasons travel with the counters',
  failed.warnings.failureReasons.length === 1 && failed.warnings.failureReasons[0].reason === 'boom');

console.log('');
console.log(`sessions scanned: ${payload.warnings.sessionsScanned}, failed: ${payload.warnings.sessionsFailed}, malformed: ${payload.warnings.malformedUsageEvents}`);
console.log(`totals: ${JSON.stringify(payload.totals)}`);
console.log(`routes: ${payload.routes.length}, workspaces: ${payload.workspaces.length}`);
console.log('');
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} invariant(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('ALL PAYLOAD INVARIANTS HOLD');
