#!/usr/bin/env node
// Local preview builder for the aggregated Mintlify docs.
//
// Stages the sibling FE/BE/SC repos, seeds the base (class A) content, runs
// the preprocessor, and — with `npm run preview` — serves the result via
// `mint dev`. This mirrors what the GitHub Actions worker does, locally.
//
// Source repos default to siblings of this repo; override with FE_REPO /
// BE_REPO / SC_REPO. Requires STORYBLOK_PUBLIC; EARN_APY_API_URL is optional
// (BE enrichment). Both can also live in a gitignored scripts/.env.

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(import.meta.url), '../..');
const PARENT = path.dirname(REPO);
const WORK = path.join(REPO, '.preview');
const STAGING = path.join(WORK, '.staging');
const OUTPUT = path.join(WORK, '.output');

const SOURCES = {
  frontend: process.env.FE_REPO || path.join(PARENT, 'concrete-app-dev-02'),
  backend: process.env.BE_REPO || path.join(PARENT, 'cb_backend'),
  'smart-contracts': process.env.SC_REPO || path.join(PARENT, 'earn-v2-core'),
};

// Optional convenience: load a gitignored scripts/.env for unset vars.
function loadDotenv() {
  const envFile = path.join(REPO, 'scripts', '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

async function main() {
  loadDotenv();

  if (!process.env.STORYBLOK_PUBLIC) {
    console.error(
      '✗ STORYBLOK_PUBLIC is not set. Export it, or add it to a gitignored ' +
        'scripts/.env, and retry.',
    );
    process.exit(1);
  }
  for (const [name, dir] of Object.entries(SOURCES)) {
    if (!existsSync(dir)) {
      const v = { frontend: 'FE', backend: 'BE', 'smart-contracts': 'SC' }[name];
      console.error(`✗ ${name} repo not found: ${dir}\n  Set ${v}_REPO to its path.`);
      process.exit(1);
    }
  }

  // Fresh working tree with the source repos symlinked into staging.
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(STAGING, { recursive: true });
  for (const [name, dir] of Object.entries(SOURCES)) {
    await fs.symlink(dir, path.join(STAGING, name));
  }

  // Seed OUTPUT from the base repo (class A) — mirrors the workflow seed step.
  // Copy top-level entries one by one so OUTPUT (a subdir of REPO) is skipped.
  const EXCLUDE = new Set(['.git', '.github', 'scripts', '.preview', 'node_modules']);
  await fs.mkdir(OUTPUT, { recursive: true });
  for (const entry of await fs.readdir(REPO)) {
    if (EXCLUDE.has(entry)) continue;
    await fs.cp(path.join(REPO, entry), path.join(OUTPUT, entry), {
      recursive: true,
    });
  }

  // Run the preprocessor over the staged sources, overlaying class B.
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'preprocess-docs.mjs')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      STAGING_DIR: STAGING,
      OUTPUT_DIR: OUTPUT,
      BASE_DOCS_JSON: path.join(REPO, 'docs.json'),
    },
  });

  console.log(`\n✓ Preview built at ${OUTPUT}`);
  if (process.argv.includes('--serve')) {
    console.log('  Starting `mint dev` (Ctrl+C to stop)…\n');
    execFileSync('npx', ['-y', 'mint@latest', 'dev'], { cwd: OUTPUT, stdio: 'inherit' });
  } else {
    console.log(
      `  Serve it:  cd ${path.relative(process.cwd(), OUTPUT)} && npx mint@latest dev`,
    );
  }
}

main().catch((err) => {
  console.error(`\n✗ preview failed: ${err.message}`);
  process.exit(1);
});
