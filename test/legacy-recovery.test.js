/**
 * Regression tests for the legacy (v0) recovery path.
 *
 * When the persistence service refuses to migrate a session log, its bytes are still
 * plain multi-frame zstd JSONL on disk, and they hold real provider usage. The plugin
 * reads that archive directly so those tokens are counted instead of dropped. This
 * region had no coverage at all before, which is how a re-stated cursor and an
 * unpinned `recoveredSessions` count could both go unnoticed.
 *
 * The ledger is module scope and its corpus pass runs ONCE per process, so this file
 * is deliberately one process with one pass: the cases below are the three outcomes
 * that pass can reach (recovered, unreadable, read normally), all listed together.
 * Later cases assert the DELTA their own events produced rather than an absolute
 * total.
 *
 * `sessionsRoot()` resolves the store from `USERPROFILE` on every call rather than
 * caching it, which is what lets the whole store be redirected into a temp directory
 * and keep the real corpus out of these assertions.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { DATA_PATH, apply, reasonOf } from '../index.js';
import { totalOf } from '../usage-fold.js';

const TZ_OFFSET_MINUTES = -new Date().getTimezoneOffset();
const NOON = Date.UTC(2026, 5, 1, 12) - TZ_OFFSET_MINUTES * 60_000;

/** The redirected profile root, so `~/.dsh/sessions` lands inside it. */
const STORE = mkdtempSync(join(tmpdir(), 'usage-stats-legacy-'));
const PREVIOUS_PROFILE = process.env.USERPROFILE;
const PREVIOUS_HOME = process.env.HOME;
process.env.USERPROFILE = STORE;
// Blanked as well, or a machine that defines only HOME would escape the temp store.
delete process.env.HOME;

after(() => {
  if (PREVIOUS_PROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = PREVIOUS_PROFILE;
  if (PREVIOUS_HOME !== undefined) process.env.HOME = PREVIOUS_HOME;
  rmSync(STORE, { recursive: true, force: true });
});

/** One `assistant/message` carrying a settlement. */
function settlement(seq, tokens) {
  return {
    type: 'assistant/message',
    seq,
    time: NOON,
    data: { usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  };
}

/**
 * Write a legacy archive at the store's own layout, split across two zstd frames the
 * way the real writer does, so the multi-frame reader is exercised too.
 * @param {string} slug - the workspace directory name.
 * @param {string} id - the session id.
 * @param {object[]} records - the JSONL records, header line included.
 */
function writeLegacyArchive(slug, id, records) {
  const dir = join(STORE, '.dsh', 'sessions', slug, id);
  mkdirSync(dir, { recursive: true });
  const lines = records.map((record) => `${JSON.stringify(record)}\n`);
  const split = Math.max(1, Math.ceil(lines.length / 2));
  writeFileSync(
    join(dir, 'session.jsonl.zstd'),
    Buffer.concat([
      zstdCompressSync(Buffer.from(lines.slice(0, split).join(''), 'utf8')),
      zstdCompressSync(Buffer.from(lines.slice(split).join(''), 'utf8')),
    ]),
  );
}

/** A readable session, folded through the service like any other. */
const READABLE = { id: 'readable-session', cwd: '/work/readable', events: [settlement(1, 20)] };
/** Listed by the pass, unreadable by the service, and recoverable from its archive. */
const RECOVERED_ID = 'recoverable-session';
/** Listed by the pass, unreadable, with no archive behind it. */
const MISSING_ID = 'missing-archive-session';

writeLegacyArchive('--work-recovered--', RECOVERED_ID, [
  { type: 'session', id: RECOVERED_ID, cwd: '/work/recovered' },
  settlement(3, 500),
  settlement(4, 700),
]);

const READ_SESSION_FAILURE =
  'legacy log is not migratable; source v0 artifact remains unchanged (raw log: /x.jsonl.zstd)';

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
    listSessions: async () => [
      { header: { id: RECOVERED_ID, cwd: '/work/recovered' } },
      { header: { id: MISSING_ID, cwd: '/work/missing' } },
      { header: { id: READABLE.id, cwd: READABLE.cwd } },
    ],
    readSession: async (id) => {
      if (id === READABLE.id) {
        return { session: { cwd: READABLE.cwd, isSeeded: false }, events: READABLE.events, inheritedEventCount: 0 };
      }
      throw new Error(READ_SESSION_FAILURE);
    },
  },
};
apply(ctx);

const get = async () => {
  const response = await route(new Request(`http://localhost${DATA_PATH}`));
  assert.equal(response.status, 200);
  return response.json();
};

/** The corpus pass has run by the time this resolves; every case below reads it. */
const seeded = await get();

test('a v0 archive the service refuses to migrate is read directly', () => {
  assert.equal(seeded.warnings.recoveredSessions, 1, 'the archive is reported as recovered');
  assert.equal(seeded.warnings.sessionsScanned, 1, 'the readable session went through the service');
  assert.equal(seeded.warnings.sessionsFailed, 1, 'only the session with no archive is a failure');

  // The recovered tokens are counted rather than dropped: 500 + 700, plus the
  // readable session's 20.
  assert.equal(totalOf(seeded.totals), 1220);
  assert.equal(seeded.totals.calls, 3);

  // The archive's own header carries the workspace when the listing is the only other
  // source, and the recovery is not double-reported as a read failure.
  const reasons = seeded.warnings.failureReasons;
  assert.equal(reasons.length, 1, 'one problem, one reason');
  assert.equal(reasons[0].example, MISSING_ID, 'the reason names the session that could not be recovered');
  assert.ok(
    !reasons.some((entry) => entry.reason.includes('/x.jsonl.zstd')),
    'the reason drops the service message\'s absolute path',
  );
});

test('a recovered archive advances the cursor so its live replays stay out', async () => {
  const before = await get();

  // Folded through seq 4, so a replay at or below it is already counted. If the
  // recovery path had left the cursor behind, this settlement would count twice.
  live({ id: RECOVERED_ID, header: { cwd: '/work/recovered' } }, settlement(4, 700));
  const replayed = await get();
  assert.equal(replayed.totals.calls, before.totals.calls, 'the replayed settlement is not counted again');
  assert.equal(totalOf(replayed.totals), totalOf(before.totals));

  // A genuinely new settlement still lands, which is what lets a recovered session
  // keep contributing while the server is up.
  live({ id: RECOVERED_ID, header: { cwd: '/work/recovered' } }, settlement(5, 30));
  const extended = await get();
  assert.equal(extended.totals.calls, before.totals.calls + 1, 'a newer settlement is folded');
  assert.equal(totalOf(extended.totals), totalOf(before.totals) + 30);
});

test('a session the service cannot read and no archive backs stays a failure', async () => {
  // The third outcome of the same pass, asserted from the same payload: no archive
  // means the usage is genuinely unavailable, and it must not be silently zero.
  assert.equal(
    seeded.warnings.failureReasons.filter((entry) => entry.example === MISSING_ID).length,
    1,
    'the unrecoverable session is reported once',
  );
  assert.equal(seeded.warnings.corpusFailures, 0, 'the enumeration itself succeeded');
});

test('reasonOf strips the path and source suffix and bounds the length', () => {
  assert.equal(reasonOf(new Error(READ_SESSION_FAILURE)), 'legacy log is not migratable');
  assert.equal(reasonOf(new Error('  spaced   out  ')), 'spaced out');
  const long = reasonOf(new Error('x'.repeat(400)));
  assert.equal(long.length, 198, 'measured in UTF-16 units: 197 kept plus the ellipsis');
  assert.ok(long.endsWith('\u2026'));
  assert.equal(reasonOf('plain string'), 'plain string');
});
