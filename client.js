/**
 * Browser half of the usage-statistics plugin.
 *
 * Contributes a sidebar entry plus the whole-page dashboard it opens. Data comes
 * from the plugin's own Host Fetch route, so this module needs only the Slot API
 * and the locale service.
 *
 * The page is a report, not a filter console: it always describes the whole
 * corpus. The only control is Refresh, so nothing here can silently hide data.
 *
 * Plain JavaScript by design: an installed client bundle receives React from the
 * browser module table and needs no build step (see the decoration template in
 * the cordis-plugin-development skill).
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-usage-stats",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Document-relative form of the Host route this bundle fetches. */
    const DATA_URL = "api/usage-statistics.data";
    /** Locale namespace owned by this plugin. */
    const NS = "usageStats";
    /** Panel id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = "usage";
    /** How often the open panel asks the Host for a newer revision. */
    const POLL_MS = 5000;
    /**
     * Heatmap window requested from the Host: a year of activity.
     *
     * This is the *payload* window, not the trend's. The trend, ring and breakdown
     * read the corpus's own span out of it, so asking for a year keeps the heatmap
     * honest without padding the per-model views.
     */
    const WINDOW_DAYS = 371;
    /** Minimum spinner lifetime on refresh, so it never flashes. */
    const MIN_LOADING_MS = 300;
    /**
     * Windows offered by the range control, in display order, and the one it opens
     * with. The narrow window is the default: it is the window a reader wants when
     * the corpus is fresh, and the wider ones are a click away.
     *
     * `days: null` is the payload's whole window. It is not a nicety: a corpus can be
     * worked in bursts, and a model that ran once six weeks ago is otherwise
     * unreachable from the ring and the breakdown table — the only place its calls,
     * cache rate and total are ever shown. Any set of windows narrower than the
     * payload's own span makes part of the corpus permanently invisible.
     *
     * The control is not the trend chart's own: it selects the window every
     * per-model view reads — the trend, the ring, and the breakdown table — so all
     * three can never disagree about the period they describe. Switching is view
     * state only: the payload always carries the whole window, so a switch never
     * refetches.
     */
    const TREND_RANGES = [
      { days: 7, key: "w7", label: "range7" },
      { days: 30, key: "w30", label: "range30" },
      { days: null, key: "all", label: "rangeAll" },
    ];
    /** The range the control selects on first render. */
    const TREND_DAYS = 7;
    /**
     * The segment key for one range, or the first option's when the range matches
     * none of them. The panel's `aria-labelledby` and the segment ids are built from
     * this rather than from the day count, which is null for the whole window.
     * @param {number|null} days - the active range.
     * @returns {string} the matching option key.
     */
    function rangeKeyOf(days) {
      const option = TREND_RANGES.find((entry) => entry.days === days);
      return (option ?? TREND_RANGES[0]).key;
    }
    /** Id stem tying the range segments to the group of sections they switch. */
    const TREND_TAB_ID = "usage-range";
    /**
     * The one panel every segment switches, and the sections it holds. The ring and
     * the breakdown table are inside it, because they read the same window: a
     * control that moved the trend alone would leave the three views describing
     * different periods with no sign that they had drifted apart.
     */
    const TREND_PANEL_ID = "usage-range-panel";
    /**
     * Line/donut colours, in fixed order, so a route keeps its colour across views.
     *
     * Four of the six read the theme's own ramp; the theme ships no violet and no
     * sky-cyan, so the fourth and sixth slots keep local values — folding them onto
     * its blue would leave two neighbouring routes wearing the same colour. Being
     * `var()` references rather than values, these can only be painted through a
     * style (see the charts), never through an SVG presentation attribute.
     */
    const SERIES_COLORS = [
      "var(--dsw-static-blue-450)",
      "var(--dsw-static-green-400)",
      "var(--dsw-static-amber-500)",
      "#b06ef5",
      "var(--dsw-static-red-400)",
      "#38bdf8",
    ];
    /**
     * The cache-hit ratio's own colour, the theme's warm amber.
     *
     * It is deliberately not a member of SERIES_COLORS: those colour the ring's
     * slices by position, so reusing an index here would silently recolour a slice.
     * The colour is opaque on purpose — how far it is allowed to show through the
     * grid is the stylesheet's single `opacity` on `.usage-cache-bar`, so the two
     * cannot multiply into a bar nobody can see.
     */
    const CACHE_COLOR = "var(--dsw-alias-state-warn-secondary)";

    //#region formatting

    /** Compact token count: 1234 -> "1.2K". */
    function compact(value) {
      if (!Number.isFinite(value) || value <= 0) return "0";
      if (value < 1000) return String(Math.round(value));
      const units = ["K", "M", "B", "T"];
      let scaled = value;
      let unit = -1;
      while (scaled >= 1000 && unit < units.length - 1) {
        scaled /= 1000;
        unit += 1;
      }
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${units[unit]}`;
    }

    /** Exact token count with thousands separators. */
    function exact(value) {
      if (!Number.isFinite(value)) return "0";
      return Math.round(value).toLocaleString();
    }

    /** Cache hit rate, or null when no input was ever reported. */
    function cacheRate(buckets) {
      if (buckets === undefined || buckets === null) return null;
      const input =
        (buckets.inputTokens ?? 0) +
        (buckets.cacheReadTokens ?? 0) +
        (buckets.cacheWriteTokens ?? 0);
      if (input <= 0) return null;
      return (buckets.cacheReadTokens ?? 0) / input;
    }

    /** "92.4%" for a ratio, or an em dash when there is no denominator. */
    function percent(ratio) {
      return ratio === null ? "\u2014" : `${(ratio * 100).toFixed(1)}%`;
    }

    /** Billed input plus every output bucket. */
    function total(buckets) {
      if (buckets === undefined || buckets === null) return 0;
      return (
        (buckets.inputTokens ?? 0) +
        (buckets.outputTokens ?? 0) +
        (buckets.cacheReadTokens ?? 0) +
        (buckets.cacheWriteTokens ?? 0)
      );
    }

    /**
     * Bind a translate function to one language's dictionary, for reading a value
     * out of it rather than rendering copy.
     * @param {object} dict - the language's dictionary.
     * @returns {(key: string) => string} a lookup that returns the key when absent.
     */
    function dictionaryTranslate(dict) {
      return (key) =>
        Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    }

    /**
     * The formatting language behind a translated string.
     *
     * The framework hands a namespace-bound `t` to every slot component and never
     * the active locale id, and it re-derives `t` on each locale switch — so the
     * dictionaries themselves are the one read surface that is both available and
     * current. Probing one key for the Chinese month character is enough: `zh` and
     * `en` are the only registered dictionaries, and their key sets are identical.
     * @param {(key: string) => string} t - the slot's translate function.
     * @returns {'zh'|'en'} the language to format dates in.
     */
    function localeFromTranslate(t) {
      try {
        return String(t("months.1")).includes("\u6708") ? "zh" : "en";
      } catch (error) {
        return "en";
      }
    }

    /** Parse a `YYYY-MM-DD` key into plain numbers without any UTC reinterpretation. */
    function parseDay(day) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
      if (match === null) return null;
      return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
      };
    }

    /** The local Date of a `YYYY-MM-DD` key. */
    function dateOf(day) {
      const parts = parseDay(day);
      if (parts === null) return null;
      return new Date(parts.year, parts.month - 1, parts.day);
    }

    /** Day of week (0 = Sunday) for a `YYYY-MM-DD` key. */
    function weekdayOf(day) {
      const date = dateOf(day);
      return date === null ? 0 : date.getDay();
    }

    /** ISO week key `YYYY-Www` of a `YYYY-MM-DD` key. */
    function weekKeyOf(day) {
      const parts = parseDay(day);
      if (parts === null) return day;
      const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
      // Shift to the Thursday of this ISO week; its year is the ISO week-year.
      const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
      date.setUTCDate(date.getUTCDate() + 4 - weekday);
      const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const week = Math.ceil(
        ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
      );
      return `${date.getUTCFullYear()}-W${week < 10 ? `0${week}` : week}`;
    }

    /** `YYYY-MM` month key of a `YYYY-MM-DD` key. */
    function monthKeyOf(day) {
      return day.slice(0, 7);
    }

    /**
     * Heatmap cell geometry.
     *
     * The stylesheet below interpolates these numbers, and the month strip is laid
     * out from the same slot, so the labels and the cells cannot drift apart.
     */
    const CELL_PX = 9;
    const CELL_GAP_PX = 2;
    /**
     * Space between the month strip and the cell grid. They are two sibling grids
     * inside the scroller, so the wrap's flex gap never reaches between them; the
     * strip's own bottom margin is the only thing that separates the two.
     */
    const MONTH_GAP_PX = 8;
    /**
     * One heatmap column's narrowest pitch: a cell plus the gutter that follows it.
     *
     * The tracks themselves divide the card's width and grow past this figure, but
     * the month strip's collision guard is written against it: a label that fits
     * this pitch fits every wider one, so the guard can only ever drop a label that
     * a wider column would have drawn anyway.
     */
    const CELL_SLOT = CELL_PX + CELL_GAP_PX;
    /** The donut's viewBox edge; the rendered ring stops at this size. */
    const DONUT_PX = 260;

    /** The 11px label font: CJK and fullwidth forms are square, Latin is roughly half. */
    const WIDE_CHAR =
      /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
    /** Font size of the heatmap's month strip and of a trend x-axis tick. */
    const LABEL_EM = 11;
    const AXIS_EM = 10;
    /** Latin runs at roughly half a CJK glyph's width at the same size. */
    const NARROW_RATIO = 0.52;

    /**
     * Approximate rendered width of a label at one font size. A wide character is
     * one em, everything else about half of one.
     * @param {string} label - the text.
     * @param {number} em - the font size in px.
     * @returns {number} the width in px.
     */
    function estimateLabelWidth(label, em) {
      let width = 0;
      for (const character of label)
        width += WIDE_CHAR.test(character) ? em : em * NARROW_RATIO;
      return width;
    }

    /** Columns a label spans, given one column per `cell + gap` slot. */
    function labelColumns(label, slot, em = LABEL_EM) {
      // At least one: a label with no rendered width would otherwise let the next
      // one share its column (and its React key).
      return Math.max(1, Math.ceil(estimateLabelWidth(label, em) / slot));
    }

    /**
     * Place month labels one per month over the column that holds the month's
     * first day, dropping a label only when the previous one would run into it.
     *
     * Days run Sunday→Saturday inside a column and columns run in day order, so
     * walking the grid column by column is a chronological walk: the first day of
     * a month is found in the very column the label belongs over. (Reading only
     * each column's *first* day instead pushes the label a full column late
     * whenever a month starts mid-week — six days of drift on most boundaries.)
     *
     * The overlap guard is the previous label's rendered width, not a fixed column
     * count: a fixed count is simultaneously too strict for "May" and too lax for
     * "September", which is what let dense month runs overlap.
     * @param {(object|null)[][]} weeks - columns of seven cells, Sunday first.
     * @param {number} slot - one column's width in px, including its gutter.
     * @param {(monthIndex: number) => string} nameOf - month index to label.
     * @returns {{index: number, label: string}[]} labels in ascending column order.
     */
    function layoutMonthLabels(weeks, slot, nameOf) {
      const cells = [];
      let lastMonth = null;
      let occupiedThrough = -Infinity;
      for (let index = 0; index < weeks.length; index += 1) {
        for (const cell of weeks[index]) {
          if (cell === null) continue;
          const month = monthKeyOf(cell.day);
          if (month === lastMonth) continue;
          lastMonth = month;
          if (index < occupiedThrough) continue;
          const parts = parseDay(cell.day);
          if (parts === null) continue;
          const label = nameOf(parts.month - 1);
          cells.push({ index, label });
          occupiedThrough = index + labelColumns(label, slot);
        }
      }
      return cells;
    }

    /** Display label for a day key, e.g. "Jul 6, 2026". */
    function dayLabel(day, locale) {
      const date = dateOf(day);
      if (date === null) return day;
      return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }

    /**
     * A month's display name, taken from the panel's own dictionaries rather than
     * from `toLocaleDateString`. The `t` seat is re-derived by the renderer on
     * every locale switch with no memoized inject face in between, so dictionary
     * copy is the one language source that cannot go stale.
     * @param {number} monthIndex - 0-based month.
     * @param {(key: string) => string} t - the slot's translate function.
     * @returns {string} the month name.
     */
    function monthName(monthIndex, t) {
      return t(`months.${monthIndex + 1}`);
    }

    /** Display label for a `YYYY-MM` month key, e.g. "July 2026". */
    function monthLabel(month, locale) {
      const parts = parseDay(`${month}-01`);
      if (parts === null) return month;
      return new Date(parts.year, parts.month - 1, 1).toLocaleDateString(
        locale === "zh" ? "zh-CN" : "en-US",
        { year: "numeric", month: "long" },
      );
    }

    /** A short "Jul 6" style day label. */
    function shortDay(date, locale) {
      return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
        month: "short",
        day: "numeric",
      });
    }

    /**
     * The exact Monday–Sunday span of one ISO week key.
     * @param {string} weekKey - `YYYY-Www`.
     * @returns {{start: Date, end: Date}|null}
     */
    function weekSpan(weekKey) {
      const match = /^(\d{4})-W(\d{1,2})$/.exec(weekKey);
      if (match === null) return null;
      const year = Number(match[1]);
      const week = Number(match[2]);
      // ISO week 1 is the week containing January 4th.
      const jan4 = new Date(year, 0, 4);
      const weekday = jan4.getDay() === 0 ? 7 : jan4.getDay();
      const week1Monday = new Date(year, 0, 4 - (weekday - 1));
      const start = new Date(week1Monday);
      start.setDate(start.getDate() + (week - 1) * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return { start, end };
    }

    /** Display label for an ISO week key plus its exact start and end days. */
    function weekRangeLabel(weekKey, locale) {
      const span = weekSpan(weekKey);
      if (span === null) return weekKey;
      return `${shortDay(span.start, locale)} \u2013 ${shortDay(span.end, locale)}`;
    }

    /** Sum a list of day rows into one bucket set. */
    function sumRows(rows) {
      const result = {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      for (const row of rows) {
        result.calls += row.calls ?? 0;
        result.inputTokens += row.inputTokens ?? 0;
        result.outputTokens += row.outputTokens ?? 0;
        result.cacheReadTokens += row.cacheReadTokens ?? 0;
        result.cacheWriteTokens += row.cacheWriteTokens ?? 0;
      }
      return result;
    }

    /**
     * The per-model rows for one trailing window, rebuilt from the payload's
     * per-route per-day series.
     *
     * The payload's own `routes` covers the whole corpus, which is what the
     * headline cards and the heatmap describe; the ring and the breakdown table
     * follow the range control instead, and this is where that window is applied.
     * Summing the daily buckets rather than scaling the totals keeps every figure
     * an exact count — nothing here is an estimate.
     * @param {{days: object[], routes: object[]}|undefined} trend - the payload series.
     * @param {number} range - the trailing window in days.
     * @param {object[]} fallback - rows to use when the payload carries no series.
     * @returns {object[]} route rows for the window, largest first.
     */
    function routesInRange(trend, range, fallback) {
      if (trend === undefined || trend === null || !Array.isArray(trend.routes))
        return fallback;
      // `trend.days` is a plain list of `YYYY-MM-DD` keys, not rows: the per-route
      // series beside it is what carries the buckets. A null range is the whole
      // payload window, which is what keeps an old one-off model reachable.
      const keys = trend.days ?? [];
      const keep = new Set(
        range === null || range === undefined
          ? keys
          : keys.slice(-Math.max(1, range)),
      );
      return trend.routes
        .map((route) => ({
          ...sumRows((route.days ?? []).filter((row) => keep.has(row.day))),
          provider: route.provider,
          model: route.model,
        }))
        .filter((route) => total(route) > 0)
        .sort((left, right) => total(right) - total(left));
    }

    /**
     * Intensity level 0-4 for one token total, ranked against the non-zero totals
     * in the window. Quantile ranking keeps one burst day from flattening the ramp.
     */
    function makeGrader(totals) {
      const nonZero = totals
        .filter((value) => value > 0)
        .sort((left, right) => left - right);
      if (nonZero.length === 0) return () => 0;
      const at = (fraction) =>
        nonZero[
          Math.min(
            nonZero.length - 1,
            Math.max(0, Math.floor(nonZero.length * fraction)),
          )
        ];
      const cuts = [at(0.25), at(0.5), at(0.75), at(0.95)];
      return (value) => {
        if (value <= 0) return 0;
        if (value <= cuts[0]) return 1;
        if (value <= cuts[1]) return 2;
        if (value <= cuts[2]) return 3;
        return 4;
      };
    }

    //#endregion

    //#region styles

    const CSS = `
/* The theme's first two border weights are tuned for its chrome, not for a full
   page of cards: --dsw-alias-border-l1 is #0000000a on the light theme (under 4%
   black) against a white card on a white page, so the card outlines and every table
   rule all but vanish. The panel therefore starts at the third weight and pairs it
   with the fourth — 12%/16% on light, 16%/20% on dark — which is the first pair that
   reads across a dense dashboard, and both still track whatever the theme does.
   Text has no such seam: --dsw-alias-label-secondary sits at #61666b on white
   (about 5.8:1) and is the darkest caption tone the theme ships — tertiary and
   caption are lighter still — so --usage-label-2 stays derived from the primary
   label colour, at roughly #525354 (7.6:1).
   That one local needs a dark override, written against body[data-ds-dark-theme]
   because that attribute is what the theme plugin actually sets — a
   prefers-color-scheme query would be wrong for a user who picked dark on a light
   OS. */
.usage-panel {
  --usage-border: var(--dsw-alias-border-l3);
  --usage-border-strong: var(--dsw-alias-border-l4);
  --usage-label-2: color-mix(in oklab, var(--dsw-alias-label-primary) 72%, transparent);
}
body[data-ds-dark-theme] .usage-panel {
  --usage-label-2: var(--dsw-alias-label-secondary);
}
.usage-panel {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.usage-panel * { box-sizing: border-box; }
/* Match the Plugins page measure: one centred 960px column. */
.usage-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 28px clamp(24px, 4vw, 48px) 48px;
}
.usage-inner > * { width: 100%; max-width: 960px; }
.usage-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.usage-title { font-size: 20px; font-weight: 500; line-height: 28px; margin: 0; }
.usage-intro { color: var(--usage-label-2); font-size: 13px; line-height: 20px; margin: 4px 0 0; }
.usage-btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--usage-border);
  border-radius: 8px;
  background: transparent;
  color: var(--usage-label-2);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.usage-btn:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.usage-btn:disabled { cursor: default; opacity: 0.6; }

.usage-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--usage-border);
  border-radius: 12px;
  padding: 16px 18px;
}
.usage-card-label { color: var(--usage-label-2); font-size: 12px; }
.usage-card-value { font-size: 28px; font-weight: 600; margin-top: 6px; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.usage-card-note { color: var(--usage-label-2); font-size: 11px; margin-top: 2px; font-variant-numeric: tabular-nums; }
.usage-mini { display: flex; flex-wrap: wrap; gap: 6px 22px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--usage-border); }
.usage-mini-item { display: flex; flex-direction: column; gap: 1px; }
.usage-mini-key { color: var(--usage-label-2); font-size: 11px; }
.usage-mini-val { font-size: 14px; font-variant-numeric: tabular-nums; }
.usage-metrics { display: grid; grid-template-columns: 1fr; gap: 12px; }
@media (min-width: 780px) { .usage-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } }

.usage-section {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--usage-border);
  border-radius: 12px;
  padding: 16px;
  position: relative;
}
.usage-section-title { font-size: 14px; font-weight: 500; margin: 0 0 14px; }
/* A section head that carries a control keeps the title's own bottom margin on the
   row, so the control and the title stay on one line. */
.usage-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.usage-section-head .usage-section-title { margin: 0; }
/* Range control, built like the app's own segmented control: one track with a
   sliding indicator and a roving tabindex over its segments. */
.usage-tabs {
  position: relative;
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 2px;
  flex: none;
  padding: 3px;
  border-radius: 9px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}
.usage-tab-indicator {
  position: absolute;
  top: 3px;
  left: 3px;
  width: calc((100% - 6px - 2px * (var(--usage-tab-count) - 1)) / var(--usage-tab-count));
  height: calc(100% - 6px);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-soft);
  transform: translate(calc(var(--usage-tab-index) * (100% + 2px)));
  transition: transform 160ms ease;
  pointer-events: none;
}
.usage-tab {
  position: relative;
  z-index: 1;
  height: 26px;
  padding: 0 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--usage-label-2);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
  transition: color 120ms ease;
}
.usage-tab:hover, .usage-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); }
.usage-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) { .usage-tabs, .usage-tab-indicator, .usage-tab { transition: none; } }
/* The range control stands on its own above the three sections it drives. It is a
   control row, not a card: no surface, no outline, just the label and the segments
   pushed to the edges of the column so it aligns with the cards below. */
.usage-range-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.usage-range-label { color: var(--usage-label-2); font-size: 12px; }

.usage-msg { color: var(--usage-label-2); padding: 20px 0; font-size: 12px; }
.usage-err { color: var(--dsw-alias-state-error-primary); padding: 8px 0; font-size: 12px; }

/* Day heatmap: compact GitHub-style grid with month labels above the columns. */
/* position:relative is load-bearing: the readout is absolutely positioned, and
   its offsets are measured from this element. Without it the readout anchors to
   some outer ancestor and lands nowhere near the pointer. */
.usage-heat-wrap { position: relative; display: flex; flex-direction: column; gap: 6px; }
/* The month strip and the cell grid are two separate grids, so they line up only
   by taking their tracks from this one declaration: same count, same gutter, same
   floor. The --usage-columns custom property carries the count in from the render.
   The tracks divide the card's width rather than sitting at a fixed ${CELL_SLOT}px,
   so the grid reaches the card's edges instead of leaving its right third empty;
   ${CELL_PX}px is the floor, and below it the row scrolls rather than shrinking. */
.usage-heat-months,
.usage-heat {
  display: grid;
  gap: ${CELL_GAP_PX}px;
  grid-template-columns: repeat(var(--usage-columns), minmax(${CELL_PX}px, 1fr));
  justify-content: start;
}
.usage-heat-months { color: var(--usage-label-2); font-size: ${LABEL_EM}px; line-height: 14px; margin-bottom: ${MONTH_GAP_PX}px; }
.usage-heat-months > span { white-space: nowrap; }
.usage-heat-scroll { padding-bottom: 2px; }
/* Seven weekdays per column, filled column by column. */
.usage-heat {
  grid-auto-flow: column;
  grid-template-rows: repeat(7, auto);
}
/* Square by construction: the height follows the track width, so a cell cannot
   disagree with the pitch it is laid out on. */
.usage-cell { aspect-ratio: 1; border-radius: 2px; background: var(--dsw-alias-state-idle-primary); }
/* Four steps off the theme's own blue ramp. Static tokens, so the scale cannot be
   repainted by a theme switch — it stays the same blue on light and dark. */
.usage-cell.l1 { background: var(--dsw-static-blue-100); }
.usage-cell.l2 { background: var(--dsw-static-blue-300); }
.usage-cell.l3 { background: var(--dsw-static-blue-450); }
.usage-cell.l4 { background: var(--dsw-static-blue-600); }
.usage-cell[data-hover="true"] { outline: 1.5px solid var(--dsw-alias-label-primary); outline-offset: 1px; }
.usage-legend { display: flex; align-items: center; gap: 5px; justify-content: flex-end; color: var(--usage-label-2); font-size: 11px; }

/* Charts share one floating readout, so a hover never shifts the layout. */
/* Every trend mark is a bar, so every legend swatch is a rectangle. */
.usage-trend-key[data-kind="bar"] .usage-dot { border-radius: 2px; }
/* Bars grow out of the baseline. transform-box: fill-box makes the percentage
   resolve against each rect's own box rather than the SVG viewport. The ratio bar
   uses a longer ease than the stack, because it is the backdrop the stack lands
   on: if it finished first the columns would appear to grow out of nothing. */
.usage-bar { transform-box: fill-box; transform-origin: bottom; transition: transform 320ms cubic-bezier(0.22, 0.61, 0.36, 1); }
.usage-cache-bar { transform-box: fill-box; transform-origin: bottom; transition: transform 420ms cubic-bezier(0.22, 0.61, 0.36, 1); opacity: 0.3; }
.usage-tip {
  position: absolute;
  z-index: 5;
  pointer-events: none;
  min-width: 132px;
  max-width: 300px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--usage-border-strong);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-shadow-lv3);
  font-size: 12px;
  line-height: 1.45;
}
.usage-tip-title { font-weight: 500; margin-bottom: 4px; }
.usage-tip-row { display: flex; align-items: baseline; gap: 8px; justify-content: space-between; white-space: nowrap; }
.usage-tip-key { color: var(--usage-label-2); display: inline-flex; align-items: center; gap: 2px; }
.usage-tip-val { font-variant-numeric: tabular-nums; }
.usage-tip-total { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--usage-border); }

.usage-svg { display: block; width: 100%; height: auto; }
.usage-trend-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 10px; }
.usage-trend-key { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--usage-label-2); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.usage-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
/* The label width estimator works in ems, so these sizes come from the constants
   it is driven by — a hand-typed size here would silently desync the guards. */
.usage-axis { fill: var(--usage-label-2); font-size: ${AXIS_EM}px; }
.usage-grid-line { stroke: var(--usage-border); stroke-width: 1; stroke-dasharray: 3 4; }
.usage-needle { stroke: var(--usage-border-strong); stroke-width: 1; }
.usage-marker { stroke: var(--dsw-alias-bg-layer-1); stroke-width: 1.5; }
/* The ring is sized here, not by the card: the shared .usage-svg rule stretches
   every chart to its container's width, which drew a 926px ring on a 960px card. */
.usage-donut-wrap { position: relative; width: ${DONUT_PX}px; max-width: 100%; margin: 0 auto; }
.usage-donut-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
.usage-donut-center-number { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.usage-donut-center-unit { font-size: 11px; color: var(--usage-label-2); }
/* Ring and legend side by side: the ring gets a fixed track, the legend takes the
   rest of the card. Below the breakpoint they fall back to a single column, ring
   first. */
.usage-donut {
  padding: 0 64px;
  display: grid;
  grid-template-columns: ${DONUT_PX}px minmax(0, 1fr);
  gap: 64px;
  align-items: center;
}
@media (max-width: 720px) { .usage-donut { grid-template-columns: minmax(0, 1fr); gap: 20px; } }
.usage-donut-legend { display: flex; flex-direction: column; min-width: 0; max-height: ${DONUT_PX}px;overflow: auto; }
/* One entry per row, divided rather than boxed: the rule is what separates two
   models, so the last row must not carry one. */
.usage-donut-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 0px 10px; align-items: center; padding: 6px 12px; cursor: default; border-top: 1px solid var(--usage-border); }
.usage-donut-row:first-child { border-top: none; }
.usage-donut-row[data-hover="true"] { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); border-radius: 6px; }
.usage-donut-row > .usage-dot { grid-area: 1 / 1; }
.usage-donut-name { grid-area: 1 / 2; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-donut-share { grid-area: 1 / 3; font-size: 13px; color: var(--usage-label-2); font-variant-numeric: tabular-nums; }
.usage-donut-tokens { grid-area: 2 / 2; color: var(--usage-label-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.usage-slice { transition: opacity 120ms linear; }

.usage-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.usage-table th {
  text-align: right; color: var(--usage-label-2); font-weight: 500; font-size: 11px;
  padding: 6px 8px; border-bottom: 1px solid var(--usage-border); white-space: nowrap;
}
.usage-table th:first-child, .usage-table td:first-child { text-align: left; }
.usage-table td { text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--usage-border); white-space: nowrap; }
.usage-table tbody tr:last-child td { border-bottom: none; }
.usage-model { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
/* The provider is the group heading, so it needs no per-row subtitle under it and
   does not have to stay in the first column: it spans the table and reads as a
   divider between providers rather than as one more row. */
.usage-table-group-head {
  text-align: left;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 500;
  color: var(--usage-label-2);
  background: var(--dsw-alias-interactive-bg-hover);
  padding: 6px 8px;
  border-bottom: 1px solid var(--usage-border);
}
/* A height cap with its own scroll: the corpus only grows, and an unbounded table
   pushed the diagnostics below it off the page. */
.usage-table-scroll { max-height: 420px; overflow-y: auto; }
/* The head sticks to the top of the scroll box, so the columns stay named while
   the body scrolls under them. */
.usage-table-scroll .usage-table thead th { position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-layer-1); }

.usage-progress { height: 2px; border-radius: 1px; overflow: hidden; background: color-mix(in oklab, var(--dsw-alias-state-business-primary) 25%, transparent); }
.usage-progress > span {
  display: block; width: 30%; height: 100%; border-radius: 1px; background: var(--dsw-alias-state-business-primary);
  animation: usage-slide 1.1s ease-in-out infinite;
}
@keyframes usage-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(333%); }
}
.usage-body { display: flex; flex-direction: column; gap: 20px; transition: opacity 120ms linear; }
.usage-body[data-busy="true"] { opacity: 0.55; }
/* The three sections one range control drives. They keep the body's own gap so the
   group looks exactly like the sections above it, and the gap is re-declared here
   because a nested flex container does not inherit its parent's. */
.usage-ranged { display: flex; flex-direction: column; gap: 20px; }
.usage-stage-note { display: flex; flex-direction: column; gap: 3px; }
`;
    //#endregion

    //#region components

    /** One headline card with optional key/value breakdown rows. */
    function Card({ label, value, note, items }) {
      return h("div", { className: "usage-card" }, [
        h("div", { className: "usage-card-label", key: "l" }, label),
        h("div", { className: "usage-card-value", key: "v" }, value),
        note === undefined
          ? null
          : h("div", { className: "usage-card-note", key: "n" }, note),
        items === undefined
          ? null
          : h(
              "div",
              { className: "usage-mini", key: "i" },
              items.map((item) =>
                h(
                  "div",
                  {
                    className: "usage-mini-item",
                    key: item.key,
                  },
                  [
                    h(
                      "div",
                      { className: "usage-mini-key", key: "k" },
                      item.key2,
                    ),
                    h(
                      "div",
                      { className: "usage-mini-val", key: "v" },
                      item.value,
                    ),
                  ],
                ),
              ),
            ),
      ]);
    }

    /** Shared cell legend. */
    function Legend({ t }) {
      return h("div", { className: "usage-legend" }, [
        h("span", { key: "a" }, t("less")),
        h("span", { className: "usage-cell", key: "c0" }),
        h("span", { className: "usage-cell l1", key: "c1" }),
        h("span", { className: "usage-cell l2", key: "c2" }),
        h("span", { className: "usage-cell l3", key: "c3" }),
        h("span", { className: "usage-cell l4", key: "c4" }),
        h("span", { key: "b" }, t("more")),
      ]);
    }

    /** The floating readout shared by every chart. */
    function Tooltip({ state }) {
      if (state === null) return null;
      return h(
        "div",
        {
          className: "usage-tip",
          style: { left: `${state.x}px`, top: `${state.y}px` },
        },
        state.lines.map((line, index) =>
          h(
            "div",
            {
              key: line.key ?? String(index),
              className:
                index === 0
                  ? "usage-tip-title"
                  : `usage-tip-row${line.total === true ? " usage-tip-total" : ""}`,
            },
            line.title === true
              ? line.text
              : [
                  h(
                    "span",
                    { className: "usage-tip-key", key: "k" },
                    line.color === undefined
                      ? line.label
                      : [
                          h("span", {
                            className: "usage-dot",
                            key: "d",
                            style: {
                              background: line.color,
                              marginRight: "5px",
                            },
                          }),
                          line.label,
                        ],
                  ),
                  h(
                    "span",
                    { className: "usage-tip-val", key: "v" },
                    line.value,
                  ),
                ],
          ),
        ),
      );
    }

    /**
     * Hover state for the floating readout.
     *
     * The readout is an in-flow absolute child of the chart root and tracks the
     * pointer through stored offsets, so hovering never moves the underlying
     * chart. Every caller measures its offsets from the positioned element the
     * readout is absolutely placed in, so the two share one coordinate space.
     *
     * `show` publishes the content and the position together; `move` only
     * repositions. That split is load-bearing: a pointer entering a cell fires
     * `mouseenter` on the cell and then `mousemove` on the scroll container, and a
     * `move` that took its lines from the render closure would hand the readout
     * the empty list it captured before `show` re-rendered — the box appears with
     * nothing in it, which is exactly how the heatmap readout used to fail.
     * @param {{width?: number, height?: number}} bounds - the readout's container box.
     * @returns {{tip: object|null, show: Function, hide: Function, move: Function}}
     */
    function useTooltip(bounds) {
      const [tip, setTip] = React.useState(null);

      const clamp = (state, slot) => {
        const width = bounds?.width ?? 0;
        const height = bounds?.height ?? 0;
        const margin = 8;
        const next = { ...state };
        if (width > 0)
          next.x = Math.min(
            Math.max(slot.x + 12, margin),
            Math.max(margin, width - 230),
          );
        if (height > 0)
          next.y = Math.min(
            Math.max(slot.y + 12, margin),
            Math.max(margin, height - 96),
          );
        return next;
      };

      return {
        tip,
        show: (slot, lines) => setTip(clamp({ ...slot, lines }, slot)),
        hide: () => setTip(null),
        move: (slot) =>
          setTip((previous) => {
            if (previous === null) return previous;
            return clamp({ ...previous, ...slot }, slot);
          }),
      };
    }

    /**
     * Group dense ascending day rows into week columns, keeping each cell on its
     * real weekday row.
     * @param {object[]} rows - dense day rows.
     * @returns {(object|null)[][]} columns of seven slots, Sunday first.
     */
    function buildWeeks(rows) {
      if (rows.length === 0) return [];
      const cells = [];
      // Pad the head so columns align to Sunday; the tail is never padded, so the
      // newest day keeps its real weekday row.
      const padHead = weekdayOf(rows[0].day);
      for (let index = 0; index < padHead; index += 1) cells.push(null);
      for (const row of rows) cells.push(row);

      const weeks = [];
      for (let index = 0; index < cells.length; index += 7) {
        const week = cells.slice(index, index + 7);
        while (week.length < 7) week.push(null);
        if (week.every((cell) => cell === null)) continue;
        weeks.push(week);
      }
      return weeks;
    }

    /**
     * Day heatmap: a year of activity, one cell per day.
     *
     * Hovering a cell reports that exact day. Cells are read by column, so their
     * labels come from the day row rather than the grid position.
     */
    function DayHeatmap({ rows, t, locale }) {
      const tip = useTooltip({ width: 900, height: 400 });
      const [hovered, setHovered] = React.useState(null);
      if (rows.length === 0)
        return h("div", { className: "usage-msg" }, t("noData"));

      const weeks = buildWeeks(rows);
      const grade = makeGrader(rows.map((row) => total(row)));

      // Month labels sit above the column where each month first appears, dropped
      // only when the previous label's rendered width would run into this one.
      const monthCells = layoutMonthLabels(weeks, CELL_SLOT, (monthIndex) =>
        monthName(monthIndex, t),
      );

      /**
       * The readout lines for one day.
       *
       * Token values are compacted, not printed in full: the readout is a glance at
       * a hovered cell, and a corpus day runs to hundreds of millions of tokens —
       * "698.9M" is legible where the full digits are not. Every exact figure is
       * still on the page, in the headline cards' notes and the breakdown table.
       * The request count stays a plain integer: it is a count, not a magnitude.
       */
      const linesFor = (day) => [
        { key: "title", text: dayLabel(day.day, locale), title: true },
        { key: "total", label: t("tokens"), value: compact(total(day)) },
        { key: "input", label: t("input"), value: compact(day.inputTokens) },
        { key: "output", label: t("output"), value: compact(day.outputTokens) },
        {
          key: "cache",
          label: t("cacheRead"),
          value: compact(day.cacheReadTokens),
        },
        { key: "rate", label: t("cacheRate"), value: percent(cacheRate(day)) },
        { key: "calls", label: t("calls"), value: exact(day.calls) },
      ];

      return h(
        "div",
        {
          className: "usage-heat-wrap",
          key: "w",
          style: { "--usage-columns": String(weeks.length) },
        },
        [
          h(
            "div",
            {
              className: "usage-heat-scroll",
              key: "s",
              onMouseMove: (event) => {
                // Measured from the same element the readout is absolutely placed in,
                // so the pointer offsets and the readout share one coordinate space.
                // Reposition only: the day's lines belong to the cell's mouseenter.
                const box = event.currentTarget
                  .closest(".usage-heat-wrap")
                  .getBoundingClientRect();
                tip.move({
                  x: event.clientX - box.left,
                  y: event.clientY - box.top,
                });
              },
              onMouseLeave: () => {
                setHovered(null);
                tip.hide();
              },
            },
            [
              h(
                "div",
                {
                  className: "usage-heat-months",
                  key: "m",
                },
                monthCells.map((cell) =>
                  h(
                    "span",
                    {
                      key: `m${cell.index}`,
                      style: { gridColumn: cell.index + 1 },
                    },
                    cell.label,
                  ),
                ),
              ),
              h(
                "div",
                { className: "usage-heat", key: "g" },
                weeks.flatMap((week, weekIndex) =>
                  week.map((cell, dayIndex) =>
                    h("div", {
                      key: `${weekIndex}-${dayIndex}`,
                      className:
                        cell === null
                          ? "usage-cell"
                          : `usage-cell l${grade(total(cell))}`,
                      style:
                        cell === null ? { visibility: "hidden" } : undefined,
                      "data-hover":
                        cell !== null && hovered === cell.day
                          ? "true"
                          : undefined,
                      onMouseEnter:
                        cell === null
                          ? undefined
                          : (event) => {
                              setHovered(cell.day);
                              const box = event.currentTarget
                                .closest(".usage-heat-wrap")
                                .getBoundingClientRect();
                              tip.show(
                                {
                                  x: event.clientX - box.left,
                                  y: event.clientY - box.top,
                                },
                                linesFor(cell),
                              );
                            },
                    }),
                  ),
                ),
              ),
            ],
          ),
          h(Tooltip, { state: tip.tip, key: "tip" }),
        ],
      );
    }

    /** One card per ISO week, each labelled with its exact start–end days. */
    function WeekHeatmap({ rows, t, locale }) {
      const tip = useTooltip({ width: 900, height: 300 });
      if (rows.length === 0)
        return h("div", { className: "usage-msg" }, t("noData"));
      const buckets = new Map();
      for (const row of rows) {
        const key = weekKeyOf(row.day);
        const bucket = buckets.get(key);
        if (bucket === undefined) buckets.set(key, { key, rows: [row] });
        else bucket.rows.push(row);
      }
      const weeks = [...buckets.values()];
      const peak = weeks.reduce(
        (maximum, week) => Math.max(maximum, total(sumRows(week.rows))),
        0,
      );

      return h("div", {}, [
        h(
          "div",
          { className: "usage-weeks", key: "w" },
          weeks.map((week) => {
            const summed = sumRows(week.rows);
            const tokens = total(summed);
            const width =
              peak > 0 ? Math.max(3, Math.round((tokens / peak) * 100)) : 0;
            return h(
              "div",
              {
                key: week.key,
                className: "usage-week",
                onMouseEnter: (event) => {
                  const box = event.currentTarget
                    .closest(".usage-section")
                    .getBoundingClientRect();
                  tip.show(
                    { x: event.clientX - box.left, y: event.clientY - box.top },
                    [
                      {
                        key: "title",
                        text: `${week.key} \u00b7 ${weekRangeLabel(week.key, locale)}`,
                        title: true,
                      },
                      {
                        key: "total",
                        label: t("tokens"),
                        value: exact(tokens),
                      },
                      {
                        key: "input",
                        label: t("input"),
                        value: exact(summed.inputTokens),
                      },
                      {
                        key: "output",
                        label: t("output"),
                        value: exact(summed.outputTokens),
                      },
                      {
                        key: "cache",
                        label: t("cacheRead"),
                        value: exact(summed.cacheReadTokens),
                      },
                      {
                        key: "rate",
                        label: t("cacheRate"),
                        value: percent(cacheRate(summed)),
                      },
                      {
                        key: "calls",
                        label: t("calls"),
                        value: exact(summed.calls),
                      },
                    ],
                  );
                },
                onMouseLeave: () => tip.hide(),
              },
              [
                h(
                  "div",
                  { className: "usage-week-key", key: "k" },
                  week.key.slice(5),
                ),
                h(
                  "div",
                  { className: "usage-week-range", key: "r" },
                  weekRangeLabel(week.key, locale),
                ),
                h(
                  "div",
                  { className: "usage-week-value", key: "v" },
                  compact(tokens),
                ),
                h(
                  "div",
                  { className: "usage-week-bar", key: "b" },
                  h("span", { style: { width: `${width}%` } }),
                ),
              ],
            );
          }),
        ),
        h(Tooltip, { state: tip.tip, key: "tip" }),
      ]);
    }

    /** Year rows by month columns, with click-to-drill-down into one month. */
    function MonthHeatmap({ rows, t, locale, onPick }) {
      const tip = useTooltip({ width: 900, height: 400 });
      if (rows.length === 0)
        return h("div", { className: "usage-msg" }, t("noData"));

      const months = new Map();
      for (const row of rows) {
        const key = monthKeyOf(row.day);
        const bucket = months.get(key);
        if (bucket === undefined) months.set(key, { key, rows: [row] });
        else bucket.rows.push(row);
      }

      const entries = [...months.values()];
      const grade = makeGrader(
        entries.map((month) => total(sumRows(month.rows))),
      );
      const years = [...new Set(entries.map((month) => month.key.slice(0, 4)))]
        .sort()
        .reverse();

      const yearRows = years.map((year) => {
        const monthCells = [];
        for (let index = 0; index < 12; index += 1) {
          const month = `${year}-${index < 9 ? `0${index + 1}` : index + 1}`;
          const bucket = months.get(month);
          const summed = bucket === undefined ? null : sumRows(bucket.rows);
          const level = summed === null ? 0 : grade(total(summed));
          monthCells.push(
            h(
              "td",
              { key: month },
              h("div", {
                className: `usage-cell usage-month-pick l${level}`,
                onClick: summed === null ? undefined : () => onPick(month),
                onMouseEnter:
                  summed === null
                    ? undefined
                    : (event) => {
                        const box = event.currentTarget
                          .closest(".usage-section")
                          .getBoundingClientRect();
                        tip.show(
                          {
                            x: event.clientX - box.left,
                            y: event.clientY - box.top,
                          },
                          [
                            {
                              key: "title",
                              text: monthLabel(month, locale),
                              title: true,
                            },
                            {
                              key: "total",
                              label: t("tokens"),
                              value: exact(total(summed)),
                            },
                            {
                              key: "input",
                              label: t("input"),
                              value: exact(summed.inputTokens),
                            },
                            {
                              key: "output",
                              label: t("output"),
                              value: exact(summed.outputTokens),
                            },
                            {
                              key: "cache",
                              label: t("cacheRead"),
                              value: exact(summed.cacheReadTokens),
                            },
                            {
                              key: "rate",
                              label: t("cacheRate"),
                              value: percent(cacheRate(summed)),
                            },
                            {
                              key: "calls",
                              label: t("calls"),
                              value: exact(summed.calls),
                            },
                          ],
                        );
                      },
                onMouseLeave: () => tip.hide(),
              }),
            ),
          );
        }
        return h("tr", { key: year }, [
          h("th", { className: "usage-year", key: "y" }, year),
          ...monthCells,
        ]);
      });

      return h("div", {}, [
        h(
          "table",
          { className: "usage-month-table", key: "t" },
          h("tbody", {}, yearRows),
        ),
        h(Legend, { t, key: "l" }),
        h(Tooltip, { state: tip.tip, key: "tip" }),
      ]);
    }

    /** A legend entry for one line, qualified when two providers share a model id. */
    function seriesLabel(route, nameCounts) {
      return nameCounts.get(route.model) > 1
        ? `${route.model} (${route.provider})`
        : route.model;
    }

    /** Count how many routes share each model id. */
    function modelNameCounts(routes) {
      const counts = new Map();
      for (const route of routes)
        counts.set(route.model, (counts.get(route.model) ?? 0) + 1);
      return counts;
    }

    /**
     * Days with a token total to plot, oldest first.
     *
     * Reads the dense day series rather than the per-model trend: input and output
     * are already folded per day there, and the read stays correct even when no
     * route attribution was recorded for a day.
     * @param {object[]} days - the payload's dense day rows.
     * @param {number|null} limit - trailing days to keep, or null for the whole series.
     * @returns {object[]} rows to plot.
     */
    function trendRows(days, limit) {
      const usable = (days ?? []).filter(
        (row) => row !== null && typeof row.day === "string",
      );
      if (limit === null) return usable;
      return usable.slice(-Math.max(2, limit));
    }

    /** Token buckets on the left axis, drawn as one stack per day. */
    function trendTokenSeries(t, rows) {
      return [
        // The legend reads "Input", not the breakdown table's "Uncached input":
        // on this chart the bar is the day's whole input, named beside the output
        // bar it stacks with, and the note below carries the uncached caveat.
        {
          key: "input",
          label: t("input"),
          color: SERIES_COLORS[0],
          values: rows.map((row) => row.inputTokens ?? 0),
        },
        {
          key: "output",
          label: t("output"),
          color: SERIES_COLORS[1],
          values: rows.map((row) => row.outputTokens ?? 0),
        },
      ];
    }

    /**
     * The cache-hit ratio on its own axis. A day with no billed input has no
     * ratio at all, so it is left out of the line rather than plotted as zero.
     * @param {object[]} rows - rows being plotted.
     * @returns {{values: (number|null)[], colour: string}} the ratio in 0..1 per day.
     */
    function trendCacheSeries(rows) {
      return {
        values: rows.map((row) => cacheRate(row)),
        color: CACHE_COLOR,
      };
    }

    /**
     * The trend chart's range control.
     *
     * A tablist over the offered windows. The selected segment carries the
     * indicator, whose position comes from the two custom properties set here, and
     * is the only segment in the tab order; the arrow keys walk the segments,
     * exactly like the app's own segmented control.
     * @param {{value: number, onChange: Function, t: Function}} props - the window and its setter.
     */
    function TrendRange({ value, onChange, t }) {
      const selected = Math.max(
        0,
        TREND_RANGES.findIndex((option) => option.days === value),
      );

      /** Walk the segments with the arrow keys, as a tablist is expected to. */
      const onKeyDown = (event) => {
        let next = -1;
        if (event.key === "ArrowLeft")
          next = (selected + TREND_RANGES.length - 1) % TREND_RANGES.length;
        else if (event.key === "ArrowRight")
          next = (selected + 1) % TREND_RANGES.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = TREND_RANGES.length - 1;
        if (next === -1) return;
        event.preventDefault();
        onChange(TREND_RANGES[next].days);
        // Focus follows the selection, or the roving tabindex would leave the focus
        // ring behind on a segment that is no longer in the tab order. The segments
        // are queried by role, not indexed off `children`: the indicator is rendered
        // first, so an index would land one segment (or on the span) behind.
        const segments =
          typeof event.currentTarget.querySelectorAll === "function"
            ? event.currentTarget.querySelectorAll('[role="tab"]')
            : [];
        const target = segments[next];
        if (target !== undefined && typeof target.focus === "function")
          target.focus();
      };

      return h(
        "div",
        {
          className: "usage-tabs",
          role: "tablist",
          "aria-label": t("rangeLabel"),
          style: {
            "--usage-tab-count": String(TREND_RANGES.length),
            "--usage-tab-index": String(selected),
          },
          onKeyDown,
        },
        [
          h("span", {
            className: "usage-tab-indicator",
            key: "indicator",
            "aria-hidden": true,
          }),
          ...TREND_RANGES.map((option) =>
            h(
              "button",
              {
                // `key` names the segment; `days` is null for the whole window, so
                // it cannot also serve as an id or a React key.
                key: option.key,
                id: `${TREND_TAB_ID}-${option.key}`,
                type: "button",
                role: "tab",
                className: "usage-tab",
                "aria-selected": value === option.days ? "true" : "false",
                // One panel is switched in place, so every segment names that panel
                // rather than an id of its own that never gets rendered.
                "aria-controls": TREND_PANEL_ID,
                tabIndex: value === option.days ? 0 : -1,
                onClick: () => onChange(option.days),
              },
              t(option.label),
            ),
          ),
        ],
      );
    }

    /**
     * The daily-trend section: the chart for the window the range control picked.
     *
     * The window is view state, not a fetch — the payload already carries the whole
     * heatmap window — so switching it re-renders and nothing else. The control
     * itself lives above this section because it also drives the ring and the
     * breakdown table; `range` arrives as a prop for exactly that reason.
     * @param {{days: object[], range: number, t: Function, locale: string}} props - the dense day series and the active window.
     */
    function TrendSection({ days, range, t, locale }) {
      return h("div", { className: "usage-section" }, [
        h(
          "h2",
          { className: "usage-section-title", key: "title" },
          t("dailyTrend"),
        ),
        h(TrendChart, {
          key: "chart",
          rows: trendRows(days, range),
          t,
          locale,
        }),
      ]);
    }

    /** Per-day token series, one line per route, with a hovered readout. */
    function TrendChart({ rows, t, locale }) {
      const tip = useTooltip({ width: 900, height: 320 });
      const [hover, setHover] = React.useState(null);
      const series = trendTokenSeries(t, rows);
      const cache = trendCacheSeries(rows);
      // The bars animate in from the baseline: the first paint draws them scaled
      // flat, then the next frame releases them to full height.
      const [grown, setGrown] = React.useState(false);
      React.useEffect(() => {
        setGrown(true);
      }, []);

      const width = 720;
      const height = 240;
      const padLeft = 52;
      const padRight = 56;
      const padTop = 12;
      const padBottom = 26;
      const plotWidth = width - padLeft - padRight;
      const plotHeight = height - padTop - padBottom;
      const baseline = padTop + plotHeight;
      const slot = plotWidth / Math.max(1, rows.length);
      // A hair of gutter between bars, but never so much that a bar disappears at
      // 100 days; the floor keeps short windows from drawing hairlines.
      const barWidth = Math.max(
        2,
        Math.min(18, slot - Math.max(1, slot * 0.18)),
      );
      // The ratio bar is the backdrop for the stack above it, so it is a little
      // wider — but never so wide that neighbouring days touch, or a year of them
      // would merge into one continuous band.
      const cacheBarWidth = Math.min(slot * 0.9, barWidth * 1.5);

      if (
        rows.length < 2 ||
        series.every((line) => line.values.every((value) => value === 0))
      ) {
        return h("div", { className: "usage-msg" }, t("noTrend"));
      }

      // The left axis covers the tallest stack of the window; the right axis is
      // pinned to 0..100% so a ratio means the same thing in every window.
      const stack = rows.map((unused, index) =>
        series.reduce((sum, line) => sum + line.values[index], 0),
      );
      const peak = Math.max(1, ...stack);
      const tickStep = peak <= 2 ? 1 : Math.ceil(peak / 2);
      const tokenTicks = [2, 1, 0].map((multiple) => ({
        value: tickStep * multiple,
        y: padTop + plotHeight - (plotHeight * tickStep * multiple) / peak,
      }));
      const cacheTicks = [1, 0.5, 0].map((value) => ({
        value,
        y: padTop + plotHeight - plotHeight * value,
      }));
      const xOf = (index) => padLeft + slot * (index + 0.5);
      const labelEvery = Math.max(1, Math.ceil(rows.length / 8));

      // X labels every few days, but never two that would print on top of each
      // other: the newest day is always labelled and lands one slot after its
      // neighbour, which is how the axis ended in a smear of overlapping dates.
      // On that collision the trailing tick wins — it names the current day — and
      // the neighbour it would have covered is dropped instead.
      const xTicks = [];
      let occupiedThrough = -Infinity;
      for (let index = 0; index < rows.length; index += 1) {
        if (index % labelEvery !== 0 && index !== rows.length - 1) continue;
        const label = shortDay(dateOf(rows[index].day), locale);
        if (index < occupiedThrough) {
          if (index === rows.length - 1 && xTicks.length > 0)
            xTicks[xTicks.length - 1] = { index, label };
          continue;
        }
        xTicks.push({ index, label });
        occupiedThrough =
          index + Math.max(1, labelColumns(label, slot, AXIS_EM));
      }

      const legend = [
        ...series.map((line) => ({
          key: line.key,
          label: line.label,
          color: line.color,
          kind: "bar",
        })),
        {
          key: "cache",
          label: t("cacheRate"),
          color: cache.color,
          kind: "bar",
        },
      ];

      // A held column index can outlive its window: switching the range control to a
      // shorter window leaves `hover` past the new end, which would draw the needle
      // and its marker past the plot and leave the readout naming a day that is no
      // longer on the chart. Everything below reads this clamped index instead, so
      // the stale hover simply reads as "nothing hovered" until the pointer moves.
      const active = hover === null || hover >= rows.length ? null : hover;

      /** Pick the column nearest the pointer and report that whole day. */
      const onMove = (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        if (box.width <= 0) return;
        const scale = box.width / width;
        const localX = (event.clientX - box.left) / scale;
        const index = Math.min(
          rows.length - 1,
          Math.max(0, Math.floor((localX - padLeft) / slot)),
        );
        setHover(index);
        const row = rows[index];
        const rate = cache.values[index];
        const stageBox = event.currentTarget
          .closest(".usage-section")
          .getBoundingClientRect();
        // The hovered column changes with the pointer, so this publishes the whole
        // readout rather than only repositioning it. Token values are compacted
        // ("698.9M"), which is what the y-axis beside them already prints — an exact
        // figure in the readout disagreed with the scale it was read against, and a
        // busy day's row of full digits is unreadable at a glance. The headline
        // cards and the breakdown table still carry the exact counts.
        tip.show(
          { x: event.clientX - stageBox.left, y: event.clientY - stageBox.top },
          [
            { key: "title", text: dayLabel(row.day, locale), title: true },
            ...series.map((line) => ({
              key: line.key,
              label: line.label,
              color: line.color,
              value: compact(line.values[index]),
            })),
            {
              key: "total",
              label: t("colTotal"),
              total: true,
              value: compact(
                series.reduce((sum, line) => sum + line.values[index], 0),
              ),
            },
            // Cache reads are the largest bucket by far on a cache-heavy workload and
            // are deliberately not stacked — the stack is the uncached work — so the
            // readout names them rather than leaving the bars looking inexplicably small.
            {
              key: "cacheRead",
              label: t("cacheRead"),
              value: compact(row.cacheReadTokens ?? 0),
            },
            {
              key: "rate",
              label: t("cacheRate"),
              value: rate === null ? "\u2014" : percent(rate),
            },
          ],
        );
      };

      return h("div", {}, [
        h(
          "div",
          { className: "usage-trend-legend", key: "l" },
          legend.map((entry) =>
            h(
              "span",
              {
                className: "usage-trend-key",
                key: entry.key,
                "data-kind": entry.kind,
              },
              [
                h("span", {
                  className: "usage-dot",
                  key: "d",
                  style: { background: entry.color },
                }),
                h("span", { key: "n" }, entry.label),
              ],
            ),
          ),
        ),
        h(
          "svg",
          {
            key: "svg",
            className: "usage-svg",
            viewBox: `0 0 ${width} ${height}`,
            role: "img",
            "aria-label": t("dailyTrend"),
            onMouseMove: onMove,
            onMouseLeave: () => {
              setHover(null);
              tip.hide();
            },
          },
          [
            ...tokenTicks.map((tick, index) =>
              h("line", {
                key: `g${index}`,
                className: "usage-grid-line",
                x1: padLeft,
                x2: width - padRight,
                y1: tick.y,
                y2: tick.y,
              }),
            ),
            ...tokenTicks.map((tick, index) =>
              h(
                "text",
                {
                  key: `lt${index}`,
                  className: "usage-axis",
                  x: padLeft - 8,
                  y: tick.y + 3,
                  textAnchor: "end",
                },
                compact(tick.value),
              ),
            ),
            ...cacheTicks.map((tick, index) =>
              h(
                "text",
                {
                  key: `rt${index}`,
                  className: "usage-axis",
                  x: width - padRight + 8,
                  y: tick.y + 3,
                  textAnchor: "start",
                },
                percent(tick.value),
              ),
            ),
            // The ratio rides its own axis as a wide backdrop bar: one bar per day is
            // read against that same day's stack without a second plot area, and the
            // two scales never have to be compared as curves. It is emitted before
            // the stacks so they paint over it — it is wider than they are, so the
            // other order would let a 99%-tall yellow bar wash them out.
            ...rows.map((row, index) => {
              const value = cache.values[index];
              if (value === null) return null;
              const barHeight = plotHeight * Math.min(1, Math.max(0, value));
              return h("rect", {
                key: `cache-${row.day}`,
                className: "usage-cache-bar",
                x: xOf(index) - cacheBarWidth / 2,
                y: baseline - barHeight,
                width: cacheBarWidth,
                height: barHeight,
                // The colour is a token reference, which only resolves through style:
                // as the fill attribute it is invalid and the bar paints black.
                style: {
                  fill: cache.color,
                  transform: grown ? "scaleY(1)" : "scaleY(0)",
                },
              });
            }),
            // One stack per day: input at the baseline, output stacked above it.
            ...rows.flatMap((row, index) => {
              const x = xOf(index) - barWidth / 2;
              let cursor = baseline;
              return series.map((line) => {
                const value = line.values[index];
                const barHeight = (plotHeight * value) / peak;
                cursor -= barHeight;
                return h("rect", {
                  key: `${line.key}-${row.day}`,
                  className: "usage-bar",
                  x,
                  y: cursor,
                  width: barWidth,
                  height: barHeight,
                  style: {
                    fill: line.color,
                    transform: grown ? "scaleY(1)" : "scaleY(0)",
                  },
                });
              });
            }),
            ...xTicks.map((tick) =>
              h(
                "text",
                {
                  key: `x${rows[tick.index].day}`,
                  className: "usage-axis",
                  x: xOf(tick.index),
                  y: height - 8,
                  textAnchor: "middle",
                },
                tick.label,
              ),
            ),
            active === null
              ? null
              : h("line", {
                  key: "needle",
                  className: "usage-needle",
                  x1: xOf(active),
                  x2: xOf(active),
                  y1: padTop,
                  y2: baseline,
                }),
            active === null || cache.values[active] === null
              ? null
              : h("circle", {
                  key: "cache-pin",
                  className: "usage-marker",
                  cx: xOf(active),
                  cy: padTop + plotHeight - plotHeight * cache.values[active],
                  r: 3.5,
                  style: { fill: cache.color },
                }),
          ],
        ),
        // Hiding the readout with the needle keeps the two in step: a window switch
        // drops the hovered column, so its numbers must go with it.
        h(Tooltip, { state: active === null ? null : tip.tip, key: "tip" }),
      ]);
    }

    /** Model share donut plus its legend, both hoverable. */
    function DonutChart({ data, t }) {
      const tip = useTooltip({ width: 900, height: 460 });
      const [hover, setHover] = React.useState(null);
      const routes = (data ?? []).filter((route) => total(route) > 0);
      if (routes.length === 0)
        return h("div", { className: "usage-msg" }, t("noData"));

      const grand = routes.reduce(
        (accumulator, route) => accumulator + total(route),
        0,
      );
      const ranked = routes
        .slice()
        .sort((left, right) => total(right) - total(left));
      const nameCounts = modelNameCounts(ranked);

      const size = DONUT_PX;
      const center = size / 2;
      // Scaled with the viewBox, so the ring keeps its proportions as the box
      // grows: the stroke stays a little over a third of the radius, which is the
      // thick, shallow-hole ring the reference design shows.
      const radius = 94;
      const stroke = 38;
      const circumference = 2 * Math.PI * radius;

      // Each slice is one dash on a shared circle, walked around with a negative
      // offset; a 2px dash gap keeps adjacent slices distinguishable.
      const slices = [];
      let consumed = 0;
      for (const [index, route] of ranked.entries()) {
        const share = total(route) / grand;
        const length = Math.max(0, share * circumference - 2);
        slices.push({
          key: `${route.provider}\u0000${route.model}`,
          route,
          color: SERIES_COLORS[index % SERIES_COLORS.length],
          share,
          dasharray: `${length.toFixed(3)} ${(circumference - length).toFixed(3)}`,
          dashoffset: (-(consumed * circumference) - 1).toFixed(3),
        });
        consumed += share;
      }

      /** The readout lines for one slice. */
      const linesFor = (slice) => [
        {
          key: "title",
          text: seriesLabel(slice.route, nameCounts),
          title: true,
        },
        { key: "total", label: t("tokens"), value: exact(total(slice.route)) },
        {
          key: "share",
          label: t("share"),
          value: `${(slice.share * 100).toFixed(1)}%`,
        },
        { key: "calls", label: t("calls"), value: exact(slice.route.calls) },
        {
          key: "rate",
          label: t("cacheRate"),
          value: percent(cacheRate(slice.route)),
        },
        { key: "provider", label: t("provider"), value: slice.route.provider },
      ];

      return h("div", { className: "usage-donut" }, [
        h(
          "div",
          {
            className: "usage-donut-wrap",
            key: "wrap",
            onMouseMove: (event) => {
              // Same origin as the slice and legend handlers below, and the readout
              // itself is rendered outside this wrap for exactly that reason: every
              // offset here is measured from the section, so the readout has to be
              // positioned against the section too.
              const box = event.currentTarget
                .closest(".usage-section")
                .getBoundingClientRect();
              tip.move({
                x: event.clientX - box.left,
                y: event.clientY - box.top,
              });
            },
            onMouseLeave: () => {
              setHover(null);
              tip.hide();
            },
          },
          [
            h(
              "svg",
              {
                key: "svg",
                className: "usage-svg",
                viewBox: `0 0 ${size} ${size}`,
                role: "img",
                "aria-label": t("byModel"),
              },
              h(
                "g",
                { transform: `rotate(-90 ${center} ${center})` },
                slices.map((slice) =>
                  h("circle", {
                    key: slice.key,
                    className: "usage-slice",
                    cx: center,
                    cy: center,
                    r: radius,
                    fill: "none",
                    style: { stroke: slice.color },
                    strokeWidth:
                      hover === null || hover === slice.key
                        ? stroke
                        : stroke - 6,
                    strokeDasharray: slice.dasharray,
                    strokeDashoffset: slice.dashoffset,
                    opacity: hover === null || hover === slice.key ? 1 : 0.45,
                    onMouseEnter: (event) => {
                      setHover(slice.key);
                      const box = event.currentTarget
                        .closest(".usage-section")
                        .getBoundingClientRect();
                      tip.show(
                        {
                          x: event.clientX - box.left,
                          y: event.clientY - box.top,
                        },
                        linesFor(slice),
                      );
                    },
                  }),
                ),
              ),
            ),
            h("div", { className: "usage-donut-center", key: "center" }, [
              h(
                "div",
                { className: "usage-donut-center-number", key: "n" },
                compact(grand),
              ),
              h(
                "div",
                { className: "usage-donut-center-unit", key: "u" },
                t("tokens"),
              ),
            ]),
          ],
        ),
        h(
          "div",
          { className: "usage-donut-legend", key: "legend" },
          ranked.map((route, index) =>
            h(
              "div",
              {
                className: "usage-donut-row",
                key: `${route.provider}\u0000${route.model}`,
                "data-hover":
                  hover === `${route.provider}\u0000${route.model}`
                    ? "true"
                    : undefined,
                onMouseEnter: (event) => {
                  setHover(`${route.provider}\u0000${route.model}`);
                  const box = event.currentTarget
                    .closest(".usage-section")
                    .getBoundingClientRect();
                  tip.show(
                    { x: event.clientX - box.left, y: event.clientY - box.top },
                    linesFor(slices[index]),
                  );
                },
                onMouseLeave: () => {
                  setHover(null);
                  tip.hide();
                },
              },
              [
                h("span", {
                  className: "usage-dot",
                  key: "d",
                  style: {
                    background: SERIES_COLORS[index % SERIES_COLORS.length],
                  },
                }),
                h(
                  "span",
                  { className: "usage-donut-name", key: "n" },
                  seriesLabel(route, nameCounts),
                ),
                h(
                  "span",
                  { className: "usage-donut-share", key: "s" },
                  `${((total(route) / grand) * 100).toFixed(1)}%`,
                ),
                h(
                  "span",
                  { className: "usage-donut-tokens", key: "v" },
                  `${compact(total(route))} ${t("tokens")}`,
                ),
              ],
            ),
          ),
        ),
        h(Tooltip, { state: tip.tip, key: "tip" }),
      ]);
    }

    /**
     * Per-route breakdown table, grouped by provider.
     *
     * The provider is a group heading rather than a per-row subtitle: several
     * models usually share a provider, and repeating it under every model said
     * nothing the grouping does not. Rows stay sorted by total inside a group, and
     * the groups themselves follow their largest model, so the table still reads
     * largest-first overall.
     */
    function RouteTable({ routes, t }) {
      if (routes.length === 0)
        return h("div", { className: "usage-msg" }, t("noData"));

      const groups = [];
      for (const route of routes) {
        let group = groups.find((entry) => entry.provider === route.provider);
        if (group === undefined) {
          group = { provider: route.provider, routes: [], total: 0 };
          groups.push(group);
        }
        group.routes.push(route);
        group.total += total(route);
      }
      groups.sort((left, right) => right.total - left.total);

      const header = h(
        "thead",
        {},
        h("tr", {}, [
          h("th", { key: "m" }, t("colModel")),
          h("th", { key: "c" }, t("colCalls")),
          h("th", { key: "i" }, t("colInput")),
          h("th", { key: "o" }, t("colOutput")),
          h("th", { key: "r" }, t("colCacheRead")),
          h("th", { key: "h" }, t("colCacheRate")),
          h("th", { key: "tt" }, t("colTotal")),
        ]),
      );

      // A height cap with its own scroll: the corpus only grows, and an unbounded
      // table pushes the diagnostics below it off the page entirely.
      return h(
        "div",
        { className: "usage-table-scroll" },
        h("table", { className: "usage-table" }, [
          header,
          ...groups.map((group) =>
            h(
              "tbody",
              { key: group.provider, className: "usage-table-group" },
              [
                h(
                  "tr",
                  { key: "h" },
                  h(
                    "th",
                    {
                      key: "p",
                      className: "usage-table-group-head",
                      colSpan: 7,
                    },
                    `${group.provider} \u00b7 ${exact(group.total)} ${t("tokens")}`,
                  ),
                ),
                ...group.routes.map((route) =>
                  h("tr", { key: `${route.provider}\u0000${route.model}` }, [
                    h(
                      "td",
                      { key: "m" },
                      h(
                        "div",
                        { className: "usage-model", key: "mo" },
                        route.model,
                      ),
                    ),
                    h("td", { key: "c" }, exact(route.calls)),
                    h("td", { key: "i" }, exact(route.inputTokens)),
                    h("td", { key: "o" }, exact(route.outputTokens)),
                    h("td", { key: "r" }, exact(route.cacheReadTokens)),
                    h("td", { key: "h" }, percent(cacheRate(route))),
                    h("td", { key: "tt" }, compact(total(route))),
                  ]),
                ),
              ],
            ),
          ),
        ]),
      );
    }

    /**
     * The whole-page dashboard.
     *
     * `inject()` from the slot registration supplies the data loader; the polling
     * interval is created and cleared inside one effect so unmounting stops it.
     * An optional `preloaded` payload renders immediately without a fetch, which
     * also lets the render suite exercise every view deterministically.
     */
    function UsagePanel(props) {
      const t = props.t;
      const load = props.load;
      const preloaded = props.preloaded;

      // The framework never hands the active locale id to a slot component, but it
      // does re-derive `t` on every locale switch, so the language is read back
      // out of the dictionaries rather than tracked through extra state.
      const locale = localeFromTranslate(t);
      const [state, setState] = React.useState(
        preloaded === undefined || preloaded === null
          ? { status: "loading" }
          : { status: "ready", payload: preloaded },
      );
      const [busy, setBusy] = React.useState(true);
      const [tick, setTick] = React.useState(0);
      // The window every per-model view reads. It lives here rather than in the
      // trend section because the ring and the table follow it too.
      const [range, setRange] = React.useState(TREND_DAYS);
      const loadRef = React.useRef(load);
      loadRef.current = load;

      const payload = state.status === "ready" ? state.payload : null;

      React.useEffect(() => {
        let cancelled = false;
        let hold = null;
        const startedAt = Date.now();

        /** Clear the spinner once the minimum display time has elapsed. */
        const finish = () => {
          const remaining = MIN_LOADING_MS - (Date.now() - startedAt);
          if (remaining > 0) {
            hold = setTimeout(() => {
              if (!cancelled) setBusy(false);
            }, remaining);
          } else if (!cancelled) {
            setBusy(false);
          }
        };

        const fetchOnce = async (force) => {
          try {
            // The payload carries a year for the heatmap; the per-model views take
            // the corpus's own span out of it, so this window never pads them.
            const response = await loadRef.current(`?days=${WINDOW_DAYS}`);
            if (cancelled) return;
            if (!response.ok) {
              setState({ status: "error", message: `${response.status}` });
              finish();
              return;
            }
            const body = await response.json();
            if (cancelled) return;
            setState((previous) => {
              // Same revision and same shape: keep the previous object so React
              // skips the re-render entirely.
              if (
                !force &&
                previous.status === "ready" &&
                previous.payload.revision === body.revision &&
                previous.payload.seeding === body.seeding
              ) {
                return previous;
              }
              return { status: "ready", payload: body };
            });
            finish();
          } catch (error) {
            if (!cancelled) {
              setState({
                status: "error",
                message: String(error && error.message ? error.message : error),
              });
              finish();
            }
          }
        };

        setBusy(true);
        fetchOnce(true);
        const poll = setInterval(() => {
          fetchOnce(false);
        }, POLL_MS);
        return () => {
          cancelled = true;
          if (hold !== null) clearTimeout(hold);
          clearInterval(poll);
        };
      }, [tick]);

      // The manual refresh must show its spinner for the same minimum, so a fast
      // response cannot flicker.
      function refresh() {
        setBusy(true);
        setTick((value) => value + 1);
      }

      const header = h("div", { className: "usage-head", key: "head" }, [
        h("div", { key: "titles" }, [
          h("h1", { className: "usage-title", key: "t" }, t("panel")),
          h("p", { className: "usage-intro", key: "i" }, t("intro")),
        ]),
        h(
          "button",
          {
            key: "refresh",
            type: "button",
            className: "usage-btn",
            disabled: busy,
            onClick: refresh,
          },
          t("refresh"),
        ),
      ]);

      if (state.status === "error") {
        return h(
          "div",
          { className: "usage-panel" },
          h("div", { className: "usage-inner" }, [
            h("style", { key: "css" }, CSS),
            header,
            h(
              "div",
              { className: "usage-err", key: "e" },
              `${t("error")}: ${state.message}`,
            ),
          ]),
        );
      }

      const body = [];

      if (payload === null) {
        body.push(
          h(
            "div",
            { className: "usage-card", key: "empty" },
            h("div", { className: "usage-msg" }, t("loading")),
          ),
        );
      } else {
        const today = payload.today;
        const all = payload.totals;

        body.push(
          h("div", { className: "usage-metrics", key: "metrics" }, [
            h(Card, {
              key: "today",
              label: t("todayTokens"),
              value: compact(total(today)),
              note: `${exact(total(today))} ${t("tokens")}`,
              items: [
                { key: "i", key2: t("input"), value: exact(today.inputTokens) },
                {
                  key: "o",
                  key2: t("output"),
                  value: exact(today.outputTokens),
                },
                {
                  key: "c",
                  key2: t("cacheRead"),
                  value: exact(today.cacheReadTokens),
                },
              ],
            }),
            h(Card, {
              key: "all",
              label: t("allTokens"),
              value: compact(total(all)),
              note: `${exact(total(all))} ${t("tokens")}`,
              items: [
                { key: "i", key2: t("input"), value: exact(all.inputTokens) },
                { key: "o", key2: t("output"), value: exact(all.outputTokens) },
                {
                  key: "c",
                  key2: t("cacheRead"),
                  value: exact(all.cacheReadTokens),
                },
              ],
            }),
            h(Card, {
              key: "rates",
              label: t("cacheRate"),
              value: percent(cacheRate(all)),
              note: t("cacheRateNote"),
              items: [
                {
                  key: "tr",
                  key2: t("todayRate"),
                  value: percent(cacheRate(today)),
                },
                { key: "tc", key2: t("todayCalls"), value: exact(today.calls) },
                { key: "rc", key2: t("allCalls"), value: exact(all.calls) },
              ],
            }),
          ]),
        );

        body.push(
          h("div", { className: "usage-section", key: "heat" }, [
            h(
              "h2",
              { className: "usage-section-title", key: "t" },
              t("activity"),
            ),
            h(DayHeatmap, { key: "d", rows: payload.days, t, locale }),
          ]),
        );

        // One control for the three per-model views below it: the range it picks is
        // read by the trend, the ring, and the breakdown table alike, so the three
        // can never show different periods. It is a bare control row rather than a
        // card, because it belongs to the sections under it rather than being one.
        const ranged = routesInRange(payload.trend, range, payload.routes);
        // The trend plots the per-model window, which begins where the corpus does —
        // not the heatmap's, which is a full year of context. Handing it `payload.days`
        // directly made "all" draw ~330 empty columns ahead of the first settlement,
        // so the x axis opened on a blank year instead of on the first real day.
        const trendKeys = new Set(payload.trend.days ?? []);
        const trendSource = payload.days.filter((row) =>
          trendKeys.has(row.day),
        );
        body.push(
          h("div", { className: "usage-range-bar", key: "range" }, [
            h(
              "span",
              { className: "usage-range-label", key: "l" },
              t("rangeLabel"),
            ),
            h(TrendRange, { key: "r", value: range, onChange: setRange, t }),
          ]),
        );

        body.push(
          h(
            "div",
            {
              key: "ranged",
              className: "usage-ranged",
              role: "tabpanel",
              id: TREND_PANEL_ID,
              // The panel is named by the active segment, whose id is built from
              // the option key rather than the day count (the whole window has none).
              "aria-labelledby": `${TREND_TAB_ID}-${rangeKeyOf(range)}`,
            },
            [
              h(TrendSection, {
                key: "trend",
                days: trendSource,
                range,
                t,
                locale,
              }),
              h("div", { className: "usage-section", key: "donut" }, [
                h(
                  "h2",
                  { className: "usage-section-title", key: "t" },
                  t("byModel"),
                ),
                h(DonutChart, { key: "c", data: ranged, t }),
              ]),
              h("div", { className: "usage-section", key: "table" }, [
                h(
                  "h2",
                  { className: "usage-section-title", key: "t" },
                  t("breakdown"),
                ),
                h(RouteTable, { key: "r", routes: ranged, t }),
              ]),
            ],
          ),
        );

        // Only describe problems that actually exist; a clean corpus stays quiet.
        const warnings = payload.warnings;
        if (
          warnings.sessionsFailed > 0 ||
          warnings.malformedUsageEvents > 0 ||
          warnings.recoveredSessions > 0
        ) {
          const lines = [];
          if (warnings.sessionsFailed > 0) {
            lines.push(`${warnings.sessionsFailed} ${t("sessionsFailed")}`);
          }
          if (warnings.recoveredSessions > 0) {
            lines.push(
              `${warnings.recoveredSessions} ${t("sessionsRecovered")}`,
            );
          }
          if (warnings.malformedUsageEvents > 0) {
            lines.push(
              `${warnings.malformedUsageEvents} ${t("malformedEvents")}`,
            );
          }
          const reasons = warnings.failureReasons ?? [];
          body.push(
            h("div", { className: "usage-stage-note", key: "warn" }, [
              h(
                "div",
                { className: "usage-card-note", key: "l" },
                lines.join(", "),
              ),
              ...reasons.map((entry) =>
                h(
                  "div",
                  {
                    key: entry.key,
                    className: "usage-card-note",
                  },
                  entry.count > 1
                    ? `\u00d7${entry.count}  ${entry.reason}`
                    : entry.reason,
                ),
              ),
            ]),
          );
        }
      }

      return h(
        "div",
        { className: "usage-panel" },
        h("div", { className: "usage-inner" }, [
          h("style", { key: "css" }, CSS),
          header,
          payload !== null && payload.seeding
            ? h(
                "div",
                { className: "usage-progress", key: "p" },
                h("span", { key: "s" }),
              )
            : null,
          h(
            "div",
            {
              key: "body",
              className: "usage-body",
              "data-busy": busy ? "true" : "false",
            },
            body,
          ),
        ]),
      );
    }

    /** Sidebar entry glyph; the sidebar owns the button and its label. */
    function UsagePanelIcon(props) {
      const size = props.size ?? 18;
      return h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: size,
          height: size,
          fill: "currentColor",
          "aria-hidden": true,
          style: { display: "block" },
        },
        [
          h("rect", {
            x: 2,
            y: 13,
            width: 3.6,
            height: 9,
            rx: 1,
            opacity: 0.35,
            key: "a",
          }),
          h("rect", {
            x: 7.2,
            y: 8,
            width: 3.6,
            height: 14,
            rx: 1,
            opacity: 0.6,
            key: "b",
          }),
          h("rect", {
            x: 12.4,
            y: 3,
            width: 3.6,
            height: 19,
            rx: 1,
            opacity: 0.9,
            key: "c",
          }),
          h("rect", {
            x: 17.6,
            y: 10,
            width: 3.6,
            height: 12,
            rx: 1,
            opacity: 0.5,
            key: "d",
          }),
        ],
      );
    }

    //#endregion

    //#region dictionaries

    const zh = {
      panel: "\u7528\u91cf\u7edf\u8ba1",
      intro:
        "\u5168\u90e8\u4f1a\u8bdd\u7684\u6a21\u578b token \u7528\u91cf\uff0c\u6570\u636e\u76f4\u63a5\u53d6\u81ea adapter \u4e0a\u62a5\u3002",
      loading: "\u6b63\u5728\u8bfb\u53d6\u7528\u91cf\u2026",
      error: "\u65e0\u6cd5\u8bfb\u53d6\u7528\u91cf",
      noData: "\u5c1a\u672a\u8bb0\u5f55\u5230 token \u7528\u91cf\u3002",
      noTrend: "\u6682\u65e0\u8db3\u591f\u7684\u8d8b\u52bf\u6570\u636e\u3002",
      todayTokens: "\u5f53\u65e5 Token",
      allTokens: "\u7d2f\u8ba1 Token",
      cacheRate: "\u7f13\u5b58\u547d\u4e2d\u7387",
      cacheRateNote: "\u7f13\u5b58\u8bfb / \u8ba1\u8d39\u8f93\u5165",
      input: "\u8f93\u5165",
      output: "\u8f93\u51fa",
      cacheRead: "\u7f13\u5b58\u8bfb",
      tokens: "tokens",
      calls: "\u8bf7\u6c42\u6570",
      todayCalls: "\u5f53\u65e5\u8bf7\u6c42\u6570",
      allCalls: "\u7d2f\u8ba1\u8bf7\u6c42\u6570",
      todayRate: "\u5f53\u65e5\u7f13\u5b58\u7387",
      share: "\u5360\u6bd4",
      provider: "\u4f9b\u5e94\u5546",
      refresh: "\u5237\u65b0",
      activity: "Token \u6d3b\u52a8",
      dailyTrend: "\u6bcf\u65e5 Token \u8d8b\u52bf\u56fe",
      rangeLabel: "\u65f6\u95f4\u8303\u56f4",
      range7: "7\u5929",
      range30: "30\u5929",
      rangeAll: "\u5168\u90e8",
      byModel: "\u6a21\u578b\u7528\u91cf",
      breakdown: "\u6309\u6a21\u578b\u7edf\u8ba1",
      colModel: "\u6a21\u578b",
      colCalls: "\u8c03\u7528",
      colInput: "\u672a\u7f13\u5b58\u8f93\u5165",
      colOutput: "\u8f93\u51fa",
      colCacheRead: "\u7f13\u5b58\u8bfb",
      colCacheRate: "\u7f13\u5b58\u7387",
      colTotal: "\u5408\u8ba1",
      less: "\u5c11",
      more: "\u591a",
      "months.1": "\u4e00\u6708",
      "months.2": "\u4e8c\u6708",
      "months.3": "\u4e09\u6708",
      "months.4": "\u56db\u6708",
      "months.5": "\u4e94\u6708",
      "months.6": "\u516d\u6708",
      "months.7": "\u4e03\u6708",
      "months.8": "\u516b\u6708",
      "months.9": "\u4e5d\u6708",
      "months.10": "\u5341\u6708",
      "months.11": "\u5341\u4e00\u6708",
      "months.12": "\u5341\u4e8c\u6708",
      sessionsFailed: "\u4e2a\u4f1a\u8bdd\u65e0\u6cd5\u8bfb\u53d6",
      sessionsRecovered:
        "\u4e2a\u4f1a\u8bdd\u4ece\u65e7\u683c\u5f0f\u6062\u590d",
      malformedEvents: "\u6761\u7528\u91cf\u8bb0\u5f55\u5f02\u5e38",
    };

    const en = {
      panel: "Usage Statistics",
      intro:
        "Model token usage across every session, taken straight from adapter reports.",
      loading: "Reading usage\u2026",
      error: "Could not read usage",
      noData: "No token usage recorded yet.",
      noTrend: "Not enough trend data yet.",
      todayTokens: "Tokens today",
      allTokens: "Tokens total",
      cacheRate: "Cache hit rate",
      cacheRateNote: "cache read / billed input",
      input: "Input",
      output: "Output",
      cacheRead: "Cache read",
      tokens: "tokens",
      calls: "Requests",
      todayCalls: "Requests today",
      allCalls: "Requests total",
      todayRate: "Cache rate today",
      share: "Share",
      provider: "Provider",
      refresh: "Refresh",
      activity: "Token activity",
      dailyTrend: "Daily token trend",
      rangeLabel: "Range",
      range7: "7 days",
      range30: "30 days",
      rangeAll: "All",
      byModel: "Model usage",
      breakdown: "By model",
      colModel: "Model",
      colCalls: "Calls",
      colInput: "Uncached input",
      colOutput: "Output",
      colCacheRead: "Cache read",
      colCacheRate: "Cache rate",
      colTotal: "Total",
      less: "Less",
      more: "More",
      "months.1": "January",
      "months.2": "February",
      "months.3": "March",
      "months.4": "April",
      "months.5": "May",
      "months.6": "June",
      "months.7": "July",
      "months.8": "August",
      "months.9": "September",
      "months.10": "October",
      "months.11": "November",
      "months.12": "December",
      sessionsFailed: "sessions unreadable",
      sessionsRecovered: "sessions recovered from a legacy format",
      malformedEvents: "malformed usage records",
    };

    //#endregion

    //#region plugin

    /** Services this browser half needs. */
    const inject = ["slots", "locale"];

    /**
     * Register the sidebar entry, the dashboard panel, and its route data loader.
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      // The framework re-derives a slot's `t` on each locale switch but calls an
      // entry's inject factory exactly once, so the language probe needs a lookup
      // for every registered dictionary rather than a captured active locale.
      const dictionaryTranslateZh = dictionaryTranslate(zh);
      const dictionaryTranslateEn = dictionaryTranslate(en);
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "usage-stats: dictionaries",
      );

      /** Fetch the Host route as a Response so the panel can read its status. */
      const load = (search) =>
        fetch(`${DATA_URL}${search}`, {
          headers: { accept: "application/json" },
        });

      ctx.slots.inject("main", () =>
        ctx.slots.register(
          {
            name: "main",
            key: PANEL_ID,
            locale: NS,
            // The inject face is rebuilt on each render, so the panel sees the active
            // locale's date language without the framework having to publish it.
            inject: () => ({
              load,
              localeSource: {
                zh: dictionaryTranslateZh,
                en: dictionaryTranslateEn,
              },
            }),
          },
          UsagePanel,
        ),
      );

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 20,
            label: () => ctx.locale.bind(NS)("panel"),
            locale: NS,
          },
          UsagePanelIcon,
        ),
      );
    }

    //#endregion

    return { inject, apply };
  },
});
