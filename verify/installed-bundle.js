/**
 * Post-install report for a third-party bundle.
 *
 * Reads the installed package straight from disk (no PowerShell JSON, which
 * mangles non-ASCII) and prints what it actually contributes, so the install can
 * be judged on evidence rather than the registry blurb.
 *
 * Run: `node verify/installed-bundle.js dsh-cost-meter`
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const name = process.argv[2];
if (name === undefined) {
  console.log('usage: node verify/installed-bundle.js <package-name>');
  process.exit(1);
}

const dir = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', name);
if (!existsSync(dir)) {
  console.log(`not installed: ${dir}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
console.log(`${manifest.name}@${manifest.version}`);
console.log(`repository : ${manifest.repository?.url ?? '(none)'}`);
console.log(`license    : ${manifest.license}`);
console.log('');

console.log('--- what it declares ---');
console.log(`bundle patch      : ${manifest.dsh?.bundle?.patch ?? '(none)'}`);
console.log(`client platform   : ${manifest.dsh?.client?.platform ?? '(none)'}`);
console.log(`client external   : ${(manifest.dsh?.client?.external ?? []).join(', ') || '(none)'}`);
console.log(`runtime deps      : ${Object.keys(manifest.dependencies ?? {}).join(', ') || '(none)'}`);
console.log(`peer deps         : ${Object.keys(manifest.peerDependencies ?? {}).join(', ') || '(none)'}`);
console.log(`engines           : ${JSON.stringify(manifest.engines ?? {})}`);
console.log(`os                : ${(manifest.os ?? []).join(', ') || '(any)'}`);
console.log('');

const compat = manifest.dsh?.compatibility;
if (compat !== undefined) {
  console.log('--- declared dsh compatibility ---');
  console.log(`range : ${compat.dsh ?? '(none)'}`);
  const releases = compat.dshReleases ?? {};
  const entries = Object.entries(releases);
  const compatible = entries.filter(([, status]) => status === 'compatible').map(([version]) => version);
  const unknown = entries.filter(([, status]) => status !== 'compatible').map(([version]) => version);
  console.log(`compatible : ${compatible.join(', ') || '(none)'}`);
  if (unknown.length > 0) console.log(`not tested : ${unknown.join(', ')}`);
  console.log('');
}

const hub = manifest.dshhub;
if (hub !== undefined) {
  console.log('--- dshhub metadata ---');
  console.log(`display name  : ${hub.displayName ?? '(none)'}`);
  console.log(`categories    : ${(hub.categories ?? []).join(', ') || '(none)'}`);
  console.log(`surfaces      : ${(hub.surfaces ?? []).join(', ') || '(none)'}`);
  console.log(`provides      : ${(hub.capabilities?.provides ?? []).join(', ') || '(none)'}`);
  console.log(`schemaVersion : ${hub.schemaVersion ?? '(none)'}`);
  console.log('');
  const hosts = hub.permissions?.network ?? [];
  console.log(`--- declares network access to ${hosts.length} host(s) ---`);
  for (const host of hosts) console.log(`  ${host}`);
  console.log('');
}

const patchPath = join(dir, manifest.dsh?.bundle?.patch ?? '');
if (existsSync(patchPath)) {
  console.log('--- cordis.patch.yml ---');
  console.log(readFileSync(patchPath, 'utf8').trim());
  console.log('');
}

console.log('--- shipped artifacts ---');
for (const entry of manifest.files ?? []) {
  const full = join(dir, entry);
  const kind = existsSync(full) ? (statSync(full).isDirectory() ? 'dir ' : 'file') : 'MISSING';
  let detail = '';
  if (kind === 'file') detail = ` ${statSync(full).size} bytes`;
  console.log(`  ${kind.padEnd(8)} ${entry}${detail}`);
}
