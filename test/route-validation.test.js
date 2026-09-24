/**
 * Tests for the route handler's own validation and for the failure accounting it
 * reports.
 *
 * Both concerns are the Host half's edges rather than its core fold: the `days`
 * bounds and the missing-service guard both sit in front of the corpus pass, and the
 * failure tally is what turns a pile of unreadable sessions into a countable number
 * of problems. Neither had any coverage, so a regression in either would have been
 * invisible — the route would keep answering 200 with quietly wrong parameters.
 *
 * The ledger is module scope and its corpus pass runs ONCE per process, so the
 * sessions this file needs are all listed by one seeding pass. The 400 and 503 paths
 * return before that pass, which is why they can be asserted over the same route.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DATA_PATH, apply } from '../index.js';

/** The reason limit the Host enforces on distinct failure causes. */
const FAILURE_REASON_LIMIT = 20;

/** Two sessions sharing one cause, so the reason list has to fold them together. */
const SHARED_IDS = ['shared-1', 'shared-2'];
/** Enough distinct causes to cross the reason limit and prove the list is capped. */
const DISTINCT_IDS = Array.from({ length: 21 }, (unused, index) => `distinct-${index}`);
const ALL_IDS = [...SHARED_IDS, ...DISTINCT_IDS];

const SHARED_REASON = 'the same archive is unreadable';

/** The failure message one stubbed session id reports. */
function reasonFor(id) {
  return id.startsWith('shared-')
    ? SHARED_REASON
    : `distinct failure ${id.slice('distinct-'.length)}`;
}

/**
 * Activate the plugin over a corpus where every listed session fails to read, and
 * return that context's own route.
 *
 * Each context keeps its route in its own closure: the plugin's ledger is module
 * scope, so a second `apply` must not be handed the first one's handler.
 * @param {boolean} [withoutSessionQuery] - omit the service, for the guard's own case.
 * @returns {(search?: string) => Promise<Response>} the route entry point.
 */
function createRoute(withoutSessionQuery = false) {
  let route = null;
  const ctx = {
    effect: (fn) => {
      fn();
    },
    // The live feed is not this file's concern; it only has to be installable.
    on: () => () => true,
    connection: {
      fetch: {
        register: (entry) => {
          route = entry.fetch;
          return () => true;
        },
      },
    },
  };
  if (!withoutSessionQuery) {
    ctx.sessionQuery = {
      listSessions: async () => ALL_IDS.map((id) => ({ header: { id, cwd: '/work' } })),
      readSession: async (id) => {
        throw new Error(reasonFor(id));
      },
    };
  }
  apply(ctx);
  return (search = '') => route(new Request(`http://localhost${DATA_PATH}${search}`));
}

/** The route under test, over the failing corpus. */
const request = createRoute();

/** A context with no `sessionQuery` at all, for the guard's own case. */
const noServiceRequest = createRoute(true);

test('the days parameter is validated before anything else runs', async () => {
  // The guard sits in front of the corpus pass, so a bad request is never answered by
  // quietly folding with a default window.
  for (const bad of ['?days=6', '?days=1101', '?days=0', '?days=-7', '?days=abc', '?days=7.5', '?days=']) {
    const response = await request(bad);
    assert.equal(response.status, 400, `${bad} is rejected as a bad request`);
    const body = await response.json();
    assert.match(body.error, /days must be an integer between 7 and 1100/, 'the error names the bounds');
  }

  // The bounds themselves are inclusive, and the parameter is optional.
  assert.equal((await request()).status, 200, 'omitting the parameter uses the default window');
  assert.equal((await request('?days=7')).status, 200, 'the lower bound is inclusive');
  assert.equal((await request('?days=1100')).status, 200, 'the upper bound is inclusive');
  assert.equal((await request('?days=30&days=9000')).status, 200, 'a repeated parameter resolves to the first value');
});

test('a missing session service is reported instead of crashing the route', async () => {
  const response = await noServiceRequest();
  assert.equal(response.status, 503, 'an unavailable service is a 503, not a 200 of zeroes');
  const body = await response.json();
  assert.match(body.error, /session query service is unavailable/);
});

test('sessions sharing one cause are counted once, and the cause list is bounded', async () => {
  const response = await request();
  assert.equal(response.status, 200);
  const { warnings } = await response.json();

  // Every session failed, so every session is counted: the tally describes how many
  // logs are broken, not how many reasons were recorded.
  assert.equal(warnings.sessionsFailed, ALL_IDS.length, 'every unreadable session is counted');
  assert.equal(warnings.recoveredSessions, 0, 'none of these has a legacy archive to recover');
  assert.equal(warnings.sessionsScanned, 0, 'the service read none of them');

  // The shared cause is one entry carrying its own count, not two identical lines.
  const sharedEntry = warnings.failureReasons.find((entry) => entry.reason === SHARED_REASON);
  assert.notEqual(sharedEntry, undefined, 'the shared cause is recorded');
  assert.equal(sharedEntry.count, 2, 'both sessions are folded into its count');

  // The list is capped: an unbounded list of distinct causes is a panel nobody can
  // read. Counting happens before the cap, so the tally above stays exact.
  assert.equal(
    warnings.failureReasons.length,
    FAILURE_REASON_LIMIT,
    'the distinct-cause list is capped at the documented limit',
  );

  // A second poll must not re-attempt or re-count anything: unreadable sessions are
  // remembered, which is what keeps the tally describing a fixed number of problems
  // rather than growing on every request.
  const second = await (await request()).json();
  assert.equal(second.warnings.sessionsFailed, warnings.sessionsFailed, 'the tally does not grow across polls');
  assert.equal(
    second.warnings.failureReasons.length,
    warnings.failureReasons.length,
    'the reason list does not grow across polls',
  );
  const secondShared = second.warnings.failureReasons.find((entry) => entry.reason === SHARED_REASON);
  assert.equal(secondShared.count, 2, 'the shared count is not incremented again');
});
