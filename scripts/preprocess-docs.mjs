#!/usr/bin/env node
// Concrete Mintlify preprocessor.
//
// Per the 2026-05-14 coordination decision (~/.claude/coordination/mintlify.md):
// <IfGate>/gates[] are FE-only. BE API docs and SC contract docs are
// vault-invariant and are copied through verbatim. Only FE earn rules are
// expanded per Storyblok vault.
//
// Pipeline:
//   1. Load _meta/gates.yaml (single source of truth for IfGate flags).
//   2. Fetch the `earn` story from Storyblok, mirroring the FE contract in
//      Concrete-app/src/core/utils/storyblok.ts:getStory.
//   3. For each FE earn MDX, expand <IfGate flag="…"> / <IfGate flag="…" inverse>
//      per vault. Fail on unknown gates; warn on declared-but-unused gates.
//      Emit to public/<vault-slug>/<rel-from-earn>.
//   4. Copy FE sdk/, BE public/, SC public/ verbatim (validating that no
//      <IfGate> sneaks in from those repos).
//   5. Regenerate docs.json: replace the "Vaults" placeholder with one group
//      per published vault, listing the MDX files actually rendered for it.
//   6. Copy across _meta/INDEX.md, _meta/glossary.md, and any OpenAPI specs.

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

  // FE earn → per-vault expansion.
  const earnFiles = (await collectMdx([FE_EARN])).filter(notInternal);
  for (const file of earnFiles) {
    await renderEarnPerVault(file, vaults, gates, referencedGates, renderedByVault);
  }

  // FE sdk → copy once. Validate no <IfGate> sneaks in.
  const sdkFiles = (await collectMdx([FE_SDK])).filter(notInternal);
  for (const file of sdkFiles) {
    await copyOnce(file, FE_SDK, path.join(OUTPUT, 'public', 'sdk'), {
      forbidIfGate: true,
    });
  }

  // BE public → copy once verbatim.
  const beFiles = (await collectMdx([BE_PUBLIC])).filter(notInternal);
  for (const file of beFiles) {
    await copyOnce(file, BE_PUBLIC, path.join(OUTPUT, 'public'), {
      forbidIfGate: true,
    });
  }

  // SC public → copy once verbatim.
  const scFiles = (await collectMdx([SC_PUBLIC])).filter(notInternal);
  for (const file of scFiles) {
    await copyOnce(file, SC_PUBLIC, path.join(OUTPUT, 'public'), {
      forbidIfGate: true,
    });
  }

  for (const gate of gates) {
    if (!referencedGates.has(gate)) {
      console.warn(
        `⚠ Gate "${gate}" is declared in gates.yaml but not referenced by any MDX.`,
      );
    }
  }

  await copyMetaArtifacts();
  await copyOpenApiSpecs();
  await emitDocsJson(vaults, renderedByVault);

  const totals = `${earnFiles.length} FE-earn × ${vaults.length} vaults, ${sdkFiles.length} FE-sdk, ${beFiles.length} BE, ${scFiles.length} SC`;
  console.log(`Preprocessed ${totals} → ${OUTPUT}`);
}

function notInternal(p) {
  return !p.split(path.sep).includes('internal');
}

async function loadGates() {
  const gatesPath = path.join(FE_META, 'gates.yaml');
  const raw = await fs.readFile(gatesPath, 'utf8');
  const doc = yaml.load(raw) ?? {};
  const declared = doc.gates ?? doc;
  if (typeof declared !== 'object' || declared === null) {
    throw new Error(`gates.yaml is malformed: ${gatesPath}`);
  }
  return new Set(Object.keys(declared));
}

// --- Storyblok ---------------------------------------------------------------
// Mirrors Concrete-app/src/core/utils/storyblok.ts:getStory for the public,
// production read path:
//   - GET /v2/cdn/stories/earn?token=…&resolve_relations=…&cv=…
//   - cv comes from /v2/cdn/spaces/me
//   - if resolve_relations under-fetches (>25-50 refs), paginate via by_uuids
//     with explicit per_page
//   - drop hidden groups (`group.hidden === true`)
//   - vault.flags is a comma-separated string on the Storyblok side; we
//     normalize it to a Set<string> of enabled flag names.
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
        flags: parseFlagsCsv(story.content.flags),
        deprecated: Boolean(story.content.deprecated || group.deprecated),
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

function parseFlagsCsv(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
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
    const rendered = src.replace(
      IF_GATE_RE,
      (_match, dq, sq, inverse, body) => {
        const flag = dq ?? sq;
        const enabled = vault.flags.has(flag);
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

async function copyOnce(file, srcRoot, dstRoot, { forbidIfGate } = {}) {
  const src = await fs.readFile(file, 'utf8');
  if (forbidIfGate && IF_GATE_RE.test(src)) {
    // IF_GATE_RE has /g — reset lastIndex defensively before throwing.
    IF_GATE_RE.lastIndex = 0;
    throw new Error(
      `<IfGate> is FE-only but appears in ${path.relative(STAGING, file)}. ` +
        `BE and SC content is vault-invariant — remove the gate or move the rule to FE.`,
    );
  }
  IF_GATE_RE.lastIndex = 0;
  const rel = path.relative(srcRoot, file);
  const dest = path.join(dstRoot, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, src);
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

async function copyOpenApiSpecs() {
  const dst = path.join(OUTPUT, 'api-reference');
  await fs.mkdir(dst, { recursive: true });
  for (const root of [BE_ROOT, SC_ROOT]) {
    const candidate = path.join(root, 'openapi');
    if (fsExistsSync(candidate)) await copyDir(candidate, dst);
  }
}

async function emitDocsJson(vaults, renderedByVault) {
  const base = JSON.parse(await fs.readFile(BASE_DOCS_JSON, 'utf8'));
  const docsTab = base.navigation?.tabs?.find((t) => t.tab === 'Documentation');
  if (!docsTab) {
    throw new Error('Base docs.json missing "Documentation" tab.');
  }

  const placeholderIdx = docsTab.groups.findIndex((g) => g.group === 'Vaults');

  const generated = vaults
    .filter((v) => !v.deprecated)
    .map((vault) => {
      const rels = renderedByVault.get(vault.slug) ?? [];
      const pages = rels
        .map((r) => `public/${vault.slug}/${r.replace(/\.mdx$/, '').split(path.sep).join('/')}`)
        .sort();
      return { group: `Vault: ${vault.name}`, pages };
    })
    .filter((g) => g.pages.length > 0);

  if (placeholderIdx >= 0) {
    docsTab.groups.splice(placeholderIdx, 1, ...generated);
  } else {
    docsTab.groups.push(...generated);
  }

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

async function walk(dir, filter) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p, filter)));
    else if (filter(p)) out.push(p);
  }
  return out;
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

main().catch((err) => {
  console.error(`\n✗ Preprocessor failed: ${err.message}`);
  process.exit(1);
});
