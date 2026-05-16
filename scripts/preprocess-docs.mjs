#!/usr/bin/env node
// Concrete Mintlify preprocessor.
//
// Aggregates docs/business/ from FE/BE/SC into one Mintlify site:
//   - FE earn rules are expanded per Storyblok vault via <IfGate>.
//   - FE sdk / BE / SC content is copied verbatim (no per-vault expansion).
//   - docs.json navigation is assembled from the base repo + a generated
//     Earn tab + BE's and SC's own docs.json (paths normalized).
//
// Pipeline:
//   1. Load _meta/gates.yaml → gate name → {storyblok_field, default}.
//   2. Fetch the `earn` story from Storyblok (mirrors the FE getStory
//      contract in Concrete-app/src/core/utils/storyblok.ts).
//   3. For each FE earn MDX, evaluate every gate per vault and expand
//      <IfGate flag="…"> / <IfGate flag="…" inverse>. Unknown gate ⇒ fail.
//   4. Copy FE sdk/, BE public/, SC public/ verbatim (all file types).
//   5. Assemble docs.json; copy _meta/INDEX.md + _meta/glossary.md.
//
// Gate model: every gate is vault-level — evaluated as
//   Boolean(vault.content[storyblok_field] ?? default).
// Group-level gates (group_hidden, group_deprecated, simple_balance) are dead
// and unused; they simply resolve to their default.

import fs from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const STAGING = path.resolve(process.env.STAGING_DIR ?? './.staging');
const OUTPUT = path.resolve(process.env.OUTPUT_DIR ?? './.output');
const BASE_DOCS_JSON = path.resolve(process.env.BASE_DOCS_JSON ?? './docs.json');
const STORYBLOK_TOKEN = process.env.STORYBLOK_PUBLIC;

const FE_ROOT = path.join(STAGING, 'frontend', 'docs', 'business');
const BE_ROOT = path.join(STAGING, 'backend', 'docs', 'business');
const SC_ROOT = path.join(STAGING, 'smart-contracts', 'docs', 'business');
const FE_META = path.join(FE_ROOT, '_meta');
const FE_EARN = path.join(FE_ROOT, 'public', 'earn');
const FE_SDK = path.join(FE_ROOT, 'public', 'sdk');
const BE_PUBLIC = path.join(BE_ROOT, 'public');
const SC_PUBLIC = path.join(SC_ROOT, 'public');
const BE_DOCS_JSON = path.join(BE_ROOT, 'docs.json');
const SC_DOCS_JSON = path.join(SC_ROOT, 'docs.json');

const STORYBLOK_API = 'https://api-us.storyblok.com/v2/cdn';
const RESOLVE_RELATIONS =
  'VaultGroupContent.vaults,VaultsContent.auditors,VaultsContent.vaultOwner';

const IF_GATE_RE =
  /<IfGate\s+flag=(?:"([^"]+)"|'([^']+)')(\s+inverse)?\s*>([\s\S]*?)<\/IfGate>/g;

async function main() {
  const gates = await loadGates();
  const vaults = await fetchVaults();
  if (vaults.length === 0) {
    throw new Error('Storyblok returned zero published vaults.');
  }

  const referencedGates = new Set();
  const renderedByVault = new Map(vaults.map((v) => [v.slug, []]));

  // FE earn → per-vault <IfGate> expansion.
  const earnFiles = (await collectMdx([FE_EARN])).filter(notInternal);
  for (const file of earnFiles) {
    await renderEarnPerVault(file, vaults, gates, referencedGates, renderedByVault);
  }

  // FE sdk → copy once verbatim.
  const sdkPages = [];
  for (const file of (await collectMdx([FE_SDK])).filter(notInternal)) {
    await copyMdxOnce(file, FE_SDK, path.join(OUTPUT, 'public', 'sdk'));
    sdkPages.push(
      'public/sdk/' + toPageRef(path.relative(FE_SDK, file)),
    );
  }

  // BE / SC public/ → copy whole tree verbatim (carries OpenAPI *.json).
  const beCount = await copyTree(BE_PUBLIC, path.join(OUTPUT, 'public'), {
    skipInternal: true,
    forbidIfGate: true,
  });
  const scCount = await copyTree(SC_PUBLIC, path.join(OUTPUT, 'public'), {
    skipInternal: true,
    forbidIfGate: true,
  });

  for (const gate of gates.keys()) {
    if (!referencedGates.has(gate)) {
      console.warn(
        `⚠ Gate "${gate}" is declared in gates.yaml but not referenced by any MDX.`,
      );
    }
  }

  await copyMetaArtifacts();
  await emitDocsJson(vaults, renderedByVault, sdkPages.sort());

  console.log(
    `Preprocessed ${earnFiles.length} FE-earn × ${vaults.length} vaults, ` +
      `${sdkPages.length} FE-sdk, ${beCount} BE files, ${scCount} SC files → ${OUTPUT}`,
  );
}

function notInternal(p) {
  return !p.split(path.sep).includes('internal');
}

// A Mintlify page ref drops the .mdx/.md extension and uses POSIX separators.
function toPageRef(rel) {
  return rel.replace(/\.mdx?$/, '').split(path.sep).join('/');
}

async function loadGates() {
  const gatesPath = path.join(FE_META, 'gates.yaml');
  const raw = await fs.readFile(gatesPath, 'utf8');
  const doc = yaml.load(raw) ?? {};
  const declared = doc.gates ?? doc;
  if (typeof declared !== 'object' || declared === null) {
    throw new Error(`gates.yaml is malformed: ${gatesPath}`);
  }
  const map = new Map();
  for (const [name, def] of Object.entries(declared)) {
    map.set(name, {
      storyblok_field: def?.storyblok_field ?? name,
      default: def?.default === true,
    });
  }
  return map;
}

// --- Storyblok ---------------------------------------------------------------
// Mirrors Concrete-app/src/core/utils/storyblok.ts:getStory for the public,
// production read path: GET /v2/cdn/stories/earn with cv from /spaces/me; if
// resolve_relations under-fetches (>25-50 refs), paginate via by_uuids with
// explicit per_page. Hidden Storyblok groups (group.hidden) are excluded.
async function fetchVaults() {
  if (!STORYBLOK_TOKEN) {
    throw new Error('STORYBLOK_PUBLIC env var is not set.');
  }

  const cv = await fetchCacheVersion(STORYBLOK_TOKEN);

  const url = new URL(`${STORYBLOK_API}/stories/earn`);
  url.searchParams.set('token', STORYBLOK_TOKEN);
  url.searchParams.set('resolve_relations', RESOLVE_RELATIONS);
  if (cv) url.searchParams.set('cv', cv);

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Storyblok /stories/earn failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!data?.story?.content?.groups) {
    throw new Error('Storyblok response missing story.content.groups.');
  }

  const relsMap = new Map((data.rels ?? []).map((r) => [r.uuid, r]));
  const expectedUuids = new Set();
  for (const group of data.story.content.groups) {
    if (!Array.isArray(group.vaults)) continue;
    for (const uuid of group.vaults) {
      if (typeof uuid === 'string') expectedUuids.add(uuid);
    }
  }

  const missing = [...expectedUuids].filter((u) => !relsMap.has(u));
  if (missing.length > 0) {
    await hydrateMissingRelations(missing, relsMap, STORYBLOK_TOKEN, cv);
  }

  const vaults = [];
  const seenSlugs = new Set();
  for (const group of data.story.content.groups) {
    if (group.hidden === true) continue;
    if (!Array.isArray(group.vaults)) continue;
    for (const uuid of group.vaults) {
      const story = relsMap.get(uuid);
      if (!story?.content) continue;
      const slug = String(story.content.slug ?? '').trim();
      if (!slug || seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      vaults.push({
        slug,
        name: story.content.name ?? story.name ?? slug,
        deprecated: Boolean(story.content.deprecated || group.deprecated),
        content: story.content,
      });
    }
  }
  return vaults;
}

async function fetchCacheVersion(token) {
  const res = await fetch(`${STORYBLOK_API}/spaces/me?token=${token}`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.space?.version ? String(data.space.version) : null;
}

async function hydrateMissingRelations(missing, relsMap, token, cv) {
  const BATCH = 50;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const url = new URL(`${STORYBLOK_API}/stories`);
    url.searchParams.set('token', token);
    url.searchParams.set('by_uuids', batch.join(','));
    // by_uuids defaults to per_page=25 and silently drops the rest — match
    // the batch size explicitly. See FE storyblok.ts for the same fix.
    url.searchParams.set('per_page', String(batch.length));
    url.searchParams.set('resolve_relations', RESOLVE_RELATIONS);
    if (cv) url.searchParams.set('cv', cv);

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(
        `Storyblok by_uuids batch failed: ${res.status} ${res.statusText}`,
      );
    }
    const data = await res.json();
    for (const story of data.stories ?? []) relsMap.set(story.uuid, story);
    for (const rel of data.rels ?? []) relsMap.set(rel.uuid, rel);
  }
}

// Resolve every gate for one vault: Boolean(content[storyblok_field] ?? default).
function evaluateGates(content, gatesMap) {
  const result = new Map();
  for (const [name, { storyblok_field, default: dflt }] of gatesMap) {
    const raw = content?.[storyblok_field];
    result.set(name, Boolean(raw ?? dflt));
  }
  return result;
}

// --- MDX walk + render -------------------------------------------------------

async function collectMdx(roots) {
  const out = [];
  for (const root of roots) {
    if (!fsExistsSync(root)) continue;
    out.push(...(await walk(root, (p) => p.endsWith('.mdx'))));
  }
  return out;
}

async function renderEarnPerVault(file, vaults, gates, referencedGates, renderedByVault) {
  const src = await fs.readFile(file, 'utf8');

  for (const match of src.matchAll(IF_GATE_RE)) {
    const flag = match[1] ?? match[2];
    referencedGates.add(flag);
    if (!gates.has(flag)) {
      throw new Error(
        `Unknown gate "${flag}" referenced in ${path.relative(STAGING, file)} — ` +
          `add it to _meta/gates.yaml or remove the <IfGate>.`,
      );
    }
  }

  const relFromEarn = path.relative(FE_EARN, file);

  for (const vault of vaults) {
    const gateValues = evaluateGates(vault.content, gates);
    const rendered = src.replace(
      IF_GATE_RE,
      (_match, dq, sq, inverse, body) => {
        const flag = dq ?? sq;
        const enabled = gateValues.get(flag) === true;
        const show = inverse ? !enabled : enabled;
        return show ? body : '';
      },
    );
    const dest = path.join(OUTPUT, 'public', vault.slug, relFromEarn);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, rendered);
    renderedByVault.get(vault.slug).push(relFromEarn);
  }
}

async function copyMdxOnce(file, srcRoot, dstRoot) {
  const src = await fs.readFile(file, 'utf8');
  assertNoIfGate(src, file);
  const dest = path.join(dstRoot, path.relative(srcRoot, file));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, src);
}

function assertNoIfGate(src, file) {
  IF_GATE_RE.lastIndex = 0;
  if (IF_GATE_RE.test(src)) {
    IF_GATE_RE.lastIndex = 0;
    throw new Error(
      `<IfGate> is FE-earn-only but appears in ${path.relative(STAGING, file)}. ` +
        `BE and SC content is vault-invariant — remove the gate or move the rule to FE.`,
    );
  }
  IF_GATE_RE.lastIndex = 0;
}

// Copy a whole directory tree verbatim (all file types). Skips internal/
// subtrees; .mdx files are checked to ensure they carry no <IfGate>.
async function copyTree(src, dst, { skipInternal, forbidIfGate } = {}) {
  if (!fsExistsSync(src)) return 0;
  let count = 0;
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (skipInternal && entry.isDirectory() && entry.name === 'internal') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += await copyTree(s, d, { skipInternal, forbidIfGate });
    } else {
      await fs.mkdir(path.dirname(d), { recursive: true });
      if (forbidIfGate && entry.name.endsWith('.mdx')) {
        const content = await fs.readFile(s, 'utf8');
        assertNoIfGate(content, s);
        await fs.writeFile(d, content);
      } else {
        await fs.copyFile(s, d);
      }
      count += 1;
    }
  }
  return count;
}

async function copyMetaArtifacts() {
  const metaDst = path.join(OUTPUT, '_meta');
  await fs.mkdir(metaDst, { recursive: true });
  for (const file of ['INDEX.md', 'glossary.md']) {
    const src = path.join(FE_META, file);
    if (fsExistsSync(src)) {
      await fs.copyFile(src, path.join(metaDst, file));
    }
  }
}

// --- docs.json assembly ------------------------------------------------------

async function emitDocsJson(vaults, renderedByVault, sdkPages) {
  const base = JSON.parse(await fs.readFile(BASE_DOCS_JSON, 'utf8'));

  const tabs = [];

  // Documentation tab: base intro pages + shared reference.
  const docGroups = [
    {
      group: 'Overview',
      pages: ['introduction', 'how-it-works', 'key-concepts'],
    },
  ];
  const refPages = [];
  if (fsExistsSync(path.join(OUTPUT, '_meta', 'INDEX.md'))) refPages.push('_meta/INDEX');
  if (fsExistsSync(path.join(OUTPUT, '_meta', 'glossary.md'))) {
    refPages.push('_meta/glossary');
  }
  if (refPages.length > 0) docGroups.push({ group: 'Reference', pages: refPages });
  tabs.push({ tab: 'Documentation', groups: docGroups });

  // Earn tab: one group per vault + SDK.
  const earnGroups = vaults.map((vault) => {
    const pages = (renderedByVault.get(vault.slug) ?? [])
      .map((rel) => `public/${vault.slug}/${toPageRef(rel)}`)
      .sort();
    return { group: `Vault: ${vault.name}`, pages };
  }).filter((g) => g.pages.length > 0);
  if (sdkPages.length > 0) earnGroups.push({ group: 'SDK', pages: sdkPages });
  if (earnGroups.length > 0) tabs.push({ tab: 'Earn', groups: earnGroups });

  // API Reference tab: BE's own docs.json groups (paths already root-relative).
  const beGroups = await loadSourceGroups(BE_DOCS_JSON);
  if (beGroups.length > 0) tabs.push({ tab: 'API Reference', groups: beGroups });

  // Smart Contracts tab: SC's own docs.json groups, paths normalized.
  const scGroups = await loadSourceGroups(SC_DOCS_JSON);
  if (scGroups.length > 0) tabs.push({ tab: 'Smart Contracts', groups: scGroups });

  base.navigation = { tabs };

  await fs.writeFile(
    path.join(OUTPUT, 'docs.json'),
    JSON.stringify(base, null, 2) + '\n',
  );
  await fs.mkdir(path.join(OUTPUT, '_meta'), { recursive: true });
  await fs.writeFile(
    path.join(OUTPUT, '_meta', 'vaults.json'),
    JSON.stringify(
      vaults.map(({ slug, name, deprecated }) => ({ slug, name, deprecated })),
      null,
      2,
    ),
  );
}

// Read a source repo's docs.json and return its navigation groups, with all
// page/openapi paths normalized to the aggregated output root (a leading
// `business/` segment is stripped — SC authors paths relative to docs/).
async function loadSourceGroups(docsJsonPath) {
  if (!fsExistsSync(docsJsonPath)) return [];
  const doc = JSON.parse(await fs.readFile(docsJsonPath, 'utf8'));
  let groups = [];
  if (Array.isArray(doc.navigation?.tabs)) {
    groups = doc.navigation.tabs.flatMap((t) => t.groups ?? []);
  } else if (Array.isArray(doc.groups)) {
    groups = doc.groups;
  }
  return normalizeNavPaths(groups);
}

function normalizeNavPaths(node) {
  if (typeof node === 'string') {
    return node.replace(/^business\//, '');
  }
  if (Array.isArray(node)) {
    return node.map(normalizeNavPaths);
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'source' && typeof value === 'string') {
        out[key] = value.replace(/^business\//, '');
      } else {
        out[key] = normalizeNavPaths(value);
      }
    }
    return out;
  }
  return node;
}

async function walk(dir, filter) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p, filter)));
    else if (filter(p)) out.push(p);
  }
  return out;
}

main().catch((err) => {
  console.error(`\n✗ Preprocessor failed: ${err.message}`);
  process.exit(1);
});
