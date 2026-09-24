/**
 * Renders the browser half against a REAL Host payload.
 *
 * There is no browser control in this session, so this suite cannot validate
 * pixels. What it does validate is everything below the pixels: that the bundle
 * registers the sidebar entry and the main panel under one shared id, that the
 * component tree builds without throwing for real data, that the heatmap emits
 * one cell per day in the window, and that the cache-rate formatting shows an
 * em dash rather than a misleading 0% when no input was reported.
 *
 * `fetch` and the React hooks are stubbed; nothing here touches the network.
 *
 * Run with: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

import { buildPayload, emptyAggregate, foldSessionIntoAggregate, localDayKey } from '../usage-fold.js';
import { inheritedCut } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const bundleSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

//#region a minimal React + browser environment

/** A rendered node: either a primitive prop or `{ type, props, children }`. */
function element(type, props, ...children) {
  const flat = [];
  const push = (value) => {
    if (value === null || value === undefined || value === false || value === true) return;
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    flat.push(value);
  };
  for (const child of children) push(child);
  const merged = { ...(props ?? {}) };
  if (flat.length > 0) merged.children = flat;
  return { type, props: merged, children: flat };
}

/**
 * Hook state, modelled on React.
 *
 * A component's hooks belong to that component INSTANCE and are read back by
 * call order. This stub binds one slot pool to each mounted component function
 * and resets its cursor at every render pass, so sibling charts never share
 * slots. Keying purely by render order let `DayHeatmap` and `TrendChart` collide.
 */
const hookState = {
  /** The pool belonging to the component currently rendering. */
  pool: { values: [], effects: [], refs: {} },
  cursor: 0,
  /** Exposed copies of the panel's own pool, refreshed by `renderPanel`. */
  values: [],
  effects: [],
  refs: {},
  /** Component function to its instance record. */
  instances: new WeakMap(),
  records: [],
};

/** Identity of the component whose hooks are being collected. */
let currentComponent = null;

/** The slot pool for a mounted component, created once per instance. */
function poolFor(component) {
  if (component === null || component === undefined) return hookState.pool;
  let record = hookState.instances.get(component);
  if (record === undefined) {
    record = { pool: { values: [], effects: [], refs: {} }, cursor: 0 };
    hookState.instances.set(component, record);
    hookState.records.push(record);
  }
  return record.pool;
}

/** Read and advance the current component's hook cursor. */
function nextSlot() {
  if (currentComponent === null) {
    const index = hookState.cursor;
    hookState.cursor += 1;
    return { pool: hookState.pool, index };
  }
  poolFor(currentComponent);
  const record = hookState.instances.get(currentComponent);
  const index = record.cursor;
  record.cursor += 1;
  return { pool: record.pool, index };
}
/** The stubbed React surface the bundle requires. */
const ReactStub = {
  createElement: element,
  useState(initial) {
    const { pool, index } = nextSlot();
    if (!(index in pool.values)) pool.values[index] = initial;
    const set = (next) => {
      pool.values[index] = typeof next === 'function' ? next(pool.values[index]) : next;
    };
    return [pool.values[index], set];
  },
  useEffect(effect) {
    const { pool, index } = nextSlot();
    if (!(index in pool.refs)) pool.refs[index] = { effect };
    pool.effects.push(effect);
  },
  useRef(initial) {
    const { pool, index } = nextSlot();
    if (!(index in pool.refs)) pool.refs[index] = { current: initial };
    return pool.refs[index];
  },
};

/** Reset hook slots for a completely fresh mount. */
function freshMount() {
  hookState.pool = { values: [], effects: [], refs: {} };
  hookState.cursor = 0;
  hookState.values = [];
  hookState.effects = [];
  hookState.refs = {};
  hookState.instances = new WeakMap();
  hookState.records = [];
  currentComponent = null;
}

/**
 * Prepare one more render of the SAME mount: every component's cursor restarts
 * at zero and effects registered during this pass are re-collected, exactly as
 * React does. State, refs, and instance identity all persist.
 */
function rerender() {
  for (const record of hookState.records) {
    record.cursor = 0;
    record.pool.effects = [];
  }
  hookState.cursor = 0;
  hookState.effects = [];
  currentComponent = null;
}

/** Walk a rendered tree depth-first, expanding function components (they use no hooks). */
function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') return;
  if (typeof node !== 'object') return;

  // A function component is invoked with its props so the tree fully expands.
  // `enterComponent` mirrors React binding the hooks below to this component.
  if (typeof node.type === 'function') {
    const previous = currentComponent;
    currentComponent = node.type;
    try {
      walk(node.type(node.props ?? {}), visit);
    } finally {
      currentComponent = previous;
    }
    return;
  }

  visit(node);
  const children = node.props !== undefined && node.props.children !== undefined ? node.props.children : node.children;
  if (children !== undefined) walk(children, visit);
}

/** Collect every node whose `type` is a string tag. */
function tags(tree) {
  const found = [];
  walk(tree, (node) => {
    if (typeof node.type === 'string') found.push(node);
  });
  return found;
}

/** Collect the text content of a tree, flattened. */
function textOf(tree) {
  const parts = [];
  walk(tree, (node) => {
    if (typeof node.type === 'string') {
      const children = node.props.children;
      if (Array.isArray(children)) {
        for (const child of children) if (typeof child === 'string') parts.push(child);
      } else if (typeof children === 'string') {
        parts.push(children);
      }
    }
  });
  return parts.join(' ');
}

/**
 * Load the browser half into a stubbed environment and return its registration.
 * @param {Map<string, object>} registrations - slot name to captured options/component.
 */
function loadBundle(registrations) {
  const slotRegistry = {
    register(options, component) {
      registrations.set(options.name, { options, component });
      return () => {};
    },
    inject(key, callback) {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };
  const fakeCtx = {
    slots: slotRegistry,
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      resolveText: (value) => value,
      // The real service is a LocaleRuntime; the panel reads the active id from
      // it for date formatting, so the stub must carry that surface.
      getSnapshot: () => ({ active: 'en', locales: [], revision: 0 }),
      subscribe: () => () => {},
    },
    effect(callback, label) {
      const disposer = callback(label);
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };
  const dictionaries = new Map();
  fakeCtx.locale.register = (ns, dicts) => {
    dictionaries.set(ns, dicts);
    return () => {};
  };

  let applied = null;
  const windowStub = {
    __ModuleLoader__: {
      load(registration) {
        applied = registration;
      },
    },
  };
  const requireStub = (specifier) => {
    if (specifier === 'react') return ReactStub;
    throw new Error(`unexpected require(${specifier})`);
  };

  // The bundle is authored as a classic script that touches `window`, so give it
  // one for the duration of the load.
  const previousWindow = globalThis.window;
  globalThis.window = windowStub;
  try {
    // eslint-disable-next-line no-new-func -- intentional sandbox evaluation of the bundle source.
    new Function('require', 'fetch', bundleSource)(requireStub, () => {
      throw new Error('fetch must not be called during load');
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }

  assert.notEqual(applied, null, 'the bundle must register itself through __ModuleLoader__');
  const moduleExports = applied.factory(requireStub);
  moduleExports.apply(fakeCtx);
  return { moduleExports, dictionaries };
}
//#endregion

//#region a real payload built from on-disk logs

/** Decompress every zstd frame in one buffer. */
function decompressAllFrames(input) {
  const ZSTD_MAGIC = 0xfd2fb528;
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

/** Cached real-corpus payload: decompressing every log is too slow to repeat per test. */
let realPayloadCache;
let realPayloadLoaded = false;

/**
 * Build a payload from the real session corpus, or null when this machine has
 * none (the suite then falls back to a synthetic payload).
 */
function payloadFromRealLogs() {
  if (realPayloadLoaded) return realPayloadCache;
  realPayloadLoaded = true;
  realPayloadCache = buildRealPayload();
  return realPayloadCache;
}

/** The uncached real-corpus build. */
function buildRealPayload() {
  const logs = collectLogs(join(homedir(), '.dsh', 'sessions'));
  if (logs.length === 0) return null;
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
  if (folded === 0 || aggregate.totals.calls === 0) return null;

  const today = localDayKey(Date.now(), tzOffsetMinutes);
  const from = Object.keys(aggregate.byDay).sort()[0];
  return buildPayload(aggregate, {
    revision: 7,
    seeding: false,
    tzOffsetMinutes,
    from,
    to: today,
    today,
    telemetry: { sessionsScanned: folded, sessionsFailed: 0 },
  });
}

/** A small synthetic payload, used only when the machine has no logs. */
function payloadSynthetic() {
  const tzOffsetMinutes = 0;
  const aggregate = emptyAggregate();
  const events = [];
  for (let day = 1; day <= 9; day += 1) {
    events.push({
      type: 'assistant/message',
      seq: day,
      time: Date.UTC(2026, 0, day, 12),
      data: { usage: { inputTokens: 100 * day, outputTokens: 10 * day, cacheReadTokens: 900 * day, cacheWriteTokens: 0 } },
    });
  }
  foldSessionIntoAggregate(aggregate, { events, inheritedEventCount: 0, sessionId: 's', cwd: '/tmp/proj' }, { tzOffsetMinutes });
  return buildPayload(aggregate, {
    revision: 1,
    seeding: false,
    tzOffsetMinutes,
    from: '2026-01-01',
    to: '2026-01-09',
    today: '2026-01-09',
    telemetry: { sessionsScanned: 1, sessionsFailed: 0 },
  });
}

/**
 * A dense year of days, the shape the Host route actually serves for `?days=371`.
 *
 * The real corpus on this machine starts only weeks ago, so its payload spans a
 * handful of week columns — far too narrow to place a year of month labels or to
 * expose a column pitch that stretches. This fixture works every third day across
 * a full year, so the heat ramp, the month strip, and the trend window all meet
 * real spacing.
 */
function payloadYear() {
  const tzOffsetMinutes = 0;
  const aggregate = emptyAggregate();
  const events = [];
  const start = Date.UTC(2025, 8, 17, 12);
  for (let index = 0; index < 371; index += 1) {
    if (index % 3 !== 0) continue;
    events.push({
      type: 'assistant/message',
      seq: index,
      time: start + index * 86_400_000,
      data: {
        usage: {
          inputTokens: 1000 + index * 7,
          outputTokens: 200 + index,
          cacheReadTokens: 40_000 + index * 13,
          cacheWriteTokens: 0,
        },
      },
    });
  }
  foldSessionIntoAggregate(aggregate, { events, inheritedEventCount: 0, sessionId: 'year', cwd: '/tmp/year' }, { tzOffsetMinutes });
  return buildPayload(aggregate, {
    revision: 2,
    seeding: false,
    tzOffsetMinutes,
    from: '2025-09-17',
    to: '2026-09-21',
    today: '2026-09-21',
    telemetry: { sessionsScanned: 1, sessionsFailed: 0 },
  });
}

/**
 * A trend window with the spacing that actually broke the ratio line.
 *
 * Two consecutive days, a long dead stretch, then a dense run — the shape this
 * machine's own corpus has (two days in mid-August, nothing until mid-September).
 * A uniform spline draws backwards over itself here; evenly spaced fixtures never
 * show it.
 */
function payloadGapTrend() {
  const tzOffsetMinutes = 0;
  const aggregate = emptyAggregate();
  const events = [];
  const start = Date.UTC(2026, 7, 24, 12);
  const active = [0, 1, 23, 24, 26, 27, 28, 29];
  for (const index of active) {
    events.push({
      type: 'assistant/message',
      seq: index,
      time: start + index * 86_400_000,
      data: {
        usage: {
          inputTokens: 500_000 + index * 1000,
          outputTokens: 100_000 + index * 100,
          cacheReadTokens: 40_000_000 + index * 1000,
          cacheWriteTokens: 0,
        },
      },
    });
  }
  foldSessionIntoAggregate(aggregate, { events, inheritedEventCount: 0, sessionId: 'gap', cwd: '/tmp/gap' }, { tzOffsetMinutes });
  return buildPayload(aggregate, {
    revision: 3,
    seeding: false,
    tzOffsetMinutes,
    from: '2026-08-24',
    to: '2026-09-22',
    today: '2026-09-22',
    telemetry: { sessionsScanned: 1, sessionsFailed: 0 },
  });
}

//#endregion

test('the bundle registers the sidebar entry and the main panel under one id', () => {
  const registrations = new Map();
  const { moduleExports, dictionaries } = loadBundle(registrations);

  assert.deepEqual(moduleExports.inject, ['slots', 'locale'], 'declares only the services it needs');
  assert.ok(dictionaries.has('usageStats'), 'registers its locale namespace');

  const panel = registrations.get('main');
  const entry = registrations.get('sidebar.panellist');
  assert.ok(panel !== undefined, 'registers a main panel');
  assert.ok(entry !== undefined, 'registers a sidebar entry');
  assert.equal(panel.options.key, 'usage', 'panel key');
  assert.equal(entry.options.id, 'usage', 'the sidebar entry must address the panel by the same id');
  assert.equal(typeof entry.options.label, 'function', 'the sidebar resolves its label lazily for locale switches');
  assert.equal(entry.options.locale, 'usageStats');
  assert.equal(typeof panel.component, 'function');
  assert.equal(typeof entry.component, 'function');
});

test('the sidebar icon renders an svg at the requested size', () => {
  const registrations = new Map();
  loadBundle(registrations);
  const tree = registrations.get('sidebar.panellist').component({ size: 22 });
  assert.equal(tree.type, 'svg');
  assert.equal(tree.props.viewBox, '0 0 24 24');
  assert.equal(tree.props.width, 22);
  assert.equal(tree.props.height, 22);
});

//#region render helpers

/** Exact class-token match, so `usage-week` never matches `usage-weeks`. */
function hasClass(node, token) {
  if (typeof node.props.className !== 'string') return false;
  return node.props.className.split(/\s+/).includes(token);
}

/** The text of a node whose children are a string, an array, or nested text nodes. */
function nodeText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node.props === undefined) return '';
  const children = node.props.children;
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) {
    return children.map((child) => nodeText(child)).join('');
  }
  return '';
}

/**
 * Render the panel once with a payload already in hand.
 *
 * The polling effect IS run (so the fetch path is exercised), then immediately
 * cleaned up: leaving a real `setInterval` armed would keep the test runner's
 * event loop alive forever.
 */
/**
 * The translate function a slot receives, built from the dictionaries the bundle
 * registered — the same surface the framework hands a live panel.
 * @param {Map<string, object>} dictionaries - namespace to `{zh, en}` dictionaries.
 * @param {'zh'|'en'} locale - which dictionary the active language resolves to.
 * @returns {(key: string) => string} the bound translate function.
 */
function translateFrom(dictionaries, locale) {
  const dict = dictionaries.get('usageStats')[locale];
  return (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key);
}

function renderWith(payload, extraProps = {}) {
  const registrations = new Map();
  const bundle = loadBundle(registrations);
  freshMount();
  const props = {
    // The identity translate keeps most assertions reading dictionary keys, which
    // is what makes them independent of the shipped copy. Tests that care about
    // language pass a real dictionary through `translateFrom` instead.
    t: (key) => key,
    load: async () => ({ ok: true, json: async () => payload }),
    preloaded: payload,
    ...extraProps,
  };
  const tree = renderPanel(registrations, props);
  for (const effect of hookState.effects) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanup();
  }
  return { tree, registrations, props, moduleExports: bundle.moduleExports };
}

/**
 * Render the panel component itself, exposing its own hooks through
 * `hookState.values` / `hookState.effects` so a test can assert on them.
 * @param {Map<string, object>} registrations - captured slot registrations.
 * @param {object} props - the panel props.
 * @returns {object} the rendered tree.
 */
function renderPanel(registrations, props) {
  const component = registrations.get('main').component;
  const previous = currentComponent;
  currentComponent = component;
  hookState.pool = poolFor(component);
  // Each render pass restarts at the component's first hook.
  const record = hookState.instances.get(component);
  record.cursor = 0;
  record.pool.effects = [];
  try {
    const tree = component(props);
    hookState.values = hookState.pool.values;
    hookState.effects = hookState.pool.effects;
    hookState.refs = hookState.pool.refs;
    return tree;
  } finally {
    currentComponent = previous;
  }
}

/** Let queued microtasks settle so an async fetch completion can run. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Fire a synthetic hovering event against one element. */
function hover(node, handler, point = { clientX: 40, clientY: 60 }) {
  const box = {
    left: 0,
    top: 0,
    width: 720,
    height: 240,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 240 }),
  };
  assert.notEqual(node, undefined, `a node handling ${handler} exists`);
  node.props[handler]({
    ...point,
    currentTarget: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 240 }),
      closest: () => box,
    },
  });
}

//#endregion

test('the panel renders real data without throwing', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);

  const nodes = tags(tree);
  assert.ok(nodes.some((node) => node.type === 'style'), 'the stylesheet renders with the panel');
  const stylesheet = nodes.find((node) => node.type === 'style');
  const css = stylesheet.props.children;
  assert.ok(Array.isArray(css), 'the style element carries its rule text as a child');
  assert.ok(css[0].includes('.usage-panel'), 'the stylesheet holds the panel rules');
  assert.ok(css[0].includes('max-width: 960px'), 'the panel is capped at the Plugins page measure');
  // The ramp is four steps off the theme's static blue scale rather than an alias
  // token, so a theme switch cannot repaint the scale. Checked rule by rule: the
  // new range control's focus ring deliberately does follow the theme.
  for (const [level, color] of [
    ['l1', 'var(--dsw-static-blue-100)'],
    ['l2', 'var(--dsw-static-blue-300)'],
    ['l3', 'var(--dsw-static-blue-450)'],
    ['l4', 'var(--dsw-static-blue-600)'],
  ]) {
    assert.ok(
      css[0].includes(`.usage-cell.${level} { background: ${color}; }`),
      `heat level ${level} keeps its own blue (${color})`,
    );
  }
});

test('the heatmap covers every day in the window exactly once', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);

  // Hoverable cells are the real days; the head padding carries no handler.
  const cells = tags(tree).filter((node) => (
    node.type === 'div'
    && hasClass(node, 'usage-cell')
    && node.props.onMouseEnter !== undefined
  ));

  assert.equal(cells.length, payload.days.length, 'exactly one hoverable cell per day in the window');

  const hovered = cells.map((node) => node.props['data-hover']).filter((value) => value !== undefined);
  assert.equal(hovered.length, 0, 'no cell is highlighted before a hover');
});

/** Latin month names, as a non-Chinese active locale renders them. */
const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The same months through `zh-CN`; each name is exactly two full-width characters. */
const MONTH_NAMES_ZH = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
];

/** The columns (1-based, Sunday first) that hold the first day of each month. */
function firstColumnPerMonth(days) {
  const head = new Date(`${days[0].day}T00:00:00Z`).getUTCDay();
  const columns = new Map();
  for (let index = 0; index < days.length; index += 1) {
    const month = days[index].day.slice(0, 7);
    if (!columns.has(month)) columns.set(month, Math.floor((head + index) / 7) + 1);
  }
  return columns;
}

test('month labels never overlap, whatever the language', () => {
  for (const locale of ['zh', 'en']) {
    const payload = payloadYear();
    const registrations = new Map();
    const bundle = loadBundle(registrations);
    freshMount();
    const tree = renderPanel(registrations, {
      t: translateFrom(bundle.dictionaries, locale),
      load: async () => ({ ok: true, json: async () => payload }),
      preloaded: payload,
    });

    const labels = tags(tree)
      .filter((node) => node.type === 'span' && node.props.style?.gridColumn !== undefined)
      .map((node) => ({ column: node.props.style.gridColumn, text: nodeText(node) }))
      .filter((label) => label.text.length > 0);

    assert.ok(labels.length > 0, `[${locale}] the heatmap draws month labels`);

    // The drawn label must clear the previous one's rendered width. Recomputing
    // the width here as an approximation is the point: a test that reused the
    // component's own estimate could only ever agree with itself. The slot is the
    // narrowest column the grid can resolve — a 9px cell plus the 2px gutter; wider
    // windows only spread the columns further apart, so clearing this one clears them all.
    for (let index = 1; index < labels.length; index += 1) {
      const previous = labels[index - 1];
      const wide = /[\u4e00-\u9fff\uff00-\uff60]/.test(previous.text);
      const charWidth = wide ? 11 : 5.72;
      const occupiedThrough = previous.column + Math.ceil((previous.text.length * charWidth) / 11);
      assert.ok(
        labels[index].column >= occupiedThrough,
        `[${locale}] ${labels[index].text} at column ${labels[index].column} clears ${previous.text}, which reaches ${occupiedThrough}`,
      );
    }
  }
});

test('every month label sits over the column that holds the month first day', () => {
  const payload = payloadYear();
  const registrations = new Map();
  const bundle = loadBundle(registrations);
  freshMount();
  // The Chinese names are two full-width characters, so a year of them fits without
  // a single drop — which is what makes "every month is labelled" assertable here.
  // (The English names are long enough that the collision rule does drop some; that
  // case is covered by its own test below.)
  const tree = renderPanel(registrations, {
    t: translateFrom(bundle.dictionaries, 'zh'),
    load: async () => ({ ok: true, json: async () => payload }),
    preloaded: payload,
  });

  const labels = tags(tree)
    .filter((node) => node.type === 'span' && node.props.style?.gridColumn !== undefined)
    .map((node) => node.props.style.gridColumn)
    .filter((column) => column !== undefined);

  // Expected columns, recomputed from the payload rather than from the layout
  // helper: a label drifts the moment the two disagree.
  const expected = firstColumnPerMonth(payload.days);
  const expectedColumns = [...expected.values()].sort((left, right) => left - right);
  assert.equal(labels.length, expectedColumns.length, `one label per month (${expectedColumns.length} months)`);

  for (const column of labels) {
    assert.ok(
      expectedColumns.includes(column),
      `column ${column} is where a month actually starts (${expectedColumns.join(', ')})`,
    );
  }
  for (let index = 1; index < labels.length; index += 1) {
    assert.ok(labels[index] > labels[index - 1], 'labels advance left to right');
  }
  assert.deepEqual(labels, expectedColumns, 'every month of the window is labelled at its own column');
});

test('long month names are dropped only where the collision rule requires it', () => {
  const payload = payloadYear();
  const registrations = new Map();
  const bundle = loadBundle(registrations);
  freshMount();
  const tree = renderPanel(registrations, {
    t: translateFrom(bundle.dictionaries, 'en'),
    load: async () => ({ ok: true, json: async () => payload }),
    preloaded: payload,
  });

  const labels = tags(tree)
    .filter((node) => node.type === 'span' && node.props.style?.gridColumn !== undefined)
    .map((node) => ({ column: node.props.style.gridColumn, text: nodeText(node) }))
    .filter((label) => label.text.length > 0);
  const expectedColumns = [...firstColumnPerMonth(payload.days).values()].sort((left, right) => left - right);

  // "September" is wider than a month's worth of columns, so English genuinely has
  // to drop labels — but only where the previous one would be printed over. Every
  // unlabelled month must be covered by the label before it.
  assert.ok(labels.length < expectedColumns.length, 'the en dictionary does drop labels');
  for (const column of expectedColumns) {
    if (labels.some((label) => label.column === column)) continue;
    const covering = labels.filter((label) => label.column < column).pop();
    assert.notEqual(covering, undefined, `a label precedes the dropped column ${column}`);
    const wide = /[\u4e00-\u9fff\uff00-\uff60]/.test(covering.text);
    const reach = covering.column + Math.ceil((covering.text.length * (wide ? 11 : 5.72)) / 11);
    assert.ok(
      reach > column,
      `the only reason column ${column} is unlabelled is that "${covering.text}" reaches ${reach}`,
    );
  }
});

test('the heatmap pads the head and the grid to whole weeks, keeping weekdays aligned', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);

  const all = tags(tree).filter((node) => node.type === 'div' && hasClass(node, 'usage-cell'));
  const hidden = all.filter((node) => node.props.style !== undefined && node.props.style.visibility === 'hidden');
  const real = all.filter((node) => node.props.onMouseEnter !== undefined);

  assert.equal(real.length, payload.days.length, 'exactly one hoverable cell per day');
  // Every column holds seven weekdays and no page of a year is left short.
  assert.equal(all.length % 7, 0, `the grid is a whole number of weeks (${all.length} cells)`);

  const headOffset = new Date(`${payload.days[0].day}T00:00:00Z`).getUTCDay();
  assert.ok(hidden.length >= headOffset, `at least ${headOffset} slot(s) pad the head`);
  assert.ok(all.length <= headOffset + payload.days.length + 6, 'padding never exceeds the head plus one partial week');
});

test('the heatmap labels each month above its first column', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);

  const labels = tags(tree).filter((node) => node.type === 'span' && node.props.style !== undefined && node.props.style.gridColumn !== undefined);
  const shown = labels.map(nodeText).filter((text) => text.length > 0);
  const expectedMonths = new Set(payload.days.map((row) => row.day.slice(0, 7))).size;
  assert.ok(shown.length >= expectedMonths - 1, `a label per month in range (${shown.length} vs ${expectedMonths})`);
  assert.ok(shown.length <= expectedMonths, 'no month is labelled twice');
});

test('the rendered language follows the translate function, not hidden state', () => {
  const payload = payloadSynthetic();
  const registrations = new Map();
  const bundle = loadBundle(registrations);
  freshMount();
  const component = registrations.get('main').component;

  const propsFor = (locale) => ({
    t: translateFrom(bundle.dictionaries, locale),
    load: async () => ({ ok: true, json: async () => payload }),
    preloaded: payload,
  });
  const labelsFor = (locale) => tags(component(propsFor(locale)))
    .filter((node) => node.type === 'span' && node.props.style?.gridColumn !== undefined)
    .map(nodeText)
    .filter((text) => text.length > 0);

  const chinese = labelsFor('zh');
  assert.ok(chinese.length > 0, 'month labels are drawn');
  assert.ok(
    chinese.some((label) => MONTH_NAMES_ZH.includes(label)),
    `a Chinese month name is drawn (saw ${JSON.stringify(chinese.slice(0, 3))})`,
  );

  // The framework re-derives this function on a language switch, so a changed
  // `t` alone must move the dates — no inject refresh and no extra state.
  rerender();
  const english = labelsFor('en');
  assert.ok(
    english.some((label) => MONTH_NAMES_EN.includes(label)),
    `an English dictionary draws English months (saw ${JSON.stringify(english.slice(0, 3))})`,
  );
  assert.ok(
    !english.some((label) => MONTH_NAMES_ZH.includes(label)),
    'no Chinese month name survives the switch',
  );
});

test('both dictionaries carry every month key', () => {
  const { dictionaries } = loadBundle(new Map());
  const dicts = dictionaries.get('usageStats');
  assert.ok(dicts !== undefined, 'the panel registers its namespace');
  for (const locale of ['zh', 'en']) {
    assert.ok(dicts[locale] !== undefined, `[${locale}] the dictionary is registered`);
    for (let month = 1; month <= 12; month += 1) {
      const value = dicts[locale][`months.${month}`];
      assert.ok(typeof value === 'string' && value.length > 0, `[${locale}] months.${month} is set`);
    }
  }
  // The probe that picks the language keys off the Chinese month character, so
  // the Chinese dictionary must actually carry it.
  assert.ok(dicts.zh['months.1'].includes('月'), 'the zh month name carries the probe character');
  assert.ok(!dicts.en['months.1'].includes('月'), 'the en month name does not');
});

test('the panel inject face carries what only the host closure knows', () => {
  const registrations = new Map();
  const { moduleExports } = loadBundle(registrations);
  assert.equal(typeof moduleExports.apply, 'function');

  const entry = registrations.get('main');
  assert.equal(entry.options.locale, 'usageStats', 'the panel declares its dictionary namespace');
  const face = entry.options.inject();
  assert.equal(typeof face.load, 'function', 'the data loader rides the inject face');
  // The inject face is deliberately free of language state: the framework builds
  // it once per registration, so a locale captured here would go stale.
  assert.equal(face.locale, undefined, 'no active locale is frozen into the inject face');
});

test('month labels are Chinese, under the zh dictionary the panel ships', () => {
  const payload = payloadSynthetic();
  const registrations = new Map();
  const bundle = loadBundle(registrations);
  freshMount();
  const props = {
    t: translateFrom(bundle.dictionaries, 'zh'),
    load: async () => ({ ok: true, json: async () => payload }),
    preloaded: payload,
  };
  const tree = renderPanel(registrations, props);

  const labels = tags(tree)
    .filter((node) => node.type === 'span' && node.props.style?.gridColumn !== undefined)
    .map(nodeText)
    .filter((text) => text.length > 0);

  assert.ok(labels.length > 0, 'the heatmap draws month labels');
  assert.ok(
    labels.some((label) => ['一月', '二月', '三月', '四月', '五月', '六月',
      '七月', '八月', '九月', '十月', '十一月', '十二月'].includes(label)),
    `a Chinese month name is drawn (saw ${JSON.stringify(labels.slice(0, 4))})`,
  );
  assert.ok(
    !labels.some((label) => MONTH_NAMES_EN.includes(label)),
    'no English month name is drawn',
  );
});

test('the panel lifts the theme border weight and derives its own caption tone', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const nodes = tags(renderWith(payload).tree);
  const css = nodes.find((node) => node.type === 'style').props.children[0];

  // The theme's first two border weights are tuned for its chrome, not for a full
  // page of cards, and on the light theme they go nearly invisible:
  // --dsw-alias-border-l1 is #0000000a there against a white card on a white page.
  // The panel therefore starts one step up the theme's own ramp.
  assert.match(
    css,
    /\.usage-panel\s*\{[^}]*--usage-border:\s*var\(--dsw-alias-border-l3\)/,
    "the panel starts at the theme's third border weight",
  );
  assert.match(
    css,
    /\.usage-panel\s*\{[^}]*--usage-border-strong:\s*var\(--dsw-alias-border-l4\)/,
    'and pairs it with the fourth',
  );
  // Text has no such step: every caption tone the theme ships sits at or above
  // --dsw-alias-label-secondary (#61666b on white, about 5.8:1), which is washed out
  // across a dense dashboard. This one local therefore stays derived from the label
  // colour, and it is the only one left to override.
  assert.match(
    css,
    /\.usage-panel\s*\{[^}]*--usage-label-2:\s*color-mix\(in oklab, var\(--dsw-alias-label-primary\)/,
    'the panel derives its own secondary-label colour',
  );
  // The override is keyed on the attribute the theme plugin actually sets — not on
  // prefers-color-scheme, which would be wrong for a user who picked dark on a light
  // OS.
  assert.match(
    css,
    /body\[data-ds-dark-theme\] \.usage-panel\s*\{[^}]*--usage-label-2:\s*var\(--dsw-alias-label-secondary\)/,
    'the dark theme restores the theme label tone',
  );

  // Both locals are actually consumed: every rule that used to read the theme token
  // directly now reads the panel's own, or the light theme would still be faint.
  assert.ok(
    !/\.usage-card\s*\{[^}]*var\(--dsw-alias-border-l1\)/.test(css),
    'cards use the panel border rather than the theme token',
  );
  assert.ok(
    (css.match(/var\(--usage-border\)/g) ?? []).length >= 8,
    'the panel border is what the card, table and divider rules read',
  );
  assert.ok(
    (css.match(/var\(--usage-label-2\)/g) ?? []).length >= 10,
    'the secondary label colour is read by the captions and axis rules',
  );
});

test('the heatmap divides the card width between its columns and stays square', () => {
  const payload = payloadYear();
  const nodes = tags(renderWith(payload).tree);

  const stylesheet = nodes.find((node) => node.type === 'style');
  const css = stylesheet.props.children[0];

  assert.match(
    css,
    /\.usage-heat-wrap\s*\{[^}]*position:\s*relative/,
    'the readout container is positioned, or the tooltip anchors to an outer ancestor',
  );
  assert.match(css, /\.usage-heat\s*\{[^}]*gap:\s*2px/, 'heatmap cells sit in a 2px gutter');
  // The tracks divide the card instead of sitting at a fixed 9px: a year of columns
  // at the old pitch stopped ~330px short of the card's right edge. The 9px floor is
  // what a narrow window falls back to, and the row scrolls rather than shrinking.
  assert.match(
    css,
    /\.usage-heat\s*\{[^}]*grid-template-rows:\s*repeat\(7,\s*auto\)/,
    'a column is seven content-sized cells tall',
  );
  assert.match(css, /\.usage-heat\s*\{[^}]*justify-content:\s*start/, 'the tracks start at the left edge');
  assert.ok(
    !/\.usage-cell\s*\{[^}]*width/.test(css),
    'the cell takes its width from the track instead of setting its own',
  );
  // Square by construction: the tracks divide the card's width, so a fixed cell
  // height would leave the grid shorter than its own pitch.
  assert.match(
    css,
    /\.usage-cell\s*\{[^}]*aspect-ratio:\s*1/,
    'a cell is square, whatever width its track resolved to',
  );
  // A transform-origin percentage resolves against the SVG viewport without this,
  // which would grow the bars from the wrong edge.
  assert.match(
    css,
    /\.usage-bar\s*\{[^}]*transform-box:\s*fill-box/,
    'the bar grow animation is anchored to each bar, not the viewport',
  );

  // The month strip is its own grid, so nothing but a shared track declaration makes
  // it agree with the grid above: both are selected together, both read the column
  // count from the wrap's custom property, and both keep the same gutter and floor.
  assert.match(
    css,
    /\.usage-heat-months,\s*\n?\.usage-heat\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--usage-columns\),\s*minmax\(9px,\s*1fr\)\)/,
    'the strip and the cell grid take one shared, width-dividing track declaration',
  );
  assert.match(
    css,
    /\.usage-heat-scroll\s*\{[^}]*overflow-x:\s*auto/,
    'a column set too narrow to fit scrolls instead of shrinking',
  );

  const head = new Date(`${payload.days[0].day}T00:00:00Z`).getUTCDay();
  const columns = Math.ceil((head + payload.days.length) / 7);
  const wrap = nodes.find((node) => hasClass(node, 'usage-heat-wrap'));
  assert.equal(
    wrap.props.style['--usage-columns'],
    String(columns),
    'the wrap publishes the column count both grids are laid out on',
  );
});

test('the panel renders the headline cards and the model table from real data', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);

  const classes = tags(tree).map((node) => node.props.className).filter((value) => typeof value === 'string');
  assert.ok(classes.some((value) => value.includes('usage-card')), 'renders headline cards');
  assert.ok(classes.some((value) => value.includes('usage-heat')), 'renders the heatmap grid');
  assert.ok(classes.some((value) => value.includes('usage-table')), 'renders the model table');

  const text = textOf(tree);
  assert.ok(text.includes('todayTokens'), 'shows the daily-token card');
  assert.ok(text.includes('allTokens'), 'shows the cumulative-token card');
  assert.ok(text.includes('cacheRate'), 'shows the cache-rate card');
  // The table follows the range control, so it lists the models billed inside the
  // active window rather than every model the corpus ever saw. Each named model
  // still has to be one the payload actually reports.
  const named = payload.routes.filter((route) => text.includes(route.model));
  assert.ok(named.length > 0, 'the table names at least one model from the payload');
  for (const route of named) {
    assert.ok(
      payload.routes.some((entry) => entry.model === route.model && entry.provider === route.provider),
      `the table only names models the payload carries (${route.model})`,
    );
  }
});

test('the breakdown table groups by provider, drops cache write, and caps its height', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const nodes = tags(renderWith(payload).tree);

  const css = nodes.find((node) => node.type === 'style').props.children[0];
  // The corpus only grows, so an unbounded table pushes the diagnostics below it
  // off the page; the scroll box is what keeps them reachable.
  assert.match(css, /\.usage-table-scroll\s*\{[^}]*max-height:\s*\d+px/, 'the table is height-capped');
  assert.match(css, /\.usage-table-scroll\s*\{[^}]*overflow-y:\s*auto/, 'the capped table scrolls itself');
  assert.match(css, /\.usage-table-scroll \.usage-table thead th\s*\{[^}]*position:\s*sticky/, 'the header sticks while it scrolls');

  const scroll = nodes.find((node) => hasClass(node, 'usage-table-scroll'));
  assert.notEqual(scroll, undefined, 'the table is wrapped in its scroll box');

  // Cache write is gone from both the header and the body.
  const headers = tags(scroll).filter((node) => node.type === 'th').map(nodeText);
  assert.equal(headers.filter((text) => text === 'colCacheWrite').length, 0, 'no cache-write column header');
  assert.ok(headers.includes('colCacheRead'), 'the cache-read column stays');
  assert.ok(headers.includes('colTotal'), 'the total column stays');

  // One tbody per provider, each headed by a single spanning cell naming it, and
  // the models that provider actually ran underneath.
  const groups = tags(scroll).filter((node) => node.type === 'tbody');
  const window = payload.trend.days.slice(-7);
  const ranged = payload.trend.routes.filter((route) => route.days.some((row) => (
    window.includes(row.day)
    && (row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens) > 0
  )));
  const providers = [...new Set(ranged.map((route) => route.provider))];
  assert.equal(groups.length, providers.length, 'one group per provider billed in the window');

  for (const group of groups) {
    const rows = tags(group).filter((node) => node.type === 'tr');
    const head = rows[0];
    const spanning = tags(head).filter((node) => node.type === 'th' && node.props.colSpan !== undefined);
    assert.equal(spanning.length, 1, 'the group is headed by one spanning cell');
    const provider = providers.find((name) => nodeText(spanning[0]).includes(name));
    assert.notEqual(provider, undefined, `the group heading names its provider (${nodeText(spanning[0])})`);
    // The heading cell is the group's only non-model row; every model under it
    // belongs to that provider.
    const modelRows = rows.slice(1);
    assert.ok(modelRows.length > 0, `provider ${provider} lists at least one model`);
    assert.equal(modelRows.length, ranged.filter((route) => route.provider === provider).length,
      `every model of ${provider} appears in its own group`);
    for (const row of modelRows) {
      const model = nodeText(tags(row).find((node) => hasClass(node, 'usage-model')));
      assert.ok(
        ranged.some((route) => route.provider === provider && route.model === model),
        `${model} is a ${provider} model, listed under it`,
      );
    }
  }

  // The per-row provider subtitle is gone: the heading says it once for the group.
  assert.equal(
    tags(scroll).filter((node) => hasClass(node, 'usage-card-label')).length, 0,
    'the provider is no longer repeated under every model',
  );
});

test('the header carries the title and Refresh, and nothing else', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);

  const head = tags(tree).find((node) => hasClass(node, 'usage-head'));
  assert.ok(head !== undefined, 'the header renders');
  const buttons = tags(head).filter((node) => node.type === 'button');
  assert.equal(buttons.length, 1, 'Refresh is the header\'s only control');
  assert.equal(nodeText(buttons[0]), 'refresh');

  // The panel still describes the whole corpus: no workspace selector, and the one
  // view control it now has (the trend window) lives with the chart it changes.
  assert.equal(tags(tree).filter((node) => node.type === 'select').length, 0, 'no workspace selector');
  assert.equal(tags(head).filter((node) => node.props.role === 'tab').length, 0, 'no range control in the header');

  const title = tags(tree).find((node) => hasClass(node, 'usage-title'));
  assert.ok(title !== undefined, 'the header renders its title');
  assert.equal(nodeText(title), 'panel');
});

test('the range control sits above the sections it drives and redraws all three', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const bars = (nodes) => nodes.filter((node) => node.type === 'rect' && hasClass(node, 'usage-bar')).length;
  const tabs = (nodes) => nodes.filter((node) => node.props.role === 'tab');
  const slices = (nodes) => nodes.filter((node) => node.type === 'circle' && typeof node.props.strokeDasharray === 'string').length;

  const { registrations, props } = renderWith(payload);

  // One walk per render pass: the stub advances each component's hook cursor as it
  // walks, so walking the same tree twice would read the next hook slots.
  rerender();
  const first = tags(renderPanel(registrations, props));
  const firstTabs = tabs(first);
  assert.equal(firstTabs.length, 3, 'three windows are offered');
  assert.deepEqual(firstTabs.map((tab) => tab.props['aria-selected']), ['true', 'false', 'false'], 'the 7-day window opens selected');
  assert.deepEqual(firstTabs.map(nodeText), ['range7', 'range30', 'rangeAll'], 'the segments are 7 days, 30 days, and the whole window');
  assert.equal(first.filter((node) => node.props.role === 'tablist').length, 1, 'the segments form one tablist');
  assert.equal(tabs(first)[0].props.type, 'button', 'a segment is a real button');
  assert.equal(bars(first), payload.days.slice(-7).length * 2, 'the default window plots 7 days');

  // The control rides its own bar, above the three sections it drives — not the
  // trend title row, which no longer carries any control.
  const bar = first.find((node) => hasClass(node, 'usage-range-bar'));
  assert.notEqual(bar, undefined, 'the control has its own bar');
  assert.equal(tags(bar).filter((node) => node.props.role === 'tab').length, 3, 'the bar holds the segments');
  assert.ok(textOf(bar).includes('rangeLabel'), 'the bar is labelled');
  const heads = first.filter((node) => hasClass(node, 'usage-section-head'));
  assert.equal(heads.length, 0, 'the trend title row no longer carries a control');

  // The control's bar precedes the group it drives, and that group holds the trend,
  // the ring, and the table — so the window it picks reaches all three.
  const body = first.find((node) => hasClass(node, 'usage-body'));
  const children = body.props.children.filter((child) => child !== null && child !== undefined);
  const barIndex = children.findIndex((child) => hasClass(child, 'usage-range-bar') || String(child.props?.className ?? '').includes('usage-range-bar'));
  const groupIndex = children.findIndex((child) => String(child.props?.className ?? '').includes('usage-ranged'));
  assert.ok(barIndex !== -1, 'the control bar is a child of the body');
  assert.ok(groupIndex !== -1, 'the driven sections are grouped');
  assert.ok(barIndex < groupIndex, 'the control sits above the group it drives');
  const group = children[groupIndex];
  const groupText = textOf(group);
  assert.ok(groupText.includes('dailyTrend'), 'the group holds the trend section');
  assert.ok(groupText.includes('byModel'), 'the group holds the ring section');
  assert.ok(groupText.includes('breakdown'), 'the group holds the table section');

  // Each segment points at that one panel, and the panel points back at the
  // active segment. One panel is switched in place, so all segments name it.
  const panel = first.find((node) => node.props.role === 'tabpanel');
  assert.notEqual(panel, undefined, 'the driven sections live in a tabpanel');
  assert.deepEqual(
    firstTabs.map((tab) => tab.props['aria-controls']),
    [panel.props.id, panel.props.id, panel.props.id],
    'every segment controls the panel that is actually rendered',
  );
  assert.equal(panel.props['aria-labelledby'], firstTabs[0].props.id, 'the panel is named by the selected segment');

  // The ring reads the same window as the chart: the wider window brings in more
  // models than a week does, so the slice count follows the selection too.
  const weekSlices = slices(first);
  const weekModels = payload.trend.routes.filter((route) => (
    route.days.some((row) => payload.trend.days.slice(-7).includes(row.day))
  )).filter((route) => route.days.some((row) => row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens > 0)).length;
  assert.equal(weekSlices, weekModels, 'the ring plots the models billed in the selected window');

  // Click the 30-day segment. The stub does not re-render on a state change, so the
  // next explicit render pass reads the new state, exactly like the hover tests.
  firstTabs[1].props.onClick();
  rerender();
  const second = tags(renderPanel(registrations, props));
  assert.equal(bars(second), payload.days.slice(-30).length * 2, 'the 30-day segment redraws a wider chart');
  assert.deepEqual(
    tabs(second).map((tab) => tab.props['aria-selected']),
    ['false', 'true', 'false'],
    'the selection moved to the 30-day segment',
  );
  assert.ok(slices(second) >= weekSlices, 'the wider window cannot lose models, only gain them');

  // The third segment is the payload's whole window. It is what keeps an old
  // one-off model reachable: a model that only ran outside every shorter window
  // would otherwise never appear in the ring or the table at all.
  firstTabs[2].props.onClick();
  rerender();
  const whole = tags(renderPanel(registrations, props));
  const allRoutes = payload.trend.routes.filter((route) => route.days.some((row) => (
    row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens > 0
  )));
  assert.equal(slices(whole), allRoutes.length, 'the whole window plots every model the payload billed');
  assert.ok(allRoutes.length >= weekSlices, 'the whole window is a superset of the week');
  assert.equal(bars(whole), payload.days.length * 2, 'the whole window plots every day');
  assert.deepEqual(
    tabs(whole).map((tab) => tab.props['aria-selected']),
    ['false', 'false', 'true'],
    'the selection moved to the whole window',
  );

  // Back to the week for the keyboard walk below.
  tabs(whole)[0].props.onClick();
  rerender();

  // The arrow keys walk the tablist and take the focus with them, so the roving
  // tabindex never leaves focus on a segment that dropped out of the tab order.
  // The fake list mirrors the real child order — an aria-hidden indicator first,
  // then the segments — because a handler that indexes `children` instead of
  // querying the tabs focuses the wrong node, and a fake without the span hides it.
  const focused = [];
  const tablistFor = (list) => {
    const children = list.props.children;
    const focusable = (child) => child.props !== undefined && child.props.role === 'tab';
    const record = (child) => (focusable(child) ? nodeText(child) : 'indicator');
    return {
      children: children.map((child) => ({ focus: () => focused.push(record(child)) })),
      querySelectorAll: (selector) => (selector === '[role="tab"]'
        ? children.filter(focusable).map((child) => ({ focus: () => focused.push(record(child)) }))
        : []),
    };
  };
  const keyEvent = (key, list) => ({ key, preventDefault() {}, currentTarget: tablistFor(list) });

  const secondList = second.find((node) => node.props.role === 'tablist');
  secondList.props.onKeyDown(keyEvent('ArrowLeft', secondList));
  assert.deepEqual(focused, ['range7'], 'ArrowLeft moves the focus to the selected segment');

  rerender();
  const third = tags(renderPanel(registrations, props));
  assert.equal(bars(third), payload.days.slice(-7).length * 2, 'ArrowLeft redraws the narrower window');
  assert.deepEqual(
    tabs(third).map((tab) => tab.props['aria-selected']),
    ['true', 'false', 'false'],
    'ArrowLeft moved the selection back to 7 days',
  );

  // The handlers are per-render, so the walk with 7 days selected owns the next keys.
  const thirdList = third.find((node) => node.props.role === 'tablist');
  thirdList.props.onKeyDown(keyEvent('ArrowRight', thirdList));
  thirdList.props.onKeyDown(keyEvent('ArrowUp', thirdList));
  thirdList.props.onKeyDown(keyEvent('End', thirdList));
  assert.deepEqual(focused, ['range7', 'range30', 'rangeAll'], 'arrow and end keys move; other keys are ignored');
});

test('switching the range drops a hover that the new window no longer holds', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { registrations, props } = renderWith(payload);

  // Hover a column that only exists in the wider window, then switch to 7 days.
  rerender();
  const wide = tags(renderPanel(registrations, props));
  const wideTabs = wide.filter((node) => node.props.role === 'tab');
  wideTabs[1].props.onClick();
  rerender();
  const wideWindow = tags(renderPanel(registrations, props));
  const svg = wideWindow.find((node) => node.type === 'svg' && node.props.onMouseMove !== undefined);
  hover(svg, 'onMouseMove', { clientX: 640, clientY: 100 });
  assert.ok(
    wideWindow.filter((node) => hasClass(node, 'usage-needle')).length === 0,
    'the needle appears on the next render, not the current one',
  );

  rerender();
  const hovered = tags(renderPanel(registrations, props));
  const hoveredIndex = hovered.filter((node) => hasClass(node, 'usage-needle'));
  assert.equal(hoveredIndex.length, 1, 'the needle is drawn while a wide-window column is hovered');
  assert.equal(hovered.filter((node) => hasClass(node, 'usage-tip')).length, 1, 'and so is its readout');
  const needleX = Number(hoveredIndex[0].props.x1);
  assert.ok(needleX > 400, `the hover sits well into the wound-back column (x=${needleX})`);

  rerender();
  const switched = tags(renderPanel(registrations, props));
  switched.filter((node) => node.props.role === 'tab')[0].props.onClick();
  rerender();
  const after = tags(renderPanel(registrations, props));

  assert.equal(
    after.filter((node) => node.type === 'rect' && hasClass(node, 'usage-bar')).length,
    payload.days.slice(-7).length * 2,
    'the 7-day window is drawn',
  );
  assert.equal(after.filter((node) => hasClass(node, 'usage-needle')).length, 0, 'no needle is left behind off the plot');
  assert.equal(after.filter((node) => hasClass(node, 'usage-marker')).length, 0, 'no marker is left behind either');
  assert.equal(after.filter((node) => hasClass(node, 'usage-tip')).length, 0, 'the readout goes with the column it described');
});

test('the trend chart stacks input and output per day and bars the cache rate', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);

  // The range control opens on its narrow window, and the chart plots that many
  // trailing days — a sparse corpus is shorter than the window and plots in full.
  const days = payload.days.slice(-7);
  assert.ok(days.length >= 2, 'the fixture spans a plottable window');

  const bars = tags(tree).filter((node) => node.type === 'rect' && hasClass(node, 'usage-bar'));
  assert.equal(bars.length, days.length * 2, 'one input and one output bar per day');

  // Each day's pair is stacked: the higher bar sits directly on the lower one.
  for (let index = 0; index < days.length; index += 1) {
    const [lower, upper] = bars.slice(index * 2, index * 2 + 2);
    assert.equal(lower.props.x, upper.props.x, 'a stack shares one column');
    assert.equal(lower.props.width, upper.props.width, 'a stack shares one width');
    const lowerBottom = Number(lower.props.y) + Number(lower.props.height);
    assert.ok(
      Math.abs(lowerBottom - Number(upper.props.y)) < 0.001
        || Math.abs(Number(upper.props.y) + Number(upper.props.height) - Number(lower.props.y)) < 0.001,
      'the two bars of a day touch rather than overlap',
    );
  }
  // Columns advance left to right, one pair per day in day order.
  const columns = bars.filter((unused, index) => index % 2 === 0).map((bar) => Number(bar.props.x));
  for (let index = 1; index < columns.length; index += 1) {
    assert.ok(columns[index] > columns[index - 1], 'bars advance in day order');
  }
  // The two stacks differ in colour, or input and output are indistinguishable.
  // The colour is painted through the style, so that a `var()` reference resolves.
  assert.notEqual(
    bars[0].props.style.fill,
    bars[1].props.style.fill,
    'input and output carry different colours',
  );

  // The ratio is a bar of its own, one per day that billed input — no longer a
  // smoothed line, so no path is drawn on this chart at all.
  assert.equal(
    tags(tree).filter((node) => node.type === 'path').length,
    0,
    'the chart draws no line any more',
  );
  const ratioBars = tags(tree).filter((node) => node.type === 'rect' && hasClass(node, 'usage-cache-bar'));
  const billedDays = days.filter((row) => (
    (row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens) > 0
  ));
  assert.equal(ratioBars.length, billedDays.length, 'one ratio bar per day that billed input');
  for (const bar of ratioBars) {
    assert.equal(
      bar.props.style.fill,
      'var(--dsw-alias-state-warn-secondary)',
      'the ratio bar wears the theme amber',
    );
    // It grows out of the baseline like every other bar on the chart.
    assert.ok(
      Math.abs(Number(bar.props.y) + Number(bar.props.height) - (12 + (240 - 12 - 26))) < 0.001,
      'the ratio bar stands on the plot baseline',
    );
    // Its height is the ratio against the fixed 0..100% right axis.
    const ratio = Number(bar.props.height) / (240 - 12 - 26);
    assert.ok(ratio >= 0 && ratio <= 1, `the ratio stays inside 0..100% (${ratio})`);
  }

  // The ratio bar is wider than the token stack it backs, but never so wide that
  // neighbouring days merge.
  const stackWidth = Number(bars[0].props.width);
  for (const bar of ratioBars) {
    const width = Number(bar.props.width);
    assert.ok(width > stackWidth, 'the ratio bar is wider than the input/output stack');
    assert.ok(width <= (720 - 52 - 56) / days.length, 'the ratio bars of adjacent days never touch');
  }

  // The ratio bar is drawn before the stacks, so the stacks sit on top of it.
  const order = tags(tree).filter((node) => node.type === 'rect');
  const firstRatio = order.findIndex((node) => hasClass(node, 'usage-cache-bar'));
  const firstStack = order.findIndex((node) => hasClass(node, 'usage-bar'));
  assert.ok(firstRatio !== -1 && firstStack !== -1, 'both marks are drawn');
  assert.ok(firstRatio < firstStack, 'the ratio is the backdrop, not an overlay');

  // Both axes are labelled: tokens on the left, percentages on the right.
  const labelText = textOf(tags(tree).find((node) => hasClass(node, 'usage-section') && textOf(node).includes('dailyTrend')));
  assert.ok(/%/.test(labelText), 'the right axis is labelled with percentages');

  const legend = tags(tree).filter((node) => hasClass(node, 'usage-trend-key'));
  assert.equal(legend.length, 3, 'the legend names input, output, and the cache rate');
  const kinds = legend.map((node) => node.props['data-kind']);
  assert.deepEqual(kinds, ['bar', 'bar', 'bar'], 'every trend mark is a bar, so every swatch is one too');
});

test('the ratio bar stays inside its 0..100% axis and never covers the stack', () => {
  // A window with a long dead stretch between the billing days, where the old
  // smoothed line used to fold back on itself.
  const payload = payloadGapTrend();
  const { tree } = renderWith(payload);
  const nodes = tags(tree);

  // The right axis is fixed at 0..100% and its labels sit 3px below their
  // gridline, so the two labels give the y of the domain ceiling and floor.
  const percentLabels = nodes.filter((node) => (
    node.type === 'text' && node.props.textAnchor === 'start' && /%$/.test(nodeText(node))
  ));
  const tickOf = (text) => {
    const label = percentLabels.find((node) => nodeText(node) === text);
    assert.notEqual(label, undefined, `the right axis labels ${text}`);
    return Number(label.props.y) - 3;
  };
  const ceiling = tickOf('100.0%');
  const floor = tickOf('0.0%');
  assert.ok(floor > ceiling, 'the ratio domain runs from the 100% tick down to the 0% tick');

  const ratioBars = nodes.filter((node) => node.type === 'rect' && hasClass(node, 'usage-cache-bar'));
  assert.ok(ratioBars.length > 0, 'the ratio is drawn as bars');
  for (const bar of ratioBars) {
    const top = Number(bar.props.y);
    const bottom = top + Number(bar.props.height);
    // A bar is monotone by construction, so the old fold-back is impossible;
    // what still has to hold is that it never leaves its own axis.
    assert.ok(
      top >= ceiling - 0.01 && bottom <= floor + 0.01,
      `the ratio bar stays inside the axis (${top}..${bottom} vs ${ceiling}..${floor})`,
    );
  }

  // Bars do not stack with the token columns: the stack shares its column with
  // the ratio, and the ratio is wider, so any overlap would hide the stack.
  const stacks = nodes.filter((node) => node.type === 'rect' && hasClass(node, 'usage-bar'));
  assert.ok(stacks.length > 0, 'the token stacks are drawn');
  const drawn = nodes.filter((node) => node.type === 'rect');
  assert.ok(
    drawn.findIndex((node) => hasClass(node, 'usage-cache-bar')) < drawn.findIndex((node) => hasClass(node, 'usage-bar')),
    'the ratio bar is painted first, so the stacks read on top of it',
  );
});

test('the trend chart no longer draws a line per model', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);

  const named = textOf(tree);
  // Route ids left the trend chart; the donut and the table below still carry them.
  const trendSection = tags(tree).filter((node) => (
    hasClass(node, 'usage-section') && nodeText(node).includes('dailyTrend')
  ));
  assert.equal(trendSection.length, 1, 'the trend section renders once');
  const trendText = textOf(trendSection[0]);
  for (const route of payload.routes.slice(0, 3)) {
    assert.ok(
      !trendText.includes(route.model) || route.model === 'unknown',
      `the trend chart does not name the model ${route.model}`,
    );
  }
  assert.ok(named.length > 0, 'the panel still renders');
});

test('the model donut renders one slice per route billed in the selected window', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);

  // The ring follows the range control, so it plots the routes billed inside the
  // 7-day default — not every route the corpus ever saw. Recomputed from the
  // payload's own series rather than from the component's choice of window.
  const window = payload.trend.days.slice(-7);
  const ranged = payload.trend.routes.filter((route) => route.days.some((row) => (
    window.includes(row.day)
    && (row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens) > 0
  )));
  assert.ok(ranged.length > 0, 'the fixture bills something inside the default window');
  assert.ok(
    ranged.length <= payload.routes.length,
    'the window can only narrow the ring, never widen it beyond the corpus',
  );

  const circles = tags(tree).filter((node) => node.type === 'circle' && typeof node.props.strokeDasharray === 'string');
  assert.equal(circles.length, ranged.length, 'one slice per route with tokens in the window');
  for (const circle of circles) {
    assert.equal(circle.props.fill, 'none');
    assert.match(circle.props.strokeDasharray, /^[\d.]+ [\d.]+$/, 'each slice is a dash on a shared circle');
  }

  const centre = tags(tree).filter((node) => hasClass(node, 'usage-donut-center-number'));
  assert.equal(centre.length, 1, 'the donut has one centre figure');

  const rows = tags(tree).filter((node) => hasClass(node, 'usage-donut-row'));
  assert.equal(rows.length, ranged.length, 'every route in the window appears in the donut legend');

  // Shares render as percentages, ordered from largest to smallest.
  const shares = tags(tree).filter((node) => hasClass(node, 'usage-donut-share')).map(nodeText);
  assert.equal(shares.length, ranged.length);
  for (const share of shares) {
    assert.match(share, /^\d+(\.\d+)?%$/, `share reads as a percentage (saw ${share})`);
  }
  const numbers = shares.map((share) => Number.parseFloat(share));
  assert.deepEqual(numbers.slice().sort((left, right) => right - left), numbers, 'ordered by share, largest first');
});

test('the donut ring keeps its own size instead of stretching to the card', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const nodes = tags(renderWith(payload).tree);

  const css = nodes.find((node) => node.type === 'style').props.children[0];
  // The shared .usage-svg rule sets width:100%, so the ring needs its own cap; the
  // grid track that holds it is that cap, and the two read the same constant.
  assert.match(
    css,
    /\.usage-donut\s*\{[^}]*grid-template-columns:\s*260px\s+minmax\(0,\s*1fr\)/,
    'the ring track is a fixed 260px, so the shared full-width svg rule cannot stretch it',
  );

  const svg = nodes.find((node) => node.props.viewBox === '0 0 260 260');
  assert.notEqual(svg, undefined, 'the ring is drawn on its own 260px viewBox');
  assert.equal(
    svg.props.className,
    'usage-svg',
    'the ring still uses the shared svg class, so the cap has to come from the track',
  );
});

test('the donut and its legend sit side by side, the legend divided rather than boxed', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const nodes = tags(renderWith(payload).tree);

  const css = nodes.find((node) => node.type === 'style').props.children[0];
  // A two-column grid is what makes it a side-by-side layout; the ring keeps its
  // own fixed track and the legend takes whatever is left.
  assert.match(
    css,
    /\.usage-donut\s*\{[^}]*grid-template-columns:\s*260px\s+minmax\(0,\s*1fr\)/,
    'the ring and the legend are two columns of one row',
  );
  assert.match(css, /\.usage-donut\s*\{[^}]*align-items:\s*center/, 'the legend is centred against the ring');
  // Narrow cards drop back to one column rather than squeezing the legend flat.
  assert.match(
    css,
    /@media \(max-width: 720px\) \{ \.usage-donut \{ grid-template-columns: minmax\(0, 1fr\)/,
    'a narrow card stacks the ring above the legend',
  );

  const donut = nodes.find((node) => hasClass(node, 'usage-donut'));
  assert.notEqual(donut, undefined, 'the donut renders its layout wrapper');
  const children = tags(donut).filter((node) => node.props.className === 'usage-donut-wrap' || hasClass(node, 'usage-donut-legend'));
  assert.equal(children.length, 2, 'the wrapper holds exactly the ring box and the legend');

  // Entries are separated by a rule between them, not by a box around each: the
  // first row must not draw a top border, or the legend opens with a stray line.
  assert.match(css, /\.usage-donut-row\s*\{[^}]*border-top:\s*1px solid/, 'rows are divided by a rule');
  assert.match(css, /\.usage-donut-row:first-child\s*\{\s*border-top:\s*none/, 'the first row carries no divider');
  // The old share bar is gone: the divider separates entries instead.
  assert.equal(tags(donut).filter((node) => hasClass(node, 'usage-donut-track')).length, 0, 'no share bar is drawn');

  // A row carries the name, its share, and the token count — nothing else.
  const rows = tags(donut).filter((node) => hasClass(node, 'usage-donut-row'));
  assert.ok(rows.length > 0, 'the legend has rows');
  for (const row of rows) {
    const cells = tags(row).filter((node) => node.props.className !== undefined && String(node.props.className).startsWith('usage-'));
    const kinds = cells.map((node) => node.props.className);
    assert.ok(kinds.includes('usage-donut-name'), 'a row names its model');
    assert.ok(kinds.includes('usage-donut-share'), 'a row carries its share');
    assert.ok(kinds.includes('usage-donut-tokens'), 'a row carries its token count');
  }
});

test('the cache-rate card shows an em dash when no input was ever reported', () => {
  const payload = payloadSynthetic();
  for (const row of payload.days) {
    row.inputTokens = 0;
    row.cacheReadTokens = 0;
    row.cacheWriteTokens = 0;
  }
  payload.today = { ...payload.today, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  payload.totals = { ...payload.totals, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  const { tree } = renderWith(payload);
  assert.ok(textOf(tree).includes('\u2014'), 'an absent denominator renders as an em dash, not 0%');
});

test('an empty corpus renders the empty state rather than a blank panel', () => {
  const payload = payloadSynthetic();
  const today = payload.today.day;
  payload.days = [{ day: today, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }];
  payload.totals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  payload.routes = [];
  payload.trend = { days: [], routes: [] };
  payload.today = { day: today, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  const { tree } = renderWith(payload);
  assert.ok(textOf(tree).includes('noData'), 'shows the empty-state message');
});

test('the seeding flag renders a progress indicator', () => {
  const payload = payloadSynthetic();
  payload.seeding = true;
  const { tree } = renderWith(payload);
  const classes = tags(tree).map((node) => node.props.className).filter((value) => typeof value === 'string');
  assert.ok(classes.some((value) => value.includes('usage-progress')), 'shows the seeding progress bar');
  assert.ok(classes.some((value) => value.includes('usage-body')), 'renders the body alongside it');
});

test('a clean corpus shows no diagnostic line at all', () => {
  const payload = payloadSynthetic();
  const { tree } = renderWith(payload);
  const classes = tags(tree).map((node) => node.props.className).filter((value) => typeof value === 'string');
  assert.ok(!classes.some((value) => value.includes('usage-stage-note')), 'stays quiet when nothing is wrong');
});

test('unreadable and recovered sessions are reported, with their reasons', () => {
  const payload = payloadSynthetic();
  payload.warnings = {
    malformedUsageEvents: 0,
    sessionsScanned: 25,
    sessionsFailed: 2,
    recoveredSessions: 3,
    failureReasons: [{ key: 'legacy', reason: 'format v0 is unsupported', count: 2, example: 'session-x' }],
  };
  const { tree } = renderWith(payload);

  const text = textOf(tree);
  assert.ok(text.includes('sessionsFailed'), 'reports unreadable sessions');
  assert.ok(text.includes('sessionsRecovered'), 'reports sessions recovered from a legacy format');
  assert.ok(text.includes('format v0 is unsupported'), 'names the failure reason');
  assert.ok(text.includes('x2') || text.includes('\u00d72'), 'repeats a shared reason once with its count');
});

test('a failing load surfaces an error instead of a blank panel', async () => {
  const registrations = new Map();
  loadBundle(registrations);
  freshMount();

  const load = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const props = { t: (key) => key, locale: 'en', load };
  renderPanel(registrations, props);
  const cleanups = hookState.effects.map((effect) => effect());
  await settle();

  const failedState = hookState.values.find((value) => value !== null && typeof value === 'object' && value.status === 'error');
  assert.ok(failedState !== undefined, 'a non-ok response moves the panel to the error state');
  assert.equal(failedState.message, '500', 'the HTTP status is carried through');

  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
});

test('a rejected fetch also lands in the error state with the failure text', async () => {
  const registrations = new Map();
  loadBundle(registrations);
  freshMount();

  const load = async () => {
    throw new Error('network down');
  };
  const props = { t: (key) => key, locale: 'en', load };
  renderPanel(registrations, props);
  const cleanups = hookState.effects.map((effect) => effect());
  await settle();

  const failedState = hookState.values.find((value) => value !== null && typeof value === 'object' && value.status === 'error');
  assert.ok(failedState !== undefined, 'a thrown fetch moves the panel to the error state');
  assert.ok(failedState.message.includes('network down'), 'the message is carried through');

  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
});

test('a successful fetch moves the panel from loading to ready', async () => {
  const payload = payloadSynthetic();
  const registrations = new Map();
  loadBundle(registrations);
  freshMount();

  const load = async () => ({ ok: true, json: async () => payload });
  renderPanel(registrations, { t: (key) => key, locale: 'en', load });
  const cleanups = hookState.effects.map((effect) => effect());
  await settle();

  const readyState = hookState.values.find((value) => value !== null && typeof value === 'object' && value.status === 'ready');
  assert.ok(readyState !== undefined, 'a successful fetch yields a ready state');
  assert.equal(readyState.payload.revision, payload.revision);

  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
});

test('the panel polls every 5 seconds and clears the interval on unmount', () => {
  const payload = payloadSynthetic();
  const registrations = new Map();
  loadBundle(registrations);
  freshMount();

  const intervals = [];
  const cleared = [];
  const previousSet = globalThis.setInterval;
  const previousClear = globalThis.clearInterval;
  globalThis.setInterval = (callback, delay) => {
    intervals.push(delay);
    return intervals.length;
  };
  globalThis.clearInterval = (id) => {
    cleared.push(id);
  };

  try {
    renderPanel(registrations, { t: (key) => key, locale: 'en', load: async () => ({ ok: true, json: async () => payload }) });
    const cleanup = hookState.effects.map((effect) => effect())[0];

    assert.equal(intervals.length, 1, 'one polling interval');
    assert.equal(intervals[0], 5000, 'polls every 5 seconds');
    assert.equal(typeof cleanup, 'function', 'the effect returns a cleanup');

    cleanup();
    assert.deepEqual(cleared, [1], 'the interval is cleared on unmount');
  } finally {
    globalThis.setInterval = previousSet;
    globalThis.clearInterval = previousClear;
  }
});

test('a same-revision poll keeps the previous state object so React can skip the render', async () => {
  const payload = payloadSynthetic();
  const registrations = new Map();
  loadBundle(registrations);
  freshMount();

  // A fresh object on every poll, exactly as a refetch would produce.
  const load = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(payload)) });

  const ticks = [];
  const holds = [];
  const previousSet = globalThis.setInterval;
  const previousClear = globalThis.clearInterval;
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  globalThis.setInterval = (callback, delay) => {
    ticks.push({ callback, delay });
    return ticks.length;
  };
  globalThis.clearInterval = () => {};
  // The minimum-loading hold also needs a stub, or its real timer would both
  // leak past the test and delay the spinner check.
  globalThis.setTimeout = (callback, delay) => {
    holds.push({ callback, delay });
    return holds.length;
  };
  globalThis.clearTimeout = () => {};

  try {
    renderPanel(registrations, { t: (key) => key, locale: 'en', load });
    const cleanup = hookState.effects.map((effect) => effect())[0];
    await settle();
    for (const hold of holds) hold.callback();

    // The panel's ready/loading state object; located by shape so the assertion
    // does not depend on the panel's hook ordering.
    const stateOf = () => hookState.values.find((value) => (
      value !== null && typeof value === 'object' && (value.status === 'ready' || value.status === 'loading')
    ));
    const afterForcedPoll = stateOf();
    assert.equal(afterForcedPoll?.status, 'ready', 'the forced poll lands on a ready state');

    // The steady-state poll is NOT forced, so an unchanged revision must keep
    // the existing state object and let React skip the re-render entirely.
    ticks[0].callback();
    await settle();
    assert.equal(stateOf(), afterForcedPoll, 'the object identity is preserved for an unchanged revision');

    if (typeof cleanup === 'function') cleanup();
  } finally {
    globalThis.setInterval = previousSet;
    globalThis.clearInterval = previousClear;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
});

/**
 * The minimum-loading hold is exercised by the loader-driven tests above, which
 * go through the same `finish()` path. Driving it from a click would need the
 * stub to re-render on state change, which this harness deliberately does not do.
 */
test('Refresh is the only control outside the trend window', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);
  const buttons = tags(tree).filter((node) => node.type === 'button');
  assert.deepEqual(
    buttons.map((node) => node.props.role ?? 'none'),
    ['none', 'tab', 'tab', 'tab'],
    'the panel offers Refresh and the three range windows, nothing else',
  );
  const refresh = buttons[0];
  assert.equal(nodeText(refresh), 'refresh');
  assert.equal(refresh.props.type, 'button');
  assert.equal(typeof refresh.props.onClick, 'function');
});
test('every chart element exposes a hover readout handle', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);

  const cells = tags(tree).filter((node) => node.type === 'div' && hasClass(node, 'usage-cell') && node.props.onMouseEnter !== undefined);
  assert.ok(cells.length > 0, 'heatmap cells are hoverable');

  const slices = tags(tree).filter((node) => node.type === 'circle' && node.props.onMouseEnter !== undefined);
  assert.ok(slices.length > 0, 'donut slices are hoverable');

  const svg = tags(tree).find((node) => node.type === 'svg' && node.props.onMouseMove !== undefined);
  assert.ok(svg !== undefined, 'the trend chart tracks the pointer');

  assert.equal(tags(tree).filter((node) => hasClass(node, 'usage-tip')).length, 0, 'the readout starts hidden');
});

test('hovering a heatmap cell shows that day and nothing else', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { registrations, props } = renderWith(payload);

  rerender();
  const tree = renderPanel(registrations, props);
  const cell = tags(tree).find((node) => node.type === 'div' && hasClass(node, 'usage-cell') && node.props.onMouseEnter !== undefined);
  hover(cell, 'onMouseEnter');

  rerender();
  const hovered = renderPanel(registrations, props);
  const tips = tags(hovered).filter((node) => hasClass(node, 'usage-tip'));
  assert.equal(tips.length, 1, 'exactly one readout is shown');

  const text = textOf(tips[0]);
  assert.ok(text.includes('tokens'), 'the readout reports a token total');
  assert.ok(text.includes('input') && text.includes('output'), 'the readout breaks out input and output');
  assert.ok(text.includes('cacheRate'), 'the readout reports a cache rate');
  assert.ok(text.includes('calls'), 'the readout reports the request count');
  assert.ok(tips[0].props.style.left.endsWith('px') && tips[0].props.style.top.endsWith('px'), 'the readout is positioned');
});

test('hovering a donut slice reports that model and its share', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { registrations, props } = renderWith(payload);

  rerender();
  const tree = renderPanel(registrations, props);
  const slice = tags(tree).filter((node) => node.type === 'circle' && node.props.onMouseEnter !== undefined)[0];
  hover(slice, 'onMouseEnter', { clientX: 30, clientY: 30 });

  rerender();
  const hovered = renderPanel(registrations, props);
  const tips = tags(hovered).filter((node) => hasClass(node, 'usage-tip'));
  assert.equal(tips.length, 1, 'exactly one readout is shown');
  const text = textOf(tips[0]);
  assert.ok(text.includes('share'), 'the readout reports the share');
  assert.ok(text.includes('provider'), 'the readout names the provider');
});

test('hovering the trend chart reports input, output, total, and the cache rate', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { registrations, props } = renderWith(payload);

  rerender();
  const tree = renderPanel(registrations, props);
  const svg = tags(tree).find((node) => node.type === 'svg' && node.props.onMouseMove !== undefined);
  hover(svg, 'onMouseMove', { clientX: 400, clientY: 100 });

  rerender();
  const hovered = renderPanel(registrations, props);
  const tips = tags(hovered).filter((node) => hasClass(node, 'usage-tip'));
  assert.equal(tips.length, 1, 'exactly one readout is shown');

  const text = textOf(tips[0]);
  assert.ok(text.includes('input'), 'the readout breaks out the input tokens');
  assert.ok(text.includes('output'), 'the readout breaks out the output tokens');
  assert.ok(text.includes('colTotal'), 'the readout totals the day');
  assert.ok(text.includes('cacheRate'), 'the readout reports the cache rate');
  assert.ok(text.includes('cacheRead'), 'the readout names the cache reads the bars leave out');
  assert.ok(!text.includes('colCacheRead'), 'the cache read is not stacked into the bars');
});

test('the heatmap readout prints token values in units, not in full digits', () => {
  // A fixture with corpus-sized days: the point of the change only shows up once a
  // value is long enough that the full digits are unreadable.
  const payload = payloadGapTrend();
  const { registrations, props } = renderWith(payload);

  rerender();
  const tree = renderPanel(registrations, props);
  const cell = tags(tree).find((node) => node.type === 'div' && hasClass(node, 'usage-cell') && node.props.onMouseEnter !== undefined);
  hover(cell, 'onMouseEnter');

  rerender();
  const tip = tags(renderPanel(registrations, props)).find((node) => hasClass(node, 'usage-tip'));
  const text = textOf(tip);

  // The first hoverable cell is the window's first day.
  const day = payload.days[0];
  assert.ok(day.inputTokens > 0 && day.cacheReadTokens > 0, 'the fixture day carries usage');
  assert.ok(text.includes('40.6M'), `the day total is compacted, got: ${text}`);
  assert.ok(text.includes('500K'), 'the input tokens are compacted');
  assert.ok(text.includes('100K'), 'the output tokens are compacted');
  assert.ok(text.includes('40.0M'), 'the cache read is compacted');
  for (const value of [day.inputTokens, day.outputTokens, day.cacheReadTokens]) {
    assert.ok(
      !text.includes(value.toLocaleString()),
      `the full figure ${value} is no longer printed`,
    );
  }
  // The request count is a count, not a magnitude, so it stays a plain integer.
  assert.equal(day.calls, 1);
  assert.ok(text.includes('calls 1'), 'the request count is still printed exactly');
});

test('the trend readout prints token values in units, not in full digits', () => {
  const payload = payloadGapTrend();
  const { registrations, props } = renderWith(payload);

  rerender();
  const tree = renderPanel(registrations, props);
  const svg = tags(tree).find((node) => node.type === 'svg' && node.props.onMouseMove !== undefined);
  hover(svg, 'onMouseMove', { clientX: 400, clientY: 100 });

  rerender();
  const tip = tags(renderPanel(registrations, props)).find((node) => hasClass(node, 'usage-tip'));
  const text = textOf(tip);

  // Whichever column the pointer landed on, every token figure in the readout is a
  // magnitude with a unit suffix…
  assert.ok(/\d+(?:\.\d+)?[KMBT]\b/.test(text), `the readout shows a unit, got: ${text}`);
  // …and no day's token figure is printed in full any more.
  for (const row of payload.days) {
    for (const value of [row.inputTokens, row.outputTokens, row.cacheReadTokens]) {
      if (value <= 0) continue;
      assert.ok(
        !text.includes(value.toLocaleString()),
        `the full figure ${value} is no longer printed`,
      );
    }
  }
  // The cache rate is a percentage, and stays one.
  assert.ok(/%/.test(text), 'the cache rate is still a percentage');
});

test('a pointer moving inside the heatmap keeps the readout the cell published', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { registrations, props } = renderWith(payload);

  rerender();
  // One walk: the stub advances hook cursors as it walks, so a second walk of the
  // same tree would hand back a different instance's handlers and hide the bug.
  const nodes = tags(renderPanel(registrations, props));
  const cell = nodes.find((node) => node.type === 'div' && hasClass(node, 'usage-cell') && node.props.onMouseEnter !== undefined);
  const scroller = nodes.find((node) => hasClass(node, 'usage-heat-scroll'));
  assert.notEqual(scroller, undefined, 'the grid scrolls inside a tracking container');

  // One gesture, two handlers: the cell's mouseenter publishes the day and the
  // container's mousemove follows it. The readout must survive the second event —
  // reading its lines out of the render closure there published an empty list and
  // left an empty box floating over the grid.
  hover(cell, 'onMouseEnter', { clientX: 40, clientY: 60 });
  hover(scroller, 'onMouseMove', { clientX: 44, clientY: 63 });

  rerender();
  const tip = tags(renderPanel(registrations, props)).find((node) => hasClass(node, 'usage-tip'));
  assert.notEqual(tip, undefined, 'the readout is still on screen');
  const text = textOf(tip);
  assert.ok(text.includes('tokens'), 'the readout still carries the day totals');
  assert.ok(text.includes('input') && text.includes('output'), 'the readout still breaks out input and output');
  assert.ok(text.includes('cacheRate'), 'the readout still carries the cache rate');
  assert.equal(tip.props.style.left, '56px', 'the readout followed the pointer (44 + 12)');
});

test('the activity heatmap carries no legend', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const nodes = tags(renderWith(payload).tree);

  assert.ok(nodes.some((node) => hasClass(node, 'usage-heat')), 'the heatmap renders');
  assert.equal(nodes.filter((node) => hasClass(node, 'usage-legend')).length, 0, 'no less/more legend anywhere in the panel');
});

test('no two trend x-axis labels print on top of each other', () => {
  // The newest day is always labelled and can land a single slot after the tick
  // before it, which is where the axis used to smear into "9月20日9月22日".
  const payload = payloadGapTrend();
  const { tree } = renderWith(payload);

  const ticks = tags(tree)
    .filter((node) => node.type === 'text' && node.props.textAnchor === 'middle')
    .map((node) => ({ x: Number(node.props.x), text: nodeText(node) }));
  assert.ok(ticks.length >= 2, 'the axis is labelled');
  assert.equal(ticks[ticks.length - 1].text, shortDayText(payload.days[payload.days.length - 1].day), 'the newest day is named');

  // Independent width estimate at the axis font size (10px): a full-width glyph is
  // one em, everything else about half. Two centred labels clear each other when
  // their centres are at least half of each width apart.
  const widthOf = (text) => [...text].reduce((sum, character) => (
    sum + (/[\u4e00-\u9fff\uff00-\uff60]/.test(character) ? 10 : 5.2)
  ), 0);
  for (let index = 1; index < ticks.length; index += 1) {
    const gap = ticks[index].x - ticks[index - 1].x;
    const needed = (widthOf(ticks[index - 1].text) + widthOf(ticks[index].text)) / 2;
    assert.ok(
      gap >= needed,
      `${ticks[index - 1].text} and ${ticks[index].text} clear each other (${gap.toFixed(1)}px apart, need ${needed.toFixed(1)}px)`,
    );
  }
  for (let index = 1; index < ticks.length; index += 1) {
    assert.ok(ticks[index].x > ticks[index - 1].x, 'ticks advance in day order');
  }
});

/** The "Sep 22" style label the chart prints for one day key.
 *
 * `renderWith` passes the identity translate function, whose month probe reads as
 * English, so the panel formats its dates in `en-US`. */
function shortDayText(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

test('the donut readout sits in the box its offsets are measured from', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { registrations, props } = renderWith(payload);

  // Hover a slice, then walk once and inspect where the readout landed in the tree.
  rerender();
  const before = tags(renderPanel(registrations, props));
  const slice = before.find((node) => node.type === 'circle' && node.props.onMouseEnter !== undefined);
  assert.notEqual(slice, undefined, 'the donut has a hoverable slice');
  hover(slice, 'onMouseEnter', { clientX: 30, clientY: 30 });

  rerender();
  const nodes = tags(renderPanel(registrations, props));
  const readout = nodes.find((node) => hasClass(node, 'usage-tip'));
  assert.notEqual(readout, undefined, 'the readout is shown');

  // The slice and legend handlers measure from `.usage-section`, so the readout has
  // to be positioned against that box as well. `.usage-donut-wrap` is itself
  // `position: relative`: a readout nested inside it is offset by the distance
  // between the two boxes and jumps the moment the pointer moves within the wrap.
  const wrap = nodes.find((node) => hasClass(node, 'usage-donut-wrap'));
  assert.notEqual(wrap, undefined, 'the donut renders its wrap');
  assert.equal(
    tags(wrap).some((node) => hasClass(node, 'usage-tip')),
    false,
    'the readout is not nested in the donut wrap',
  );
});

/** Find every mounted component pool's non-null hook values (test diagnostics). */
function poolSnapshot() {
  return hookState.records.map((record, index) => (
    `${index}:[${record.pool.values.map((value) => (
      value === null ? 'null' : typeof value
    )).join(',')}]`
  ));
}

/**
 * The readout is rendered only when a chart reports a pointer position, so an
 * untouched panel never shows one. Clearing on leave is the same code path in
 * reverse and is covered by the hover tests above.
 */
test('no readout is rendered before any hover', () => {
  const payload = payloadFromRealLogs() ?? payloadSynthetic();
  const { tree } = renderWith(payload);
  assert.equal(tags(tree).filter((node) => hasClass(node, 'usage-tip')).length, 0, 'the panel starts with no readout');
});

/**
 * A payload whose heatmap window is far wider than its corpus.
 *
 * This is the shape the real Host serves: the heatmap asks for a year so sparse
 * activity stays in context, while the per-model views begin at the first settled
 * day. Harnesses that set `from` to the corpus start cannot tell the two windows
 * apart — which is how "the trend silently drew a year of empty columns" slipped
 * through once already.
 */
function payloadShortCorpusInLongWindow() {
  const tzOffsetMinutes = 0;
  const aggregate = emptyAggregate();
  const events = [];
  // The corpus is three days near the END of a year-long heatmap window.
  for (let index = 0; index < 3; index += 1) {
    events.push({
      type: 'assistant/message',
      seq: index + 1,
      time: Date.UTC(2026, 11, 10 + index, 12),
      data: {
        usage: {
          inputTokens: 100_000 + index * 10_000,
          outputTokens: 20_000 + index * 1_000,
          cacheReadTokens: 9_000_000 + index * 100_000,
          cacheWriteTokens: 0,
        },
      },
    });
  }
  foldSessionIntoAggregate(aggregate, { events, inheritedEventCount: 0, sessionId: 'short', cwd: '/tmp/short' }, { tzOffsetMinutes });
  return buildPayload(aggregate, {
    revision: 9,
    seeding: false,
    tzOffsetMinutes,
    from: '2026-01-01',
    to: '2026-12-12',
    today: '2026-12-12',
    telemetry: { sessionsScanned: 1, sessionsFailed: 0 },
  });
}

test('the trend plots the corpus window, not the heatmap year', () => {
  const payload = payloadShortCorpusInLongWindow();
  // The fixture is only meaningful if the two windows really differ.
  assert.equal(payload.days.length, 346, 'the heatmap window spans the year');
  assert.deepEqual(
    payload.trend.days,
    ['2026-12-10', '2026-12-11', '2026-12-12'],
    'the per-model window starts at the first settled day',
  );

  const bars = (nodes) => nodes.filter((node) => node.type === 'rect' && hasClass(node, 'usage-bar'));
  const { registrations, props } = renderWith(payload);

  // Default 7-day range: a corpus shorter than the window plots in full.
  rerender();
  const first = tags(renderPanel(registrations, props));
  assert.equal(
    bars(first).length,
    payload.trend.days.length * 2,
    'the trend plots three days, not a week of mostly-empty columns',
  );

  // "All": the trend must stop at the corpus's first day. Comparing against the
  // heatmap length is the point — equal counts would mean the year leaked in.
  const tabs = first.filter((node) => node.props.role === 'tab');
  const allTab = tabs.find((node) => nodeText(node) === 'rangeAll');
  assert.notEqual(allTab, undefined, 'the all-window segment is offered');
  allTab.props.onClick();
  rerender();
  const whole = tags(renderPanel(registrations, props));
  assert.equal(
    bars(whole).length / 2,
    payload.trend.days.length,
    'the all-window trend plots exactly the corpus days',
  );
  assert.notEqual(
    bars(whole).length / 2,
    payload.days.length,
    'the heatmap year is never what the trend plots',
  );

  // The x axis must open on a real day rather than on the window's leading edge.
  const tickLabels = tags(whole)
    .filter((node) => node.type === 'text' && node.props.textAnchor === 'middle')
    .map(nodeText);
  assert.ok(tickLabels.length > 0, 'the axis is labelled');
  assert.equal(tickLabels[0], shortDayText('2026-12-10'), 'the axis opens on the corpus first day');
  assert.equal(tickLabels[tickLabels.length - 1], shortDayText('2026-12-12'), 'and ends on the last day');
});
