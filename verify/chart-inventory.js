/**
 * Dev inventory: which native element tags each chart component renders.
 * Run: `node verify/chart-inventory.js`
 *
 * This reads the bundle as text, so its patterns have to match the bundle's own
 * quoting: `client.js` is written with double quotes throughout. Matching one quote
 * style only silently produced an empty inventory — the script reported "no tags"
 * rather than failing, which is worse than no script at all.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(here, '..', 'client.js'), 'utf8').split('\n');

/** Every top-level function declaration inside the bundle factory. */
const starts = [];
for (let index = 0; index < lines.length; index += 1) {
  const match = /^    function ([A-Za-z0-9]+)\(/.exec(lines[index]);
  if (match !== null) starts.push({ name: match[1], line: index });
}

console.log('component        native tags rendered');
console.log('---------------- ------------------------------------------------');
let inventoried = 0;
let componentIndex = 0;
for (const entry of starts) {
  const next = starts.find((other) => other.line > entry.line);
  const body = lines.slice(entry.line, next === undefined ? lines.length : next.line).join('\n');
  const tally = new Map();
  // Both quote styles, so either authoring convention is read.
  for (const match of body.matchAll(/\bh\(["']([a-z0-9]+)["']/g)) {
    tally.set(match[1], (tally.get(match[1]) ?? 0) + 1);
  }
  // `h(SomeComponent, ...)` is not a native tag; those are counted separately so a
  // component that renders only other components still shows up in the list.
  const childComponents = [...body.matchAll(/\bh\(([A-Z][A-Za-z0-9]*)\b/g)].map((match) => match[1]);
  if (tally.size === 0 && childComponents.length === 0) continue;
  componentIndex += 1;
  const list = tally.size === 0
    ? `(via ${[...new Set(childComponents)].join(', ')})`
    : [...tally.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([tag, count]) => `${tag}x${count}`)
      .join('  ');
  console.log(`${entry.name.padEnd(16)} ${list}`);
  if (tally.size > 0) inventoried += 1;
}

console.log('');
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');
const requireCalls = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
console.log('module requests  :', [...new Set(requireCalls)].join(', '));
console.log('components       :', `${componentIndex} with rendered output, ${inventoried} rendering native tags`);

// A report that found nothing is a broken reader, not a bundle with no tags: the
// script used to print an empty table and exit 0, which read as success.
if (inventoried === 0) {
  console.error('FAIL: no native tags found in client.js — the patterns no longer match the source.');
  process.exitCode = 1;
}

