#!/usr/bin/env node
/**
 * Bundle-size guard: fails when the JS the shell loads at startup, or a
 * module's bundle, grows past its budget.
 *
 * Run after `npm run build -w @zollify/web` and `npm run build:modules`:
 *
 *   node scripts/check-bundle-size.mjs
 *
 * Startup JS is what apps/web/dist/index.html itself asks for: its
 * <script src> entries plus its <link rel="modulepreload"> chunks (Vite lists
 * the entry's whole static import graph there). Lazy route chunks and the
 * /host/* import-map targets that are not preloaded do not count - they are
 * not paid for before the first screen.
 *
 * All sizes are gzip (level 9), which is close to what a device downloads.
 *
 * A budget is a tripwire, not a target. When a change legitimately needs more,
 * raise the number in the same PR and say why; when a bundle shrinks for good,
 * lower it so the gain cannot quietly be given back.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KB = 1000;

/** Startup JS, gzip bytes. Measured 205.5 kB when this was set (+15%). */
export const STARTUP_BUDGET = 236 * KB;

/**
 * Any module without its own entry below, gzip bytes. Measured largest
 * non-tax module when this was set: pos, 58.8 kB (+25%).
 */
export const MODULE_DEFAULT_BUDGET = 74 * KB;

/** Per-module exceptions, gzip bytes, keyed by the directory under modules/. */
export const MODULE_BUDGETS = {
  // xlsx and jspdf are inlined into this bundle (534.8 kB measured). Lower
  // this - or delete the entry - once they are loaded on demand instead.
  tax: 545 * KB,
};

const gzipSize = (file) => gzipSync(readFileSync(file), { level: 9 }).length;
const kb = (bytes) => `${(bytes / KB).toFixed(1)} kB`;

/** The JS files index.html loads before anything runs, as paths under dist/. */
export function startupScripts(html) {
  const found = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attr = (name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
    const isScript = /^<script/i.test(tag);
    const url = isScript ? attr('src') : /\bmodulepreload\b/i.test(attr('rel') ?? '') ? attr('href') : undefined;
    if (!url || /^(?:[a-z]+:)?\/\//i.test(url)) continue;
    found.add(url.replace(/[?#].*$/, '').replace(/^\.?\//, ''));
  }
  return [...found];
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ')).join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = [];
  const rows = [['bundle', 'gzip', 'budget', 'used', '']];
  const check = (name, size, budget) => {
    const over = size > budget;
    if (over) failures.push(`${name}: ${kb(size)} is over its budget of ${kb(budget)} by ${kb(size - budget)}`);
    rows.push([name, kb(size), kb(budget), `${Math.round((size / budget) * 100)}%`, over ? 'OVER' : 'ok']);
  };

  const dist = join(root, 'apps/web/dist');
  const indexHtml = join(dist, 'index.html');
  if (!existsSync(indexHtml)) {
    console.error(`No ${indexHtml} - run \`npm run build -w @zollify/web\` first.`);
    process.exit(1);
  }
  const scripts = startupScripts(readFileSync(indexHtml, 'utf8'));
  if (scripts.length === 0) {
    console.error(`${indexHtml} loads no local scripts - the startup measurement would be meaningless.`);
    process.exit(1);
  }
  const startup = [];
  for (const script of scripts) {
    const file = join(dist, script);
    if (!existsSync(file)) {
      console.error(`index.html loads ${script}, which is not in ${dist}.`);
      process.exit(1);
    }
    startup.push([script, gzipSize(file)]);
  }
  check(
    `startup JS (${startup.length} files)`,
    startup.reduce((sum, [, size]) => sum + size, 0),
    STARTUP_BUDGET,
  );

  const modulesDir = join(root, 'modules');
  const modules = readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(modulesDir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
  const built = [];
  for (const name of modules) {
    const bundle = join(modulesDir, name, 'dist/bundle.js');
    if (!existsSync(bundle)) {
      failures.push(`modules/${name}: no dist/bundle.js - run \`npm run build:modules\` first (is the module in that script?)`);
      continue;
    }
    built.push([name, gzipSize(bundle)]);
  }
  built.sort((a, b) => b[1] - a[1]);
  for (const [name, size] of built) check(`module ${name}`, size, MODULE_BUDGETS[name] ?? MODULE_DEFAULT_BUDGET);

  console.log(table(rows));
  console.log(`\nStartup files:\n${table(startup.sort((a, b) => b[1] - a[1]).map(([file, size]) => [`  ${file}`, kb(size)]))}`);

  if (failures.length > 0) {
    console.error(`\nBundle size check failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    console.error('\nBudgets are in scripts/check-bundle-size.mjs. Raise one only with a reason in the PR.');
    process.exit(1);
  }
  console.log('\nBundle sizes are within budget.');
}
