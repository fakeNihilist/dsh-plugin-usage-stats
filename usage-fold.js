/**
 * Pure fold layer for whole-corpus token usage.
 *
 * This module has NO Cordis, Node, or browser dependency: the Host half calls it
 * for both the cold backfill and the live incremental feed, and the test suite
 * imports it directly with `node --test`.
 *
 * Source of truth: every `'assistant/message'` session event carries the
 * provider-reported `usage` for its one settlement
 * (`dsh-session/lib/types/types.d.ts`). There is no separate usage record, so
 * exactly one counted event feeds each accumulation. Events without `usage` are
 * never inferred or estimated — `ctx.tokenMeter` heuristics are deliberately NOT
 * used here.
 *
 * `TokenUsage` buckets are disjoint: `inputTokens` is uncached input only, and
 * cached input is reported separately as `cacheReadTokens`/`cacheWriteTokens`.
 * Billed input is therefore the SUM of all three.
 *
 * @module dsh-plugin-usage-stats/usage-fold
 */

/** Provider/model label used when a settlement carries no route attribution. */
export const UNKNOWN_ROUTE = 'unknown';

/** Maximum days one payload may span, to keep a hostile query bounded. */
export const MAX_WINDOW_DAYS = 20_000;

/** Zeroed buckets. */
export function bucket() {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** Create an empty aggregate. */
export function emptyAggregate() {
  return {
    byDay: {},
    byDayWorkspace: {},
    byDayRoute: {},
    byWorkspace: {},
    byWorkspaceRoute: {},
    byWorkspaceRouteDay: {},
    byRoute: {},
    totals: bucket(),
    minDay: null,
    malformedUsageEvents: 0,
  };
}

/** Add `from` into `into`, mutating `into`. */
function addInto(into, from) {
  into.calls += from.calls;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
}

/** Billed input plus output: every token the provider charged for. */
export function totalOf(buckets) {
  return buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/**
 * Cache hit rate over billed input, or null when no input was reported.
 * `null` (not 0) keeps "no cache was offered" distinguishable from "cache missed".
 * @param {object} buckets - one bucket set.
 * @returns {number|null} a ratio in [0, 1], or null.
 */
export function cacheRateOf(buckets) {
  const input = buckets.inputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
  if (input <= 0) return null;
  return buckets.cacheReadTokens / input;
}

/** Zero-pad to two digits. */
function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

/** Zero-pad to four digits. */
function pad4(value) {
  return String(value).padStart(4, '0');
}

/**
 * Local calendar date of one Unix epoch millisecond timestamp.
 *
 * `tzOffsetMinutes` is the offset **east of UTC** (`-getTimezoneOffset()`), so
 * local wall-clock time is the UTC instant plus the offset. The host, the verify
 * scripts, and the render tests all read `-getTimezoneOffset()`; subtracting here
 * instead of adding shifted every day boundary by twice the offset — in UTC+8 the
 * day rolled over at 16:00 local, so "today" zeroed out every afternoon.
 * @param {number} ts - Unix epoch milliseconds.
 * @param {number} tzOffsetMinutes - local offset in minutes east of UTC.
 * @returns {string|null} `YYYY-MM-DD`, or null when the timestamp is unusable.
 */
export function localDayKey(ts, tzOffsetMinutes) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  const shifted = new Date(ts + tzOffsetMinutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

/** Absolute day number of a `YYYY-MM-DD` key, or null when unusable. */
function dayIndex(day) {
  if (typeof day !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (month < 1 || month > 12 || date < 1 || date > 31) return null;
  const ms = Date.UTC(year, month - 1, date);
  const value = Math.floor(ms / 86_400_000);
  return Number.isFinite(value) ? value : null;
}

/** `YYYY-MM-DD` of an absolute day number. */
function dayFromIndex(index) {
  const date = new Date(index * 86_400_000);
  return `${pad4(date.getUTCFullYear())}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Shift one day key by a signed number of days. */
export function shiftDay(day, delta) {
  const index = dayIndex(day);
  if (index === null) return day;
  return dayFromIndex(index + delta);
}

/**
 * Every local day from `from` through `to` inclusive, ascending.
 * @param {string} from - `YYYY-MM-DD`.
 * @param {string} to - `YYYY-MM-DD`.
 * @returns {string[]} the contiguous day keys; empty when a bound is unusable or reversed.
 */
export function enumerateDays(from, to) {
  const start = dayIndex(from);
  const end = dayIndex(to);
  if (start === null || end === null || end < start) return [];
  if (end - start > MAX_WINDOW_DAYS) return [];
  const days = [];
  for (let index = start; index <= end; index += 1) {
    days.push(dayFromIndex(index));
  }
  return days;
}

/** Human label for one workspace path. */
export function workspaceLabel(cwd, key) {
  if (typeof cwd !== 'string' || cwd.length === 0) return key;
  const normalized = cwd.replace(/[\\/]+$/, '');
  // A root path normalizes to '', which is a real label ('/' or 'C:\') rather than an empty one.
  if (normalized.length === 0) return cwd;
  const segments = normalized.split(/[\\/]/);
  const last = segments[segments.length - 1];
  return last !== undefined && last.length > 0 ? last : normalized;
}

/**
 * Read one non-negative finite token count, treating anything else as 0 so one
 * malformed adapter report cannot poison a whole aggregate.
 * @param {unknown} value - the raw field.
 * @returns {{ value: number, malformed: boolean }} the sanitized count.
 */
function token(value) {
  if (value === undefined || value === null) return { value: 0, malformed: false };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { value: 0, malformed: true };
  }
  return { value, malformed: false };
}

/** Get or create the daily bucket record for one workspace key. */
function daySeriesFor(aggregate, workspaceKey) {
  let series = aggregate.byDayWorkspace[workspaceKey];
  if (series === undefined) {
    series = {};
    aggregate.byDayWorkspace[workspaceKey] = series;
  }
  return series;
}

/** Get or create the whole-corpus record for one workspace key. */
function workspaceRowFor(aggregate, workspaceKey, cwd) {
  let row = aggregate.byWorkspace[workspaceKey];
  if (row === undefined) {
    row = {
      ...bucket(),
      key: workspaceKey,
      cwd,
      label: workspaceLabel(cwd, workspaceKey),
      firstDay: null,
      lastDay: null,
    };
    aggregate.byWorkspace[workspaceKey] = row;
  }
  return row;
}

/** Get or create the whole-corpus record for one provider/model route. */
function routeRowFor(aggregate, provider, model) {
  const key = `${provider}\u0000${model}`;
  let row = aggregate.byRoute[key];
  if (row === undefined) {
    row = { ...bucket(), provider, model };
    aggregate.byRoute[key] = row;
  }
  return row;
}

/** Get or create one day's record for one provider/model route. */
function dayRouteRowFor(aggregate, day, provider, model) {
  let byRoute = aggregate.byDayRoute[day];
  if (byRoute === undefined) {
    byRoute = {};
    aggregate.byDayRoute[day] = byRoute;
  }
  const key = `${provider}\u0000${model}`;
  let row = byRoute[key];
  if (row === undefined) {
    row = bucket();
    byRoute[key] = row;
  }
  return row;
}

/** Get or create the whole-corpus record for one workspace/route pair. */
function workspaceRouteRowFor(aggregate, workspaceKey, provider, model) {
  let byRoute = aggregate.byWorkspaceRoute[workspaceKey];
  if (byRoute === undefined) {
    byRoute = {};
    aggregate.byWorkspaceRoute[workspaceKey] = byRoute;
  }
  const key = `${provider}\u0000${model}`;
  let row = byRoute[key];
  if (row === undefined) {
    row = { ...bucket(), provider, model };
    byRoute[key] = row;
  }
  return row;
}

/**
 * Get or create the record for one workspace/route/day triple.
 *
 * The panel needs the whole corpus sliced THREE ways at once: the route donut
 * while a workspace and a day range are both selected. Route totals are not
 * derivable from a workspace-filtered day series, so the intersection is folded
 * directly rather than approximated.
 */
function workspaceRouteDayRowFor(aggregate, workspaceKey, day, provider, model) {
  let byDay = aggregate.byWorkspaceRouteDay[workspaceKey];
  if (byDay === undefined) {
    byDay = {};
    aggregate.byWorkspaceRouteDay[workspaceKey] = byDay;
  }
  let byRoute = byDay[day];
  if (byRoute === undefined) {
    byRoute = {};
    byDay[day] = byRoute;
  }
  const key = `${provider}\u0000${model}`;
  let row = byRoute[key];
  if (row === undefined) {
    row = bucket();
    byRoute[key] = row;
  }
  return row;
}

/**
 * Read `provider`/`model` off a route-carrying event.
 *
 * `'request/header'` nests the call config at `data.header.config`; a
 * `'request/context'` event carries the fields directly. Both shapes are
 * accepted because the durable logs in the field may be either.
 * @param {object} data - the event's `data`.
 * @returns {{ provider: string, model: string }|null} the route, or null when neither field is present.
 */
function routeOf(data) {
  if (typeof data !== 'object' || data === null) return null;
  const header = data.header;
  const nested = header !== undefined && header !== null && typeof header === 'object' ? header.config : undefined;
  let source = data;
  if (nested !== undefined && nested !== null && typeof nested === 'object') {
    source = nested;
  } else if (data.config !== undefined && data.config !== null && typeof data.config === 'object') {
    source = data.config;
  }
  const provider = source.provider;
  const model = source.model;
  if (typeof provider !== 'string' && typeof model !== 'string') return null;
  return {
    provider: typeof provider === 'string' && provider.length > 0 ? provider : UNKNOWN_ROUTE,
    model: typeof model === 'string' && model.length > 0 ? model : UNKNOWN_ROUTE,
  };
}

/**
 * Read one event's timestamp from the fields a durable log may use.
 *
 * A persisted record spells the field `time`; the in-memory `SessionEvent` type
 * documents `ts`. Both are accepted so one fold serves the backfill and the live
 * feed without a translation step.
 * @param {object} raw - one session event.
 * @returns {number} Unix epoch milliseconds, or NaN when neither field is usable.
 */
function eventTimeOf(raw) {
  const time = raw.time;
  if (typeof time === 'number' && Number.isFinite(time)) return time;
  const ts = raw.ts;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  return Number.NaN;
}

/**
 * Build one settlement's buckets from a `usage` object.
 * @param {object} usage - the provider-reported usage.
 * @returns {{ buckets: object, malformed: boolean }}
 */
function bucketsFromUsage(usage) {
  const input = token(usage.inputTokens);
  const output = token(usage.outputTokens);
  const cacheRead = token(usage.cacheReadTokens);
  const cacheWrite = token(usage.cacheWriteTokens);
  return {
    buckets: {
      calls: 1,
      inputTokens: input.value,
      outputTokens: output.value,
      cacheReadTokens: cacheRead.value,
      cacheWriteTokens: cacheWrite.value,
    },
    malformed: input.malformed || output.malformed || cacheRead.malformed || cacheWrite.malformed,
  };
}

/**
 * Fold one session's events into an aggregate, IN PLACE.
 *
 * Settlements at or before the inherited cut are skipped: they are the
 * fork-inherited prefix the parent session already contributed, so counting them
 * would double-count the very same tokens. This is the single most important
 * rule here.
 *
 * Route events (`request/header`, `request/context`) are read regardless of the
 * cut. They carry no tokens, and the cut can land directly after one: a replayed
 * `request/header` is what names the model for the child's own first settlement.
 *
 * @param {object} aggregate - the aggregate to mutate.
 * @param {{ events: readonly unknown[], inheritedEventCount: number, sessionId: string, cwd?: string|null }} input
 *   one session's complete raw log plus its inherited prefix length.
 * @param {{ tzOffsetMinutes: number }} options - local timezone offset.
 * @returns {number} the number of settlements folded from this session.
 */
export function foldSessionIntoAggregate(aggregate, input, options) {
  const rawCut = input.inheritedEventCount;
  const cut = typeof rawCut === 'number' && Number.isFinite(rawCut) && rawCut > 0 ? rawCut : 0;
  const cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : null;
  const workspaceKey = cwd !== null ? cwd : input.sessionId;

  // `request/context` is only a fallback for a log whose header rides elsewhere.
  let headerRoute = null;
  let contextRoute = null;
  let folded = 0;

  for (const raw of input.events) {
    if (typeof raw !== 'object' || raw === null) continue;
    const seq = raw.seq;

    if (raw.type === 'request/header') {
      const route = routeOf(raw.data);
      if (route !== null) {
        headerRoute = route;
        contextRoute = null;
      }
      continue;
    }

    if (raw.type === 'request/context') {
      const route = routeOf(raw.data);
      if (route !== null && contextRoute === null) contextRoute = route;
      continue;
    }

    if (raw.type !== 'assistant/message') continue;
    if (typeof seq === 'number' && seq < cut) continue;
    if (typeof raw.data !== 'object' || raw.data === null) continue;

    const usage = raw.data.usage;
    // No adapter report means nothing to count; never infer one.
    if (typeof usage !== 'object' || usage === null) continue;

    const parsed = bucketsFromUsage(usage);
    if (parsed.malformed) aggregate.malformedUsageEvents += 1;

    const day = localDayKey(eventTimeOf(raw), options.tzOffsetMinutes);
    if (day === null) {
      aggregate.malformedUsageEvents += 1;
      continue;
    }

    const buckets = parsed.buckets;
    const route = headerRoute ?? contextRoute ?? { provider: UNKNOWN_ROUTE, model: UNKNOWN_ROUTE };

    let dayRow = aggregate.byDay[day];
    if (dayRow === undefined) {
      dayRow = bucket();
      aggregate.byDay[day] = dayRow;
    }
    addInto(dayRow, buckets);

    const series = daySeriesFor(aggregate, workspaceKey);
    let workspaceDayRow = series[day];
    if (workspaceDayRow === undefined) {
      workspaceDayRow = bucket();
      series[day] = workspaceDayRow;
    }
    addInto(workspaceDayRow, buckets);

    const workspaceRow = workspaceRowFor(aggregate, workspaceKey, cwd);
    addInto(workspaceRow, buckets);
    if (workspaceRow.firstDay === null || day < workspaceRow.firstDay) workspaceRow.firstDay = day;
    if (workspaceRow.lastDay === null || day > workspaceRow.lastDay) workspaceRow.lastDay = day;

    addInto(routeRowFor(aggregate, route.provider, route.model), buckets);
    addInto(dayRouteRowFor(aggregate, day, route.provider, route.model), buckets);
    addInto(workspaceRouteRowFor(aggregate, workspaceKey, route.provider, route.model), buckets);
    addInto(workspaceRouteDayRowFor(aggregate, workspaceKey, day, route.provider, route.model), buckets);
    addInto(aggregate.totals, buckets);
    if (aggregate.minDay === null || day < aggregate.minDay) aggregate.minDay = day;
    folded += 1;
  }

  return folded;
}

/**
 * Project the aggregate into the wire payload the client renders.
 *
 * Only raw provider-reported buckets travel; every rate and total is derived in
 * the browser so a single formula governs the whole UI. `days` is emitted as a
 * dense ascending series over `[from, to]` so the heatmap needs no gap filling.
 *
 * `focus` narrows the WHOLE payload — workspace, route breakdown, totals, and
 * trend — to one workspace and/or one day range. That is what makes every headline
 * figure follow the same filter the user selected, instead of mixing a filtered
 * chart with unfiltered totals.
 *
 * @param {object} aggregate - the folded aggregate.
 * @param {{ revision: number, seeding: boolean, tzOffsetMinutes: number, from: string, to: string, today: string,
 *           focus?: { workspace?: string|null, start?: string|null, end?: string|null },
 *           telemetry: { sessionsScanned: number, sessionsFailed: number, failureReasons?: string[] } }} options
 * @returns {object} the JSON-safe payload.
 */
export function buildPayload(aggregate, options) {
  const window = enumerateDays(options.from, options.to);
  const focus = options.focus ?? {};
  const workspace = typeof focus.workspace === 'string' && focus.workspace.length > 0 ? focus.workspace : null;
  const start = typeof focus.start === 'string' && focus.start.length > 0 ? focus.start : null;
  const end = typeof focus.end === 'string' && focus.end.length > 0 ? focus.end : null;

  /** Read one day's unfiltered buckets for the focused workspace (or the corpus). */
  const dayRowOf = (day) => {
    if (workspace === null) return aggregate.byDay[day];
    return aggregate.byDayWorkspace[workspace]?.[day];
  };

  // The heatmap keeps the unfiltered window so the selected range stays in
  // context; the intensity ramp narrows to the focused slice client-side.
  const days = window.map((day) => ({ day, ...(dayRowOf(day) ?? bucket()) }));

  /** Every day bucket inside the focus, ascending. */
  const focused = [];
  for (const day of window) {
    if (start !== null && day < start) continue;
    if (end !== null && day > end) continue;
    focused.push({ day, ...(dayRowOf(day) ?? bucket()) });
  }

  const focusedTotals = focused.reduce((accumulator, row) => {
    accumulator.calls += row.calls;
    accumulator.inputTokens += row.inputTokens;
    accumulator.outputTokens += row.outputTokens;
    accumulator.cacheReadTokens += row.cacheReadTokens;
    accumulator.cacheWriteTokens += row.cacheWriteTokens;
    return accumulator;
  }, bucket());

  // Route rows for the focused slice, so the donut and the table agree with the
  // headline figures. Both filter dimensions are applied: a workspace-only view
  // reads its whole-corpus/route fold, and a date range narrows it through the
  // workspace/route/day intersection.
  const routeSource = workspace === null ? aggregate.byRoute : (aggregate.byWorkspaceRoute[workspace] ?? {});
  const rangeIsFull = focused.length === window.length;
  const routes = Object.values(routeSource)
    .map((row) => ({ ...row }))
    .map((row) => {
      if (rangeIsFull) return row;
      const key = `${row.provider}\u0000${row.model}`;
      const accumulated = bucket();
      for (const dayRow of focused) {
        const match = workspace === null
          ? aggregate.byDayRoute[dayRow.day]?.[key]
          : aggregate.byWorkspaceRouteDay[workspace]?.[dayRow.day]?.[key];
        if (match !== undefined) addInto(accumulated, match);
      }
      return { ...accumulated, provider: row.provider, model: row.model };
    })
    .filter((row) => totalOf(row) > 0)
    .sort((left, right) => totalOf(right) - totalOf(left));

  // Per-route per-day series over the focused window, for the trend chart.
  const trendRoutes = routes.map((row) => {
    const key = `${row.provider}\u0000${row.model}`;
    const series = [];
    for (const dayRow of focused) {
      const match = workspace === null
        ? aggregate.byDayRoute[dayRow.day]?.[key]
        : aggregate.byWorkspaceRouteDay[workspace]?.[dayRow.day]?.[key];
      if (match === undefined) continue;
      series.push({ day: dayRow.day, ...match });
    }
    return { provider: row.provider, model: row.model, days: series };
  });

  // The per-model views (trend, ring, breakdown) read their own window from here,
  // and it starts where the data starts rather than at the heatmap window's leading
  // edge. The heatmap deliberately spans a year so sparse activity stays in
  // context; the per-model views must not pad a young corpus out to that year, or
  // "all" would plot months of empty columns. An older-than-a-year corpus keeps its
  // full span in both, because the route widens the window to the corpus start.
  // `byDay` keys only exist for days that billed something, so the earliest key is
  // the corpus start and the day before it is where the per-model window begins
  // (the start day itself is inside the corpus). An empty corpus has no keys and no
  // per-model window at all — the trend reads it as "nothing to plot" rather than
  // as a year of empty columns.
  const corpusDays = Object.keys(aggregate.byDay).sort();
  const focusedKeys = new Set(focused.map((row) => row.day));
  const trendDays = start === null && end === null
    ? (corpusDays.length === 0 ? [] : window.filter((day) => day >= corpusDays[0]))
    : window.filter((day) => focusedKeys.has(day));

  const todayRow = dayRowOf(options.today);

  const workspaceDays = {};
  for (const key of Object.keys(aggregate.byDayWorkspace)) {
    const series = aggregate.byDayWorkspace[key];
    const projected = [];
    for (const day of window) {
      const row = series !== undefined ? series[day] : undefined;
      if (row === undefined) continue;
      projected.push({ day, ...row });
    }
    workspaceDays[key] = projected;
  }

  return {
    version: 1,
    revision: options.revision,
    generatedAt: new Date().toISOString(),
    tzOffsetMinutes: options.tzOffsetMinutes,
    from: options.from,
    to: options.to,
    focus: { workspace, start: focus.start ?? null, end: focus.end ?? null },
    seeding: options.seeding,
    // A workspace-focused payload lists only that workspace, so the selector and
    // any consumer of this field agree with the figures above it.
    workspaces: Object.values(aggregate.byWorkspace)
      .filter((row) => workspace === null || row.key === workspace)
      .map((row) => ({ key: row.key, label: row.label, cwd: row.cwd }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    totals: focusedTotals,
    today: { day: options.today, ...(todayRow !== undefined ? todayRow : bucket()) },
    days,
    workspaceDays,
    routes,
    trend: { days: trendDays, routes: trendRoutes },
    warnings: {
      malformedUsageEvents: aggregate.malformedUsageEvents,
      sessionsScanned: options.telemetry.sessionsScanned,
      sessionsFailed: options.telemetry.sessionsFailed,
      recoveredSessions: options.telemetry.recovered ?? 0,
      failureReasons: options.telemetry.failureReasons ?? [],
    },
  };
}
