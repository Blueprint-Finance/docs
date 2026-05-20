#!/usr/bin/env node
// Re-merge docs.json against the freshly-reset main right before publish.
//
// Why: the preprocessor reads BASE_DOCS_JSON once at job start. Anything that
// lands on main during the run (e.g. a Mintlify web-editor push — editor edits
// to docs.json are in our paths-ignore set, so they do not re-trigger the
// worker) would otherwise be silently overwritten by the worker's stale class-A
// nav when its output is copied back. This script runs after the publish step's
// `git reset --hard origin/main`, takes class-A from the now-fresh ./docs.json,
// keeps class-B from the worker output, and writes the merged result back into
// OUTPUT_DIR so the existing rsync overlay copies the correct file.
//
// Class-A is everything except CLASS_B_TABS; the worker re-emits class-B every
// run from FE/BE/SC sources. Non-`navigation` fields (theme, colors, footer, …)
// come from the fresh main copy, so editor edits to those are also preserved.

import fs from 'node:fs';
import path from 'node:path';

// MUST stay in sync with CLASS_B_TABS in scripts/preprocess-docs.mjs.
const CLASS_B_TABS = new Set(['Vaults', 'SDK', 'Backend API', 'Smart Contracts']);

const OUTPUT_DIR = process.env.OUTPUT_DIR;
if (!OUTPUT_DIR) {
  console.error('✗ OUTPUT_DIR env var is not set.');
  process.exit(1);
}

const freshPath = path.resolve('./docs.json');
const workerPath = path.join(OUTPUT_DIR, 'docs.json');

const fresh = JSON.parse(fs.readFileSync(freshPath, 'utf8'));
const worker = JSON.parse(fs.readFileSync(workerPath, 'utf8'));

const classA = (fresh.navigation?.tabs ?? []).filter((t) => !CLASS_B_TABS.has(t.tab));
const classB = (worker.navigation?.tabs ?? []).filter((t) => CLASS_B_TABS.has(t.tab));

const merged = {
  ...fresh,
  navigation: { ...(fresh.navigation ?? {}), tabs: [...classA, ...classB] },
};

fs.writeFileSync(workerPath, JSON.stringify(merged, null, 2) + '\n');
console.log(
  `Merged docs.json against fresh main: ${classA.length} class-A tab(s) + ` +
    `${classB.length} class-B tab(s) (${[...CLASS_B_TABS].join(', ')}).`,
);
