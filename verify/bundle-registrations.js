/**
 * What does an installed bundle's Host half actually register?
 *
 * Static analysis of the shipped `lib/index.js`: the Cordis service key, the
 * plugin name, the injection list, and the model-facing tools/commands it adds.
 * Answers "did it really wire itself up" without guessing from the activation
 * status alone.
 *
 * Run: `node verify/bundle-registrations.js dsh-cost-meter`
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const name = process.argv[2];
if (name === undefined) {
  console.log('usage: node verify/bundle-registrations.js <package-name>');
  process.exit(1);
}

const entry = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', name, 'lib', 'index.js');
if (!existsSync(entry)) {
  console.log(`no host half at ${entry}`);
  process.exit(1);
}
const src = readFileSync(entry, 'utf8');
console.log(`analyzing ${entry}`);
console.log(`size: ${src.length} bytes`);
console.log('');

/** Collect every capture of every pattern into one set. */
function collect(patterns) {
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

console.log('--- Cordis service keys registered ---');
const services = collect([
  /super\(\s*ctx\s*,\s*["']([A-Za-z0-9_-]+)["']/g,
  /ctx\.provide\(\s*["']([A-Za-z0-9_-]+)["']/g,
  /new\s+Service\([^,]+,\s*["']([A-Za-z0-9_-]+)["']/g,
  /Context\([^)]*\)\s*\{\s*([A-Za-z0-9_]+)\s*:/g,
]);
console.log(services.length > 0 ? services.map((key) => `  ${key}`).join('\n') : '  (none found statically)');
console.log('');

console.log('--- plugin identity ---');
const pluginName = /export\s+const\s+name\s*=\s*["']([^"']+)["']/.exec(src);
console.log(`  name   : ${pluginName === null ? '(none)' : pluginName[1]}`);
const inject = /export\s+const\s+inject\s*=\s*(\[[^\]]*\])/.exec(src);
console.log(`  inject : ${inject === null ? '(none)' : inject[1].replace(/\s+/g, ' ')}`);
console.log('');

console.log('--- model-facing tools registered ---');
const toolNames = new Set();
for (const match of src.matchAll(/name:\s*["']([a-z][a-z0-9_]{2,45})["']/g)) toolNames.add(match[1]);
const likelyTools = [...toolNames].filter((candidate) => (
  /^(cost|usage|balance|billing|price|budget|quota|ledger)/.test(candidate)
));
console.log(likelyTools.length > 0 ? likelyTools.map((tool) => `  ${tool}`).join('\n') : '  (none matching cost/usage/balance/…)');
console.log('');

console.log('--- external hosts referenced ---');
const hosts = new Set();
for (const match of src.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)) hosts.add(match[0]);
const sorted = [...hosts].sort();
console.log(`  count: ${sorted.length}`);
for (const host of sorted.slice(0, 25)) console.log(`  ${host}`);
if (sorted.length > 25) console.log(`  … and ${sorted.length - 25} more`);
