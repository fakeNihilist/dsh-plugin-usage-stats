/**
 * Tests for the Host half's fork-cut decision.
 *
 * This rule is the single highest-risk piece of the plugin: getting it wrong
 * silently double-counts a fork parent's tokens across the whole corpus. It is
 * exercised directly against `inheritedCut` rather than through a Cordis
 * runtime, since the function is pure.
 *
 * Run with: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inheritedCut, windowStartFor } from '../index.js';

/** A tagged child-owned fork marker at `seq`. */
function taggedMarker(seq) {
  return { type: 'session/end-seed', seq, time: 1, data: { inherited: true } };
}

/** An untagged lifecycle marker at `seq`; most ordinary sessions carry one. */
function lifecycleMarker(seq) {
  return { type: 'session/end-seed', seq, time: 1 };
}

/** A settlement, just so the log looks realistic. */
function settlement(seq) {
  return { type: 'assistant/message', seq, time: 1, data: { usage: { inputTokens: 1 } } };
}

test('a non-seeded session is never cut, even with an untagged lifecycle marker', () => {
  // Regression guard: treating `session/end-seed` as an inheritance cut dropped
  // real settlement history for well over a third of ordinary sessions.
  const events = [lifecycleMarker(2), settlement(3), settlement(4)];
  assert.equal(inheritedCut(events, 0, false), 0);
  assert.equal(inheritedCut(events, 3, false), 0, 'a reported count is ignored unless the header says seeded');
});

test('a non-seeded session with no markers is not cut', () => {
  assert.equal(inheritedCut([settlement(0), settlement(1)], 0, false), 0);
});

test('a seeded session is cut at the tagged marker', () => {
  const events = [settlement(0), settlement(1), taggedMarker(2), settlement(3)];
  assert.equal(inheritedCut(events, 3, true), 3, 'cut lands just after the marker');
});

test('only the LAST tagged marker decides, matching the documented cut rule', () => {
  const events = [taggedMarker(1), settlement(2), taggedMarker(5), settlement(6)];
  assert.equal(inheritedCut(events, 6, true), 6);
});

test('untagged markers are ignored when picking the tagged cut', () => {
  const events = [lifecycleMarker(1), taggedMarker(2), lifecycleMarker(9)];
  assert.equal(inheritedCut(events, 3, true), 3, 'the later untagged marker must not move the cut');
});

test('a seeded session missing its tagged marker falls back to the reported count', () => {
  assert.equal(inheritedCut([settlement(0), settlement(1)], 1, true), 1);
});

test('a seeded session with neither marker nor reported count is left uncut', () => {
  assert.equal(inheritedCut([settlement(0)], 0, true), 0);
  assert.equal(inheritedCut([settlement(0)], undefined, true), 0);
  assert.equal(inheritedCut([settlement(0)], Number.NaN, true), 0);
  assert.equal(inheritedCut([settlement(0)], -5, true), 0);
});

test('malformed events do not break the cut scan', () => {
  const events = [null, 'nonsense', { type: 'session/end-seed' }, { type: 'session/end-seed', seq: 2, data: { inherited: true } }, 42];
  assert.equal(inheritedCut(events, 0, true), 3);
});

test('an empty log has no cut', () => {
  assert.equal(inheritedCut([], 0, true), 0);
  assert.equal(inheritedCut([], 0, false), 0);
});

test('the window reaches back to the corpus start when that is older', () => {
  // The panel's widest option means "the corpus", not a fixed span: a model that
  // ran six months ago has to stay listable, so the requested span is a floor.
  assert.equal(
    windowStartFor('2026-01-05', '2026-09-17', '2026-09-23'),
    '2026-01-05',
    'an older corpus start widens the window',
  );
});

test('a corpus inside the requested span does not shorten the window', () => {
  // Otherwise the heatmap would lose its leading days for no reason.
  assert.equal(windowStartFor('2026-09-20', '2026-09-17', '2026-09-23'), '2026-09-17', 'the requested span wins');
  assert.equal(windowStartFor('2026-09-17', '2026-09-17', '2026-09-23'), '2026-09-17', 'an exact match is a no-op');
});

test('the window never starts in the future, whatever the aggregate holds', () => {
  // A clock-skewed event dated tomorrow must not pull the start forward past the
  // requested span, or today's columns would fall outside the window entirely.
  assert.equal(windowStartFor('2026-09-24', '2026-09-17', '2026-09-23'), '2026-09-17', 'a future start is ignored');
});

test('an empty or malformed earliest day leaves the requested span alone', () => {
  assert.equal(windowStartFor(undefined, '2026-09-17', '2026-09-23'), '2026-09-17');
  assert.equal(windowStartFor('', '2026-09-17', '2026-09-23'), '2026-09-17');
  assert.equal(windowStartFor(null, '2026-09-17', '2026-09-23'), '2026-09-17');
  assert.equal(windowStartFor('not-a-day', '2026-09-17', '2026-09-23'), '2026-09-17');
});

test('a single malformed timestamp cannot empty the payload', () => {
  // `enumerateDays` returns an empty series past its own limit, which would blank
  // the whole panel. The widened span is probed against that limit, so an absurd
  // earliest day falls back to the requested window instead.
  assert.equal(
    windowStartFor('0001-01-01', '2026-09-17', '2026-09-23'),
    '2026-09-17',
    'a span too long to enumerate is not taken',
  );
});


test('the window is a floor: an old corpus is never truncated to a year', () => {
  // The per-model views read the corpus's span out of this window, so a model that
  // ran eighteen months ago has to stay reachable. The requested year is a floor.
  assert.equal(
    windowStartFor('2025-01-05', '2026-09-17', '2026-09-23'),
    '2025-01-05',
    'an older corpus start widens the window past the requested span',
  );
});
