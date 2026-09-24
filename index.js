/**
 * Host half of the usage-statistics plugin.
 *
 * Folds provider-reported token usage out of the durable session corpus and
 * serves it to the plugin's own browser half over one authenticated Fetch route.
 *
 * Why an HTTP route instead of a Remote namespace: the Client's `ctx.remote.*`
 * namespaces are a build-time fixed set assembled by `dsh-api-remotes/client`,
 * which an installed bundle cannot extend. An exact Fetch route on the shared
 * `/api` channel is the documented seam for exactly this case, and
 * `dsh-session-log-export` is the reference consumer.
 *
 * Nothing here is model-visible: the plugin registers no tool and contributes no
 * prompt, so it cannot affect the model request or its KV cache.
 *
 * @module dsh-plugin-usage-stats
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import {
  buildPayload,
  emptyAggregate,
  enumerateDays,
  foldSessionIntoAggregate,
  localDayKey,
  shiftDay,
} from './usage-fold.js';

/** Cordis plugin name. */
export const name = 'usage-stats';

/**
 * Services this plugin needs. `sessionQuery` reads the whole historical corpus;
 * `connection` owns the `/api` channel the browser half fetches from.
 */
export const inject = ['connection', 'sessionQuery'];

/** Exact Fetch route path, absolute below the `/api` channel. */
export const DATA_PATH = '/api/usage-statistics.data';

/**
 * Default heatmap window: a full year plus the current partial month.
 *
 * This is the *heatmap's* span. The per-model views get their own window from
 * `buildPayload` (the corpus's own span inside this one), so a young corpus is not
 * padded out to a year of empty columns there.
 */
const DEFAULT_WINDOW_DAYS = 371;

/** Sessions folded per backfill batch, balancing latency against I/O churn. */
const BACKFILL_BATCH_SIZE = 8;

/** Bounded number of distinct failure causes retained for the field diagnostic. */
const FAILURE_REASON_LIMIT = 20;

/** Live-fold errors echoed to the Host console before going quiet. */
const LIVE_FOLD_ERROR_LIMIT = 3;

/**
 * Module-level ledger of one server process.
 *
 * Kept per process rather than per fiber so an HMR re-activation does not lose
 * the folded corpus; the aggregate is derived purely from durable logs, so a
 * process restart simply rebuilds it.
 */
const ledger = {
  aggregate: emptyAggregate(),
  revision: 0,
  /**
   * Highest session seq already folded, per session id.
   *
   * Absence means this session has contributed nothing yet: either the corpus pass
   * still owns it, or no enumeration has run to decide who does, or it is simply
   * new and the live feed has not adopted it.
   */
  sessionCursor: new Map(),
  /** Last known route per session, so an incremental fold keeps model attribution. */
  sessionRoute: new Map(),
  /**
   * Sessions the persistence service can never read, mapped to a short reason.
   *
   * Without this set the backfill re-attempts them on every request: a handful of
   * unreadable legacy artifacts made the failure counter climb on each poll
   * forever rather than describing a fixed number of problems.
   */
  unreadable: new Map(),
  /**
   * Session ids the corpus pass listed, so the two contributors can partition the
   * corpus between them instead of racing over it.
   *
   * A listed session's history belongs to the pass — it reads the whole log, so a
   * live event for it must stay out of the aggregate until the cursor the pass
   * leaves behind takes over. A session the pass never listed has no other
   * contributor at all, and that is every conversation started while the server is
   * up: nothing else can ever count it.
   */
  corpus: new Set(),
  /** Set once the corpus has been enumerated, so backfill is a one-time job. */
  seeded: false,
  seeding: false,
  backfill: null,
  /** Live-fold errors, kept separate from session read failures. */
  liveFoldErrors: 0,
  telemetry: { sessionsScanned: 0, sessionsFailed: 0, recovered: 0, failureReasons: [] },
  tzOffsetMinutes: 0,
};

/** Local timezone offset in minutes **east of UTC**, captured once per process. */
function localOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

/**
 * The first day a payload's window should cover.
 *
 * The requested span is the heatmap's year; it is a floor rather than a cap, so an
 * older corpus widens the window back to its own start instead of being truncated.
 * That matters because the per-model views read the same series: a model that ran
 * eighteen months ago has to stay listable, and it can only be reached if the
 * window still contains its days.
 *
 * The widened span is probed against the payload builder's own window limit rather
 * than restating it, so the two can never drift apart. That bound guards against a
 * single malformed timestamp (a year-0001 event, say): an over-long span would not
 * merely shorten the window, it would empty the whole payload.
 * @param {string|undefined} earliest - first day present in the aggregate, if any.
 * @param {string} requestedStart - `today - (days - 1)`, the requested span's start.
 * @param {string} today - the current local day.
 * @returns {string} the day the window should start on.
 */
export function windowStartFor(earliest, requestedStart, today) {
  if (typeof earliest !== 'string' || earliest.length === 0) return requestedStart;
  // Only ever widen: a future-dated event (clock skew) must not pull the start
  // forward past the requested span, or the heatmap would lose its recent days.
  if (earliest >= requestedStart) return requestedStart;
  // An unusable (absurdly long) span keeps the requested window rather than
  // handing `buildPayload` a range it would refuse to enumerate.
  return enumerateDays(earliest, today).length > 0 ? earliest : requestedStart;
}

/** Today's local calendar date. */
function todayKey() {
  const now = Date.now();
  return localDayKey(now, ledger.tzOffsetMinutes) ?? '1970-01-01';
}

/**
 * Exact count of fork-inherited leading events for one session log.
 *
 * Getting this wrong double-counts a fork parent's tokens, so it is computed
 * rather than assumed. A persisted JSONL header only records
 * `inheritedEventCount` for a seeded session (see the backend's
 * `toHeaderLine`), while the service reports 0 for every other session, so the
 * reported value is used ONLY when the header says the log is seeded. The
 * session-owned tagged marker sits exactly at the cut and is the best evidence
 * available; a seeded log missing its marker falls back to the reported value.
 *
 * Note that an UNTAGGED `session/end-seed` marker is a lifecycle boundary that
 * most ordinary sessions carry, so it must never be treated as a cut.
 *
 * @param {readonly unknown[]} events - the complete raw log.
 * @param {number} reported - `inheritedEventCount` from the session snapshot.
 * @param {boolean} isSeeded - whether the session header declares fork lineage.
 * @returns {number} the number of leading events to skip.
 */
export function inheritedCut(events, reported, isSeeded) {
  if (isSeeded !== true) return 0;
  let tagged = -1;
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue;
    if (raw.type !== 'session/end-seed') continue;
    if (raw.data !== undefined && raw.data !== null && raw.data.inherited === true) tagged = raw.seq;
  }
  if (typeof tagged === 'number' && tagged >= 0) return tagged + 1;
  return typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : 0;
}

/**
 * Fold one session's log, advancing its cursor.
 *
 * Sessions are re-read on the first backfill pass and never re-folded
 * event-by-event afterwards, so `cursor` carries the resume point. Route
 * attribution is seeded from `sessionRoute` because a pre-cut
 * `request/header` is the only thing naming the model for the next settlement.
 *
 * @param {{ id: string, cwd?: string | null, isSeeded?: boolean }} session - identity, workspace, fork lineage.
 * @param {readonly unknown[]} events - its complete raw log.
 * @param {number} reportedInherited - the snapshot's `inheritedEventCount`.
 */
function foldSession(session, events, reportedInherited) {
  const cut = inheritedCut(events, reportedInherited, session.isSeeded);
  const lastIndexed = ledger.sessionCursor.get(session.id);
  if (lastIndexed !== undefined) {
    const tail = [];
    let lastHeader = null;
    for (const raw of events) {
      if (typeof raw !== 'object' || raw === null) continue;
      const seq = raw.seq;
      if (typeof seq === 'number' && seq <= lastIndexed) {
        // Remember a pre-cursor route event so new settlements keep their model.
        if (raw.type === 'request/header' || raw.type === 'request/context') lastHeader = raw;
        continue;
      }
      if (lastHeader !== null) {
        tail.push(lastHeader);
        lastHeader = null;
      }
      tail.push(raw);
    }
    if (tail.length === 0) return;
    foldSessionIntoAggregate(
      ledger.aggregate,
      { events: tail, inheritedEventCount: 0, sessionId: session.id, cwd: session.cwd ?? null },
      { tzOffsetMinutes: ledger.tzOffsetMinutes },
    );
  } else {
    foldSessionIntoAggregate(
      ledger.aggregate,
      { events, inheritedEventCount: cut, sessionId: session.id, cwd: session.cwd ?? null },
      { tzOffsetMinutes: ledger.tzOffsetMinutes },
    );
  }

  let highest = lastIndexed ?? -1;
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue;
    const seq = raw.seq;
    if (typeof seq === 'number' && seq > highest) highest = seq;
  }
  ledger.sessionCursor.set(session.id, highest);
}

/**
 * Condense one read failure into a short, countable reason.
 *
 * The service's own message names absolute paths and internal error identities,
 * which is far too noisy for a panel line. Only the distinguishing clause is
 * kept, and each distinct reason is counted rather than repeated per attempt.
 * @param {unknown} error - the thrown value.
 * @returns {string} a single-line reason.
 */
export function reasonOf(error) {
  const raw = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);
  // The message reads `<inner cause>; source v0 artifact remains unchanged (raw log: <path>)`.
  const head = raw.split(' (raw log:')[0].split('; source ')[0];
  const cleaned = head.replace(/\s+/g, ' ').trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}\u2026` : cleaned;
}

/**
 * Mark one session permanently unreadable and record why, ONCE.
 *
 * Counting happens here rather than per attempt, so the reported tally describes
 * how many sessions are broken instead of how many times they were retried.
 * @param {string} sessionId - the session that cannot be read.
 * @param {unknown} error - the thrown value.
 */
function markUnreadable(sessionId, error) {
  const reason = reasonOf(error);
  // The pass has given up on this log, so it is no longer the pass's to own: its
  // live settlements have no other contributor and must be free to be folded.
  ledger.corpus.delete(sessionId);
  if (ledger.unreadable.has(sessionId)) return;
  ledger.unreadable.set(sessionId, reason);
  ledger.telemetry.sessionsFailed += 1;
  const existing = ledger.telemetry.failureReasons.find((entry) => entry.reason === reason);
  if (existing !== undefined) {
    existing.count += 1;
    return;
  }
  if (ledger.telemetry.failureReasons.length >= FAILURE_REASON_LIMIT) return;
  ledger.telemetry.failureReasons.push({
    key: reason,
    reason,
    count: 1,
    example: sessionId,
  });
}

//#region legacy (v0) artifact recovery

/**
 * Sessions whose log the persistence service refuses to migrate are still plain
 * zstd-compressed JSONL on disk. Those archives hold real provider usage, so
 * they are read directly instead of being dropped.
 *
 * This bypasses the session-format contract deliberately and reads ONLY the two
 * event types the fold needs; every other event is ignored. A session with a
 * readable vN generation never reaches this path, so a migrated session is never
 * counted twice.
 */

/** Read the 4-byte little-endian magic of a zstd frame. */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Decompress every zstd frame in one buffer.
 * @param {Buffer} input - multi-frame zstd bytes.
 * @returns {string} the decoded text.
 */
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

/**
 * Location of the legacy generation of one session, when it exists.
 *
 * The versioned generation lives beside it as `session.v<N>.jsonl.zstd`; a
 * session that already has one is skipped, because the service reads it and
 * counting the archive too would double its tokens.
 * @param {string} sessionId - the session id.
 * @returns {string|null} the legacy log path, or null when there is nothing to recover.
 */
function legacyLogPath(sessionId) {
  // The store's own layout is `<root>/<workspace-slug>/<session id>/`; only the
  // session id is known here, so the located package supplies the root.
  const root = sessionsRoot();
  if (root === null) return null;
  try {
    const workspaceDirs = readdirSync(root, { withFileTypes: true });
    for (const entry of workspaceDirs) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name, sessionId);
      let files;
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      if (!files.includes('session.jsonl.zstd')) return null;
      if (files.some((name) => name.startsWith('session.v') && name.endsWith('.jsonl.zstd'))) return null;
      return join(dir, 'session.jsonl.zstd');
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolve `~/.dsh/sessions` without importing an unguarded Node global. */
function sessionsRoot() {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (typeof home !== 'string' || home.length === 0) return null;
  return join(home, '.dsh', 'sessions');
}

/**
 * Read one legacy session's usable events and its workspace.
 * @param {string} sessionId - the session id.
 * @returns {{ events: unknown[], cwd: string|null }|null}
 */
function readLegacySession(sessionId) {
  const path = legacyLogPath(sessionId);
  if (path === null) return null;
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
    if (parsed === null || typeof parsed !== 'object') continue;
    if (parsed.type === 'session') {
      if (typeof parsed.cwd === 'string') cwd = parsed.cwd;
      continue;
    }
    events.push(parsed);
  }
  return events.length === 0 ? null : { events, cwd };
}

//#endregion

/**
 * One pass over the stored corpus. Concurrent callers share the in-flight pass,
 * and the pass itself runs ONCE per process: after it settles nothing lists or
 * re-reads unreadable sessions again.
 * @param {object} sessionQuery - the `ctx.sessionQuery` service.
 * @returns {Promise<void>} after every listable session has been accounted for.
 */
async function backfill(sessionQuery) {
  if (ledger.seeded) return undefined;
  if (ledger.backfill !== null) return ledger.backfill;
  ledger.backfill = (async () => {
    ledger.seeding = true;
    try {
      const records = await sessionQuery.listSessions();
      for (const record of records) ledger.corpus.add(String(record.header.id));
      const pending = records.filter((record) => {
        const id = String(record.header.id);
        return !ledger.sessionCursor.has(id) && !ledger.unreadable.has(id);
      });
      for (let offset = 0; offset < pending.length; offset += BACKFILL_BATCH_SIZE) {
        const batch = pending.slice(offset, offset + BACKFILL_BATCH_SIZE);
        /* eslint-disable no-await-in-loop -- bounded batching keeps I/O pressure predictable. */
        await Promise.all(batch.map(async (record) => {
          const id = String(record.header.id);
          try {
            const snapshot = await sessionQuery.readSession(record.header.id);
            foldSession(
              {
                id,
                cwd: snapshot.session.cwd ?? record.header.cwd ?? null,
                isSeeded: snapshot.session.isSeeded === true || record.header.isSeeded === true,
              },
              snapshot.events,
              snapshot.inheritedEventCount,
            );
            ledger.telemetry.sessionsScanned += 1;
          } catch (error) {
            // The service cannot migrate this log; recover its usage directly
            // rather than letting real tokens disappear from the totals.
            const legacy = readLegacySession(id);
            if (legacy !== null) {
              foldSession(
                { id, cwd: legacy.cwd ?? record.header.cwd ?? null, isSeeded: false },
                legacy.events,
                0,
              );
              ledger.telemetry.recovered += 1;
              ledger.sessionCursor.set(id, ledger.sessionCursor.get(id) ?? -1);
              ledger.unreadable.set(id, reasonOf(error));
              return;
            }
            markUnreadable(id, error);
          }
        }));
        /* eslint-enable no-await-in-loop */
        ledger.revision += 1;
      }
      ledger.seeded = true;
    } finally {
      ledger.seeding = false;
      ledger.backfill = null;
    }
  })();
  return ledger.backfill;
}

/**
 * Fold one live session event into the aggregate.
 *
 * The corpus pass and this feed must partition the sessions between them exactly
 * once, or a settlement is either lost or counted twice:
 *
 *  - a session the pass LISTED belongs to the pass, which reads its whole log; a
 *    live event for it stays out of the aggregate until the cursor the pass leaves
 *    behind takes over. Folding it here as well would double its tokens.
 *  - a session the pass never listed has no other contributor at all. That is
 *    every conversation started after the pass enumerated the corpus, which is
 *    every conversation started while the server is up; refusing those left
 *    "today" showing only what the last restart had already found on disk.
 *
 * Before the pass has enumerated anything the two cases are indistinguishable — an
 * unseen id may be a brand-new session or an older one that a user has just
 * resumed ahead of the pass — and the pass will fold both in full, so nothing is
 * claimed yet.
 */
function onSessionEvent(session, event) {
  const id = String(session.id);

  // A route event names the model for the settlements that follow it, including
  // the very first one of a session this feed is about to adopt, so it is cached
  // whether or not the session is already known. It carries no tokens.
  if (event.type === 'request/header' || event.type === 'request/context') {
    ledger.sessionRoute.set(id, event);
    return;
  }
  if (event.type !== 'assistant/message') return;

  const seq = typeof event.seq === 'number' ? event.seq : 0;
  let lastIndexed = ledger.sessionCursor.get(id);
  if (lastIndexed === undefined) {
    // Listed by the pass: its history is the pass's to fold.
    if (ledger.corpus.has(id)) return;
    // Nothing has enumerated the corpus yet, so this id may be an older session
    // the pass is about to fold in full — claiming it here would strand its
    // history behind a cursor the pass then declines to fill.
    if (!ledger.seeding && !ledger.seeded) return;
    // A session no enumeration ever listed: this feed owns it from this event on.
    lastIndexed = -1;
  }
  if (seq <= lastIndexed) return;

  const route = ledger.sessionRoute.get(id);
  const cwd = session.header !== undefined && typeof session.header.cwd === 'string' ? session.header.cwd : null;
  foldSessionIntoAggregate(
    ledger.aggregate,
    {
      events: route === undefined ? [event] : [route, event],
      inheritedEventCount: 0,
      sessionId: id,
      cwd,
    },
    { tzOffsetMinutes: ledger.tzOffsetMinutes },
  );
  ledger.sessionCursor.set(id, seq);
  ledger.revision += 1;
}

/** JSON response helper. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The panel polls; a cached body would freeze the numbers.
      'cache-control': 'no-store',
    },
  });
}

/**
 * Build the route handler bound to one plugin context.
 *
 * The panel has no filter controls, so the route always serves the whole
 * corpus: every workspace, and a window wide enough for a year of heatmap.
 * @param {object} ctx - the Host plugin context.
 * @returns {(request: Request) => Promise<Response>} the Fetch handler.
 */
function createHandler(ctx) {
  return async function handle(request) {
    const sessionQuery = ctx.sessionQuery;
    if (sessionQuery === undefined) {
      return json({ error: 'session query service is unavailable' }, 503);
    }

    const url = new URL(request.url);
    const daysParam = url.searchParams.get('days');
    let window = DEFAULT_WINDOW_DAYS;
    if (daysParam !== null) {
      const parsed = Number(daysParam);
      if (!Number.isInteger(parsed) || parsed < 7 || parsed > 1100) {
        return json({ error: 'days must be an integer between 7 and 1100' }, 400);
      }
      window = parsed;
    }

    try {
      await backfill(sessionQuery);
    } catch (error) {
      // A failure to enumerate the corpus at all is reported once and does not
      // stop the route from serving whatever was folded.
      const reason = reasonOf(error);
      if (!ledger.telemetry.failureReasons.some((entry) => entry.reason === reason)) {
        ledger.telemetry.failureReasons.push({ key: reason, reason, count: 1, example: '(corpus)' });
      }
    }

    const today = todayKey();
    const earliest = Object.keys(ledger.aggregate.byDay).sort()[0];
    // The requested span is a floor, not a cap: the aggregate may hold older days,
    // and an early model must stay listable. `buildPayload` then narrows the
    // per-model views to the corpus inside this heatmap window.
    const requested = shiftDay(today, -(window - 1));
    const from = windowStartFor(earliest, requested, today);
    return json(buildPayload(ledger.aggregate, {
      revision: ledger.revision,
      seeding: ledger.seeding,
      tzOffsetMinutes: ledger.tzOffsetMinutes,
      from,
      to: today,
      today,
      telemetry: ledger.telemetry,
    }));
  };
}
/**
 * Activate the plugin: capture the timezone, subscribe to live settlements, and
 * claim the Fetch route.
 * @param {object} ctx - the Host plugin context.
 */
export function apply(ctx) {
  ledger.tzOffsetMinutes = localOffsetMinutes();

  ctx.effect(
    () => ctx.on('session/event', (session, event) => {
      try {
        onSessionEvent(session, event);
      } catch (error) {
        // A live fold failure must never disturb the agent loop, and it is NOT a
        // session read failure — folding already-logged data is a different
        // concern from reading a stored session, so the counters stay separate.
        ledger.liveFoldErrors += 1;
        if (ledger.liveFoldErrors <= LIVE_FOLD_ERROR_LIMIT) {
          console.error('[usage-stats] live fold failed:', reasonOf(error));
        }
      }
    }),
    'usage-stats: live settlement feed',
  );

  const connection = Reflect.get(ctx, 'connection');
  if (connection === undefined || connection === null) return;
  const fetchRegistry = connection.fetch;
  if (fetchRegistry === undefined || fetchRegistry === null) return;

  const handler = createHandler(ctx);
  ctx.effect(
    () => fetchRegistry.register({
      path: DATA_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: handler,
    }),
    `usage-stats: GET ${DATA_PATH}`,
  );
}
