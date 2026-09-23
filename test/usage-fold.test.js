/**
 * Unit tests for the pure usage fold. Run with: `node --test`.
 *
 * Everything here is a pure function, so the test suite imports the module
 * directly without a Cordis runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPayload,
  bucket,
  cacheRateOf,
  emptyAggregate,
  enumerateDays,
  foldSessionIntoAggregate,
  localDayKey,
  shiftDay,
  totalOf,
  workspaceLabel,
} from '../usage-fold.js';

/** UTC, for arithmetic that is easy to reason about. */
const UTC = { tzOffsetMinutes: 0 };
/** UTC+8, the timezone most token-day boundary bugs show up in. */
const UTC_PLUS_8 = { tzOffsetMinutes: 480 };

/** Epoch ms of one UTC calendar instant. */
function at(year, month, day, hour = 12) {
  return Date.UTC(year, month - 1, day, hour, 0, 0);
}

/**
 * One `assistant/message` carrying a usage report.
 *
 * `time` is the field a persisted log actually uses; the in-memory `SessionEvent`
 * type documents `ts`. The fold accepts both, and the suite exercises both.
 */
function settlement(seq, ts, usage) {
  return {
    type: 'assistant/message',
    seq,
    time: ts,
    data: { turn: 1, step: seq, message: { role: 'assistant', content: [] }, stream: [], usage },
  };
}

/** One `request/header` naming the route for subsequent settlements. */
function header(seq, ts, provider, model) {
  return {
    type: 'request/header',
    seq,
    time: ts,
    data: { header: { config: { provider, model } }, reason: 'initial' },
  };
}

/** A usage report with every bucket present. */
function usage(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: inputTokens + outputTokens };
}

/** Fold one session's log from scratch against a fresh aggregate. */
function fold(log, options = UTC) {
  const aggregate = emptyAggregate();
  const folded = foldSessionIntoAggregate(
    aggregate,
    { events: log.events, inheritedEventCount: log.inheritedEventCount ?? 0, sessionId: log.sessionId ?? 'session-1', cwd: log.cwd ?? null },
    options,
  );
  return { aggregate, folded };
}

test('localDayKey buckets by the supplied local offset, not by UTC', () => {
  // The offset is read as east of UTC, the way the host and every verify script
  // supply it. 2026-03-05T23:30Z is still 2026-03-05 in UTC but already 2026-03-06
  // in UTC+8.
  const ts = Date.UTC(2026, 2, 5, 23, 30);
  assert.equal(localDayKey(ts, 0), '2026-03-05');
  assert.equal(localDayKey(ts, 480), '2026-03-06');
  // ... and 2026-03-05T00:30Z is still 2026-03-04 in UTC-5.
  const early = Date.UTC(2026, 2, 5, 0, 30);
  assert.equal(localDayKey(early, -300), '2026-03-04');
  // The rollover that zeroed "today" every afternoon in UTC+8: 15:00 local is the
  // same local day, not the one before it.
  assert.equal(localDayKey(Date.UTC(2026, 2, 5, 7, 0), 480), '2026-03-05');
  assert.equal(localDayKey(Date.UTC(2026, 2, 5, 16, 0), 480), '2026-03-06');
});

test('localDayKey rejects unusable timestamps', () => {
  assert.equal(localDayKey(Number.NaN, 0), null);
  assert.equal(localDayKey(undefined, 0), null);
  assert.equal(localDayKey('123', 0), null);
});

test('enumerateDays returns a dense inclusive ascending series', () => {
  assert.deepEqual(enumerateDays('2026-03-05', '2026-03-08'), [
    '2026-03-05',
    '2026-03-06',
    '2026-03-07',
    '2026-03-08',
  ]);
  assert.deepEqual(enumerateDays('2026-03-05', '2026-03-05'), ['2026-03-05']);
  // Reversed and unusable bounds yield an empty window rather than a throw.
  assert.deepEqual(enumerateDays('2026-03-08', '2026-03-05'), []);
  assert.deepEqual(enumerateDays('nope', '2026-03-05'), []);
  // A leap day is a real day.
  assert.equal(enumerateDays('2024-02-28', '2024-03-01').length, 3);
});

test('shiftDay crosses month and year boundaries', () => {
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDay('2026-02-28', 1), '2026-03-01');
  assert.equal(shiftDay('2024-02-28', 1), '2024-02-29');
});

test('a settlement accumulates into day, workspace, route, and totals', () => {
  const { aggregate, folded } = fold({
    cwd: 'D:\\code\\any-things',
    events: [
      header(0, at(2026, 3, 5), 'deepseek', 'deepseek-chat'),
      settlement(1, at(2026, 3, 5), usage(100, 20, 900, 5)),
    ],
  });

  assert.equal(folded, 1);
  assert.deepEqual(aggregate.byDay['2026-03-05'], {
    calls: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 900,
    cacheWriteTokens: 5,
  });
  assert.equal(totalOf(aggregate.totals), 1025);
  assert.equal(aggregate.totals.calls, 1);

  const route = aggregate.byRoute['deepseek\u0000deepseek-chat'];
  assert.equal(route.provider, 'deepseek');
  assert.equal(route.model, 'deepseek-chat');
  assert.equal(route.cacheReadTokens, 900);

  const workspace = aggregate.byWorkspace['D:\\code\\any-things'];
  assert.equal(workspace.label, 'any-things');
  assert.equal(workspace.firstDay, '2026-03-05');
  assert.equal(workspace.lastDay, '2026-03-05');
  assert.equal(totalOf(aggregate.byDayWorkspace['D:\\code\\any-things']['2026-03-05']), 1025);
});

test('events in the fork-inherited prefix are NOT counted twice', () => {
  // The parent session already contributed seq 0..2; the child log replays them
  // at the same seqs and only owns 3..4. Counting the prefix would double-charge
  // exactly the same tokens.
  const inherited = [
    header(0, at(2026, 3, 1), 'deepseek', 'deepseek-chat'),
    settlement(1, at(2026, 3, 1), usage(1000, 100, 4000, 0)),
    settlement(2, at(2026, 3, 2), usage(2000, 200, 8000, 0)),
  ];
  const owned = [settlement(3, at(2026, 3, 3), usage(50, 5, 300, 0))];

  const { aggregate, folded } = fold({
    inheritedEventCount: 3,
    events: [...inherited, ...owned],
  });

  assert.equal(folded, 1, 'only the child-owned settlement is folded');
  assert.equal(totalOf(aggregate.totals), 355);
  assert.equal(aggregate.byDay['2026-03-01'], undefined);
  assert.equal(aggregate.byDay['2026-03-02'], undefined);
  assert.equal(aggregate.byDay['2026-03-03'].cacheReadTokens, 300);
  // The pre-cut header still supplies the route for the child-owned settlement.
  assert.equal(aggregate.byRoute['deepseek\u0000deepseek-chat'].calls, 1);
});

test('a fallback request/context before the cut still names the child-owned route', () => {
  const context = {
    type: 'request/context',
    seq: 0,
    ts: at(2026, 3, 1),
    data: { provider: 'anthropic', model: 'claude-sonnet-4' },
  };
  const { aggregate } = fold({
    inheritedEventCount: 2,
    events: [context, settlement(2, at(2026, 3, 3), usage(10, 1, 0, 0))],
  });
  assert.equal(aggregate.byRoute['anthropic\u0000claude-sonnet-4'].calls, 1);
});

test('a settlement with no route attribution lands under unknown/unknown', () => {
  const { aggregate } = fold({ events: [settlement(1, at(2026, 3, 5), usage(10, 1, 0, 0))] });
  assert.equal(aggregate.byRoute['unknown\u0000unknown'].calls, 1);
});

test('the route follows the latest request/header, and request/context is only a fallback', () => {
  const { aggregate } = fold({
    events: [
      header(0, at(2026, 3, 5), 'deepseek', 'deepseek-chat'),
      settlement(1, at(2026, 3, 5), usage(10, 1, 0, 0)),
      header(2, at(2026, 3, 5), 'deepseek', 'deepseek-reasoner'),
      settlement(3, at(2026, 3, 5), usage(20, 2, 0, 0)),
    ],
  });

  assert.equal(aggregate.byRoute['deepseek\u0000deepseek-chat'].calls, 1);
  assert.equal(aggregate.byRoute['deepseek\u0000deepseek-reasoner'].calls, 1);
  assert.equal(aggregate.byRoute['unknown\u0000unknown'], undefined);
});

test('request/context supplies the route only when no header named one', () => {
  const context = {
    type: 'request/context',
    seq: 0,
    ts: at(2026, 3, 5),
    data: { provider: 'anthropic', model: 'claude-sonnet-4' },
  };
  const { aggregate } = fold({
    events: [context, settlement(1, at(2026, 3, 5), usage(10, 1, 0, 0))],
  });
  assert.equal(aggregate.byRoute['anthropic\u0000claude-sonnet-4'].calls, 1);
});

test('an assistant message without usage is never inferred into the totals', () => {
  const noUsage = {
    type: 'assistant/message',
    seq: 1,
    ts: at(2026, 3, 5),
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [] },
  };
  const attempt = {
    type: 'assistant/attempt',
    seq: 2,
    ts: at(2026, 3, 5),
    data: { turn: 1, step: 2, stream: [] },
  };
  const { aggregate, folded } = fold({ events: [noUsage, attempt] });

  assert.equal(folded, 0);
  assert.equal(aggregate.totals.calls, 0);
  assert.deepEqual(Object.keys(aggregate.byDay), []);
  assert.equal(aggregate.malformedUsageEvents, 0, 'a missing report is not malformed');
});

test('missing cache buckets read as zero, not as malformed', () => {
  const { aggregate } = fold({
    events: [settlement(1, at(2026, 3, 5), { inputTokens: 500, outputTokens: 40 })],
  });

  assert.equal(aggregate.byDay['2026-03-05'].cacheReadTokens, 0);
  assert.equal(aggregate.byDay['2026-03-05'].cacheWriteTokens, 0);
  assert.equal(aggregate.malformedUsageEvents, 0);
  assert.equal(totalOf(aggregate.totals), 540);
});

test('a malformed usage field is zeroed and counted without discarding the settlement', () => {
  const { aggregate, folded } = fold({
    events: [
      settlement(1, at(2026, 3, 5), {
        inputTokens: -5,
        outputTokens: Number.NaN,
        cacheReadTokens: '900',
        cacheWriteTokens: 7,
      }),
    ],
  });

  assert.equal(folded, 1, 'the settlement still counts');
  assert.equal(aggregate.malformedUsageEvents, 1);
  const day = aggregate.byDay['2026-03-05'];
  assert.equal(day.inputTokens, 0, 'a negative count is zeroed');
  assert.equal(day.outputTokens, 0, 'a non-finite count is zeroed');
  assert.equal(day.cacheReadTokens, 0, 'a non-numeric count is zeroed');
  assert.equal(day.cacheWriteTokens, 7, 'a valid sibling field survives');
});

test('an unusable event timestamp is counted as malformed and excluded', () => {
  const { aggregate, folded } = fold({
    events: [{ ...settlement(1, at(2026, 3, 5), usage(10, 1, 0, 0)), time: undefined }],
  });
  assert.equal(folded, 0);
  assert.equal(aggregate.malformedUsageEvents, 1);
});

test('a settlement carrying only the in-memory `ts` field is still dated', () => {
  const { aggregate, folded } = fold({
    events: [{ ...settlement(1, undefined, usage(10, 1, 0, 0)), ts: at(2026, 3, 5) }],
  });
  assert.equal(folded, 1);
  assert.equal(aggregate.byDay['2026-03-05'].inputTokens, 10);
  assert.equal(aggregate.malformedUsageEvents, 0);
});

test('the persisted `time` field wins over an in-memory `ts`', () => {
  const { aggregate } = fold({
    events: [{ ...settlement(1, at(2026, 3, 5), usage(10, 1, 0, 0)), ts: at(2026, 3, 9) }],
  });
  assert.equal(aggregate.byDay['2026-03-05'].inputTokens, 10);
  assert.equal(aggregate.byDay['2026-03-09'], undefined);
});

test('cacheRateOf returns null for no billed input and a ratio otherwise', () => {
  assert.equal(cacheRateOf(bucket()), null);
  assert.equal(cacheRateOf({ ...bucket(), outputTokens: 100 }), null, 'output alone offers no cache denominator');
  assert.equal(cacheRateOf({ ...bucket(), inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
  assert.equal(cacheRateOf({ ...bucket(), inputTokens: 100, cacheReadTokens: 900 }), 0.9);
  assert.equal(cacheRateOf({ ...bucket(), inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 100 }), 0);
  // Billed input is the sum of all three, so writes dilute the hit rate.
  assert.equal(cacheRateOf({ ...bucket(), inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 }), 0.6);
});

test('workspaceLabel falls back to the key for an absent cwd', () => {
  assert.equal(workspaceLabel('D:\\code\\any-things', 'k'), 'any-things');
  assert.equal(workspaceLabel('D:\\code\\any-things\\', 'k'), 'any-things');
  assert.equal(workspaceLabel('/home/dev/proj', 'k'), 'proj');
  assert.equal(workspaceLabel('proj', 'k'), 'proj');
  assert.equal(workspaceLabel(null, 'session-1'), 'session-1');
  assert.equal(workspaceLabel('/', '/'), '/');
});

test('a session without a cwd is keyed by its session id, not merged with others', () => {
  const first = fold({ sessionId: 'session-a', events: [settlement(1, at(2026, 3, 5), usage(10, 1, 0, 0))] });
  const second = fold({ sessionId: 'session-b', events: [settlement(1, at(2026, 3, 5), usage(10, 1, 0, 0))] });

  assert.deepEqual(Object.keys(first.aggregate.byWorkspace), ['session-a']);
  assert.deepEqual(Object.keys(second.aggregate.byWorkspace), ['session-b']);
});

test('buildPayload emits a dense day series with derived-friendly raw buckets', () => {
  const { aggregate } = fold({
    cwd: 'D:\\code\\any-things',
    events: [
      header(0, at(2026, 3, 5), 'deepseek', 'deepseek-chat'),
      settlement(1, at(2026, 3, 5), usage(100, 20, 900, 5)),
      settlement(2, at(2026, 3, 7), usage(10, 2, 30, 1)),
    ],
  });

  const payload = buildPayload(aggregate, {
    revision: 7,
    seeding: false,
    tzOffsetMinutes: 0,
    from: '2026-03-05',
    to: '2026-03-08',
    today: '2026-03-05',
    telemetry: { sessionsScanned: 3, sessionsFailed: 1 },
  });

  assert.equal(payload.version, 1);
  assert.equal(payload.revision, 7);
  assert.equal(payload.seeding, false);
  assert.equal(payload.days.length, 4, 'the window is dense');
  assert.deepEqual(payload.days.map((row) => row.day), ['2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']);

  const gap = payload.days[1];
  assert.deepEqual(gap, { day: '2026-03-06', ...bucket() }, 'a day with no usage is a zero row, not absent');

  assert.equal(payload.today.day, '2026-03-05');
  assert.equal(totalOf(payload.today), 1025);
  assert.equal(totalOf(payload.totals), 1068);
  assert.equal(payload.workspaces.length, 1);
  assert.equal(payload.workspaces[0].label, 'any-things');
  assert.equal(payload.routes.length, 1);
  assert.equal(payload.warnings.sessionsScanned, 3);
  assert.equal(payload.warnings.sessionsFailed, 1);
  assert.deepEqual(Object.keys(payload.workspaceDays), ['D:\\code\\any-things']);
  assert.equal(payload.workspaceDays['D:\\code\\any-things'].length, 2, 'only days with usage are emitted per workspace');
});

test('buildPayload orders routes by total tokens descending', () => {
  const { aggregate } = fold({
    events: [
      header(0, at(2026, 3, 5), 'deepseek', 'deepseek-chat'),
      settlement(1, at(2026, 3, 5), usage(10, 1, 0, 0)),
      header(2, at(2026, 3, 5), 'anthropic', 'claude-sonnet-4'),
      settlement(3, at(2026, 3, 5), usage(5000, 500, 0, 0)),
    ],
  });

  const payload = buildPayload(aggregate, {
    revision: 1,
    seeding: false,
    tzOffsetMinutes: 0,
    from: '2026-03-05',
    to: '2026-03-05',
    today: '2026-03-05',
    telemetry: { sessionsScanned: 1, sessionsFailed: 0 },
  });

  assert.deepEqual(payload.routes.map((row) => row.model), ['claude-sonnet-4', 'deepseek-chat']);
});

test('buildPayload is JSON-serializable', () => {
  const { aggregate } = fold({ events: [settlement(1, at(2026, 3, 5), usage(1, 2, 3, 4))] });
  const payload = buildPayload(aggregate, {
    revision: 1,
    seeding: false,
    tzOffsetMinutes: -480,
    from: '2026-03-05',
    to: '2026-03-05',
    today: '2026-03-05',
    telemetry: { sessionsScanned: 1, sessionsFailed: 0 },
  });
  assert.ok(JSON.stringify(payload).length > 0);
});

test('folding an empty log changes nothing', () => {
  const { aggregate, folded } = fold({ events: [] });
  assert.equal(folded, 0);
  assert.deepEqual(aggregate.totals, bucket());
  assert.equal(aggregate.minDay, null);
});

//#region focus semantics

/** Three days of one route in one workspace. */
function focusEvents() {
  return [
    header(0, at(2026, 3, 5), 'deepseek', 'deepseek-chat'),
    settlement(1, at(2026, 3, 5), usage(100, 10, 900, 0)),
    settlement(2, at(2026, 3, 6), usage(200, 20, 800, 0)),
    settlement(3, at(2026, 3, 7), usage(300, 30, 700, 0)),
  ];
}

/** Build one payload over the standard three-day window. */
function payloadOf(aggregate, focus) {
  return buildPayload(aggregate, {
    revision: 1,
    seeding: false,
    tzOffsetMinutes: 0,
    from: '2026-03-05',
    to: '2026-03-07',
    today: '2026-03-07',
    focus,
    telemetry: { sessionsScanned: 1, sessionsFailed: 0 },
  });
}

/** Fold one session per workspace into a fresh aggregate. */
function twoWorkspaceAggregate() {
  const aggregate = emptyAggregate();
  foldSessionIntoAggregate(aggregate, {
    events: focusEvents(),
    inheritedEventCount: 0,
    sessionId: 'session-b',
    cwd: '/proj/a',
  }, UTC);
  foldSessionIntoAggregate(aggregate, {
    events: [
      header(0, at(2026, 3, 5), 'anthropic', 'claude-sonnet-4'),
      settlement(1, at(2026, 3, 5), usage(5, 1, 4, 0)),
    ],
    inheritedEventCount: 0,
    sessionId: 'session-c',
    cwd: '/proj/b',
  }, UTC);
  return aggregate;
}

test('a day-range focus narrows the totals but keeps the whole heatmap window', () => {
  const { aggregate } = fold({ cwd: '/proj/a', events: focusEvents() });
  const full = payloadOf(aggregate, {});
  const focused = payloadOf(aggregate, { start: '2026-03-06', end: '2026-03-06' });

  assert.equal(totalOf(full.totals), 3060, 'all three days');
  assert.equal(totalOf(focused.totals), 1020, 'only March 6th');
  assert.equal(focused.totals.calls, 1);
  assert.equal(focused.days.length, full.days.length, 'the heatmap window is unchanged');
});

test('a day-range focus narrows routes and the trend together', () => {
  const { aggregate } = fold({ cwd: '/proj/a', events: focusEvents() });
  const focused = payloadOf(aggregate, { start: '2026-03-05', end: '2026-03-06' });

  assert.equal(focused.routes.reduce((sum, route) => sum + totalOf(route), 0), totalOf(focused.totals));
  assert.deepEqual(focused.trend.days, ['2026-03-05', '2026-03-06']);
  assert.equal(focused.trend.routes[0].days.length, 2, 'the route series matches the focused window');
});

test('a workspace focus lists only that workspace and narrows every figure', () => {
  const aggregate = twoWorkspaceAggregate();
  const full = payloadOf(aggregate, {});
  const scoped = payloadOf(aggregate, { workspace: '/proj/a' });

  assert.equal(full.workspaces.length, 2);
  assert.equal(scoped.workspaces.length, 1, 'only the focused workspace is listed');
  assert.equal(scoped.workspaces[0].key, '/proj/a');
  assert.equal(totalOf(scoped.totals), 3060, 'the other workspace is excluded');
  assert.deepEqual(scoped.routes.map((route) => route.model), ['deepseek-chat']);
});

test('workspace and date focus compose across routes, totals, and the trend', () => {
  const combined = payloadOf(twoWorkspaceAggregate(), {
    workspace: '/proj/a',
    start: '2026-03-06',
    end: '2026-03-07',
  });

  assert.equal(combined.totals.calls, 2, 'two days of the focused workspace');
  assert.equal(combined.routes.reduce((sum, route) => sum + totalOf(route), 0), totalOf(combined.totals),
    'the route breakdown matches the composed focus');
  assert.equal(combined.routes[0].days, undefined, 'route rows carry only totals');
  assert.equal(combined.trend.routes[0].days.length, 2, 'the workspace trend uses only its own days');
  assert.deepEqual(combined.trend.days, ['2026-03-06', '2026-03-07']);
});

test('a route that only ran outside the focus disappears from the breakdown', () => {
  const aggregate = emptyAggregate();
  foldSessionIntoAggregate(aggregate, {
    events: [
      header(0, at(2026, 3, 5), 'deepseek', 'deepseek-chat'),
      settlement(1, at(2026, 3, 5), usage(10, 1, 0, 0)),
      header(2, at(2026, 3, 6), 'anthropic', 'claude-sonnet-4'),
      settlement(3, at(2026, 3, 6), usage(20, 2, 0, 0)),
    ],
    inheritedEventCount: 0,
    sessionId: 's',
    cwd: '/proj/a',
  }, UTC);

  const dayFive = payloadOf(aggregate, { start: '2026-03-05', end: '2026-03-05' });
  assert.deepEqual(dayFive.routes.map((route) => route.model), ['deepseek-chat'],
    'a route with no tokens inside the focus is omitted, not shown as a zero row');
});

test('failure reasons travel with the counters', () => {
  const { aggregate } = fold({ events: [] });
  const payload = buildPayload(aggregate, {
    revision: 1,
    seeding: false,
    tzOffsetMinutes: 0,
    from: '2026-03-05',
    to: '2026-03-05',
    today: '2026-03-05',
    telemetry: {
      sessionsScanned: 4,
      sessionsFailed: 2,
      failureReasons: [{ key: 'k', sessionId: 'session-x', reason: 'read boom' }],
    },
  });
  assert.equal(payload.warnings.sessionsFailed, 2);
  assert.equal(payload.warnings.failureReasons[0].reason, 'read boom');
});

test('a payload without failure diagnostics still reports an empty list', () => {
  const { aggregate } = fold({ events: [] });
  const payload = payloadOf(aggregate, {});
  assert.deepEqual(payload.warnings.failureReasons, []);
  assert.equal(payload.focus.workspace, null);
});

//#endregion

test('foldSessionIntoAggregate accumulates across calls (live incremental feed)', () => {
  const aggregate = emptyAggregate();
  const dayOne = { events: [settlement(5, at(2026, 3, 5), usage(10, 1, 90, 0))], inheritedEventCount: 0, sessionId: 's' };
  const dayTwo = { events: [settlement(6, at(2026, 3, 6), usage(20, 2, 80, 0))], inheritedEventCount: 0, sessionId: 's' };

  foldSessionIntoAggregate(aggregate, dayOne, UTC);
  foldSessionIntoAggregate(aggregate, dayTwo, UTC);

  assert.equal(aggregate.totals.calls, 2, 'a late event is added, not replacing the earlier fold');
  assert.equal(totalOf(aggregate.totals), 203);
  assert.equal(aggregate.byDay['2026-03-05'].cacheReadTokens, 90);
  assert.equal(aggregate.byDay['2026-03-06'].cacheReadTokens, 80);
});

test('day bucketing uses the supplied offset consistently across a fold', () => {
  // 02:00Z is 10:00 on 03-05 in UTC+8; 17:00Z the same UTC day is already 01:00 on 03-06.
  const { aggregate } = fold(
    {
      events: [
        settlement(1, Date.UTC(2026, 2, 5, 2, 0), usage(10, 1, 0, 0)),
        settlement(2, Date.UTC(2026, 2, 5, 17, 0), usage(20, 2, 0, 0)),
      ],
    },
    UTC_PLUS_8,
  );

  assert.deepEqual(Object.keys(aggregate.byDay).sort(), ['2026-03-05', '2026-03-06']);
  assert.equal(aggregate.byDay['2026-03-05'].inputTokens, 10);
  assert.equal(aggregate.byDay['2026-03-06'].inputTokens, 20);
});

test('the heatmap window spans a year while the trend starts at the corpus', () => {
  // The regression this pins: the heatmap wants a full year so sparse activity
  // stays in context, but the per-model views must not be padded out to it — a
  // young corpus would otherwise plot months of empty columns under "all".
  const { aggregate } = fold({ events: [
    settlement(1, at(2026, 3, 5), usage(10, 1, 0, 0)),
    settlement(2, at(2026, 3, 6), usage(20, 2, 0, 0)),
  ] });
  const payload = buildPayload(aggregate, {
    revision: 1,
    seeding: false,
    tzOffsetMinutes: 0,
    from: '2026-01-01',
    to: '2026-03-07',
    today: '2026-03-07',
    telemetry: { sessionsScanned: 1, sessionsFailed: 0 },
  });

  assert.equal(payload.days.length, 66, 'the heatmap window is served whole');
  assert.equal(payload.days[0].day, '2026-01-01', 'the heatmap still starts at the window edge');
  // The corpus starts 03-05, so the per-model window starts there — not at 01-01.
  assert.deepEqual(payload.trend.days, ['2026-03-05', '2026-03-06', '2026-03-07']);
  assert.equal(
    payload.trend.routes[0].days.length,
    2,
    'a route series carries only the days it actually billed',
  );
});

test('an empty corpus leaves the per-model window empty rather than inventing days', () => {
  const payload = buildPayload(emptyAggregate(), {
    revision: 1,
    seeding: false,
    tzOffsetMinutes: 0,
    from: '2026-01-01',
    to: '2026-03-07',
    today: '2026-03-07',
    telemetry: { sessionsScanned: 0, sessionsFailed: 0 },
  });
  assert.equal(payload.days.length, 66, 'the heatmap window is still served');
  assert.deepEqual(payload.trend.days, [], 'no corpus days means no trend window');
  assert.deepEqual(payload.routes, [], 'and no routes');
});
