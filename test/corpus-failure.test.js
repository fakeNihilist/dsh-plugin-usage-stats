/**
 * Regression tests for an enumeration that throws.
 *
 * The bug these pin down: a failing `listSessions()` was recorded in
 * `failureReasons` and then never shown, because the panel gated its whole
 * diagnostics block on counters this path does not touch. The visible symptom was
 * the worst possible one — while the failure lasts `seeded` stays false, so the live
 * feed refuses every session it cannot yet classify, and the panel renders zeroes
 * as though the corpus were empty.
 *
 * The ledger is module scope and its corpus pass runs once per process, so this file
 * owns its own process: node's test runner gives each test file one, which is what
 * lets the first call here observe a corpus that has never been enumerated.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DATA_PATH, apply, reasonOf } from '../index.js';

/** One `assistant/message` carrying a settlement. */
function settlement(seq, tokens) {
  return {
    type: 'assistant/message',
    seq,
    time: Date.UTC(2026, 5, 1, 12),
    data: { usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  };
}

/**
 * Activate the plugin over a stub context whose enumeration is scriptable.
 * @param {{fail?: boolean, sessions?: object[]}} options - how `listSessions` behaves.
 * @returns {{get: Function, emit: Function, setFail: Function}} the route and the feed.
 */
function harness(options) {
  const state = { fail: options.fail === true, sessions: options.sessions ?? [] };
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
      listSessions: async () => {
        if (state.fail) throw new Error('corpus listing exploded (raw log: /secret/path.jsonl.zstd)');
        return state.sessions.map((entry) => ({ header: { id: entry.id, cwd: entry.cwd } }));
      },
      readSession: async (id) => {
        const entry = state.sessions.find((candidate) => candidate.id === id);
        if (entry === undefined) throw new Error(`no such session: ${id}`);
        return {
          session: { cwd: entry.cwd, isSeeded: false },
          events: entry.events,
          inheritedEventCount: 0,
        };
      },
    },
  };
  apply(ctx);
  return {
    emit: (session, event) => live(session, event),
    setFail: (value) => {
      state.fail = value;
    },
    setSessions: (value) => {
      state.sessions = value;
    },
    get: async () => {
      const response = await route(new Request(`http://localhost${DATA_PATH}`));
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

test('an enumeration that throws is reported, not swallowed', async () => {
  const host = harness({ fail: true });
  const payload = await host.get();

  assert.equal(payload.warnings.corpusFailures, 1, 'the failure reaches the payload');
  const corpus = payload.warnings.failureReasons.filter((entry) => entry.example === '(corpus)');
  assert.equal(corpus.length, 1, 'the failure carries one reason');
  // The service's message names paths and internal identities; only the distinguishing
  // clause survives, which is what keeps a panel line readable.
  assert.equal(corpus[0].reason, 'corpus listing exploded');
  assert.ok(!payload.warnings.failureReasons.some((entry) => entry.reason.includes('/secret/path')));

  // Nothing was enumerated, so nothing can be claimed — and the live feed must not
  // adopt a session it may yet find in a corpus pass, or that pass would skip it and
  // strand its history.
  host.emit({ id: 'live-untracked', header: { cwd: '/work' } }, settlement(1, 999));
  const after = await host.get();
  assert.equal(after.totals.calls, 0, 'an unseeded corpus claims nothing');
  assert.equal(after.warnings.corpusFailures, 1, 'the failure is still the current state');
  assert.equal(
    after.warnings.failureReasons.filter((entry) => entry.example === '(corpus)').length,
    1,
    'polling must not accumulate one reason per attempt',
  );
});

test('a later enumeration that succeeds clears the warning and folds the corpus', async () => {
  const host = harness({ fail: true });
  const failed = await host.get();
  assert.equal(failed.warnings.corpusFailures, 1, 'the fixture starts broken');

  // The retry on the next request is the whole recovery path: `backfill` clears its
  // in-flight promise when it throws, so a transient failure heals without a restart.
  host.setSessions([{ id: 'recovered', cwd: '/work', events: [settlement(1, 400)] }]);
  host.setFail(false);

  const healed = await host.get();
  assert.equal(healed.warnings.corpusFailures, 0, 'a completed pass makes the corpus complete');
  assert.equal(
    healed.warnings.failureReasons.filter((entry) => entry.example === '(corpus)').length,
    0,
    'a reason that no longer holds must not linger as a permanent warning',
  );
  assert.equal(healed.totals.calls, 1, 'the pass that succeeded folded what the failed one could not');
  assert.equal(healed.warnings.sessionsScanned, 1);
});

test('reasonOf strips the path and source suffix and bounds the length', () => {
  assert.equal(
    reasonOf(new Error('boom; source v0 artifact remains unchanged (raw log: /a/b.jsonl.zstd)')),
    'boom',
  );
  assert.equal(reasonOf(new Error('  spaced   out  ')), 'spaced out');
  const long = reasonOf(new Error('x'.repeat(400)));
  assert.equal(long.length, 198, 'measured in UTF-16 units: 197 kept plus the ellipsis');
  assert.ok(long.endsWith('\u2026'));
  assert.equal(reasonOf('plain string'), 'plain string');
});
