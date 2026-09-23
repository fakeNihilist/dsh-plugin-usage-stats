/**
 * Dev inventory: which native element tags each chart component renders.
 * Run: `node verify/chart-inventory.js`
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
for (const entry of starts) {
  const next = starts.find((other) => other.line > entry.line);
  const body = lines.slice(entry.line, next === undefined ? lines.length : next.line).join('\n');
  const tally = new Map();
  for (const match of body.matchAll(/\bh\('([a-z0-9]+)'/g)) {
    tally.set(match[1], (tally.get(match[1]) ?? 0) + 1);
  }
  if (tally.size === 0) continue;
  const list = [...tally.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([tag, count]) => `${tag}x${count}`)
    .join('  ');
  console.log(`${entry.name.padEnd(16)} ${list}`);
}

console.log('');
const requireCalls = [...readFileSync(join(here, '..', 'client.js'), 'utf8').matchAll(/require\('([^']+)'\)/g)]
  .map((match) => match[1]);
console.log('module requests  :', [...new Set(requireCalls)].join(', '));
