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
//   3. Fetch per-vault config from BE earn-apy /vault:performance.
//   4. For each FE earn MDX, expand <IfGate> + <IfVersion> and fill
//      {{ vault.* }} placeholders. Unknown gate ⇒ fail.
//   5. Copy FE sdk/, BE public/, SC public/ verbatim (all file types).
//   6. Assemble docs.json; copy _meta/INDEX.md + _meta/glossary.md.
//
// Gate model: every feature gate is vault-level — evaluated as
//   Boolean(vault.content[storyblok_field] ?? default). Group-level gates
//   (group_hidden, …) are dead and unused; they resolve to their default.
// Version axis: <IfVersion is="v2"> / <IfVersion not="v2"> resolves against
//   the vault's vaultVersion.
// Live vault set = Storyblok vaults ∩ FE _meta/earn-whitelist.json.

import fs from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const STAGING = path.resolve(process.env.STAGING_DIR ?? './.staging');
const OUTPUT = path.resolve(process.env.OUTPUT_DIR ?? './.output');
const BASE_DOCS_JSON = path.resolve(process.env.BASE_DOCS_JSON ?? './docs.json');
const STORYBLOK_TOKEN = process.env.STORYBLOK_PUBLIC;
// Resolved earn-apy base URL incl. /v1 (e.g. https://apy.api.<host>/v1).
// Unset ⇒ Phase 2 BE enrichment is skipped (placeholders stay unfilled).
const EARN_APY_API_URL = process.env.EARN_APY_API_URL?.replace(/\/+$/, '') ?? '';

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

// <IfVersion is="v2">…</IfVersion> / <IfVersion not="v2">…</IfVersion>
const IF_VERSION_RE =
  /<IfVersion\s+(is|not)=(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/IfVersion>/g;

async function main() {
  const gates = await loadGates();
  const vaults = await fetchVaults();
  if (vaults.length === 0) {
    throw new Error('Storyblok returned zero published vaults.');
  }

  const performance = await fetchVaultPerformance(vaults);
  for (const v of vaults) v.performance = performance.get(v.slug) ?? null;

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
    source: 'BE',
  });
  const scCount = await copyTree(SC_PUBLIC, path.join(OUTPUT, 'public'), {
    skipInternal: true,
    forbidIfGate: true,
    source: 'SC',
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

  if (unresolvedPlaceholders.length > 0) {
    const sample = unresolvedPlaceholders
      .slice(0, 6)
      .map((u) => `{{ ${u.ref} }} (${u.slug})`)
      .join(', ');
    console.warn(
      `⚠ ${unresolvedPlaceholders.length} unresolved {{ }} placeholders ` +
        `rendered as "—" — sample: ${sample}`,
    );
  }

  console.log(
    `Preprocessed ${earnFiles.length} FE-earn × ${vaults.length} vaults, ` +
      `${sdkPages.length} FE-sdk, ${beCount} BE files, ${scCount} SC files → ${OUTPUT}`,
  );
}

function notInternal(p) {
  return !p.split(path.sep).includes('internal');
}

// Every file written under OUTPUT is claimed by exactly one source. A second
// writer hitting the same path (e.g. BE and SC both shipping public/overview)
// would silently overwrite — fail loudly instead.
const claimedPaths = new Map();
function claimPath(dest, source) {
  const rel = path.relative(OUTPUT, dest);
  const prev = claimedPaths.get(rel);
  if (prev && prev !== source) {
    throw new Error(
      `Output path collision at ${rel}: written by both ${prev} and ${source}. ` +
        `Two sources produce the same path — namespace one of them.`,
    );
  }
  claimedPaths.set(rel, source);
}

// {{ }} placeholders that had no value — collected, warned once at the end.
const unresolvedPlaceholders = [];

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
        version: String(story.content.vaultVersion || 'v1').trim(),
        network: story.content.network ?? null,
        addresses: parseAddresses(story.content.addresses),
        deprecated: Boolean(story.content.deprecated || group.deprecated),
        content: story.content,
      });
    }
  }
  return applyWhitelist(vaults);
}

// Storyblok stores vault addresses as a newline-separated string; keep the
// valid lowercased EVM addresses (mirrors FE storyblok.ts).
function parseAddresses(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\n,]/)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
}

// The live Earn set is Storyblok ∩ FE earnWhitelist. FE emits the whitelist
// (whitelist ∪ extra-vault-addresses) to _meta/earn-whitelist.json. If the
// artifact is absent the worker still runs — it warns and keeps all vaults.
async function loadWhitelist() {
  const wl = path.join(FE_META, 'earn-whitelist.json');
  if (!fsExistsSync(wl)) return null;
  const doc = JSON.parse(await fs.readFile(wl, 'utf8'));
  const list = Array.isArray(doc) ? doc : (doc.addresses ?? []);
  return new Set(
    list.map((a) => String(a).trim().toLowerCase()).filter(Boolean),
  );
}

async function applyWhitelist(vaults) {
  const whitelist = await loadWhitelist();
  if (!whitelist) {
    console.warn(
      '⚠ _meta/earn-whitelist.json not found — processing all Storyblok ' +
        'vaults. The live Earn set is Storyblok ∩ whitelist; FE must emit it.',
    );
    return vaults;
  }
  const kept = vaults.filter((v) => v.addresses.some((a) => whitelist.has(a)));
  if (vaults.length > 0 && kept.length === 0) {
    // Distinguish "whitelist filtered everything out" from the genuine
    // "Storyblok returned nothing" case main() reports — otherwise an operator
    // debugs Storyblok when the real fault is the whitelist artifact.
    throw new Error(
      `Whitelist filtered out all ${vaults.length} Storyblok vaults — no vault ` +
        `address matched _meta/earn-whitelist.json. Check the whitelist artifact ` +
        `(and that the vaults carry addresses).`,
    );
  }
  console.log(
    `Whitelist: kept ${kept.length}/${vaults.length} vaults (Storyblok ∩ earnWhitelist).`,
  );
  return kept;
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

// --- BE earn-apy enrichment --------------------------------------------------
// Per-vault config from the public earn-apy API: version, implementation, and
// withdrawal config (cron schedule + cap threshold). The bulk
// /vault:performance/all endpoint is metrics-only, so it is used only to
// discover (address → chain_id); the detailed config comes from N parallel
// /vault:performance calls. An unset EARN_APY_API_URL or any failure degrades
// gracefully — the vault gets no BE data and its {{ }} placeholders show "—".

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// "v2" / "V2" / 2 / "2" → "2" — for comparing Storyblok and BE version values.
function normalizeVersion(v) {
  return String(v ?? '').trim().toLowerCase().replace(/^v/, '');
}

// Run fn over items with at most `limit` concurrent calls.
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const runner = async () => {
    while (cursor < items.length) {
      await fn(items[cursor++]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runner),
  );
}

async function fetchVaultPerformance(vaults) {
  if (!EARN_APY_API_URL) {
    console.warn(
      '⚠ EARN_APY_API_URL not set — skipping BE performance enrichment; ' +
        '{{ vault.* }} placeholders will render as "—".',
    );
    return new Map();
  }

  // Discover (address → chain_id) from the bulk endpoint.
  const addressToChain = new Map();
  try {
    const all = await fetchJson(`${EARN_APY_API_URL}/vault:performance/all`);
    for (const [chainId, byAddress] of Object.entries(all ?? {})) {
      for (const address of Object.keys(byAddress ?? {})) {
        addressToChain.set(address.toLowerCase(), Number(chainId));
      }
    }
  } catch (err) {
    console.warn(
      `⚠ earn-apy /vault:performance/all failed (${err.message}) — ` +
        'skipping BE enrichment.',
    );
    return new Map();
  }

  const result = new Map();
  await mapLimit(vaults, 8, async (vault) => {
    const address = vault.addresses.find((a) => addressToChain.has(a));
    if (!address) return;
    const chainId = addressToChain.get(address);
    try {
      const perf = await fetchJson(
        `${EARN_APY_API_URL}/vault:performance` +
          `?address=${address}&chain_id=${chainId}&limit=1`,
      );
      // Storyblok formats version as "v2"; BE returns a bare "2" — normalize
      // before comparing so the warning fires only on a genuine drift.
      if (
        perf?.version != null &&
        vault.version &&
        normalizeVersion(perf.version) !== normalizeVersion(vault.version)
      ) {
        console.warn(
          `⚠ Version mismatch for ${vault.slug}: Storyblok "${vault.version}" ` +
            `vs BE "${perf.version}".`,
        );
      }
      result.set(vault.slug, {
        version: perf?.version ?? null,
        implementation: perf?.implementation ?? null,
        withdrawals_config: perf?.withdrawals_config ?? null,
        withdrawals_config_rc: perf?.withdrawals_config_rc ?? null,
      });
    } catch (err) {
      console.warn(
        `⚠ earn-apy /vault:performance failed for ${vault.slug} (${err.message}).`,
      );
    }
  });
  console.log(
    `BE enrichment: fetched performance for ${result.size}/${vaults.length} vaults.`,
  );
  return result;
}

// The {{ }} substitution context exposed to FE earn templates.
function buildVaultContext(vault) {
  const perf = vault.performance;
  return {
    vault: {
      slug: vault.slug,
      name: vault.name,
      version: vault.version,
      network: vault.network,
      implementation: perf?.implementation ?? null,
      withdrawal: perf?.withdrawals_config ?? {},
      withdrawalRc: perf?.withdrawals_config_rc ?? {},
    },
  };
}

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

// Replace {{ vault.* }} placeholders with per-vault values. An unresolved
// placeholder renders as "—" and is collected for an end-of-run warning —
// leaving a literal {{ }} would break MDX parsing downstream.
function substitutePlaceholders(src, context, file, slug) {
  return src.replace(PLACEHOLDER_RE, (_match, dotted) => {
    const value = dotted
      .split('.')
      .reduce((node, key) => (node == null ? undefined : node[key]), context);
    if (value == null || value === '') {
      unresolvedPlaceholders.push({
        file: path.relative(STAGING, file),
        slug,
        ref: dotted,
      });
      return '—';
    }
    return String(value);
  });
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
    const gateExpanded = src.replace(
      IF_GATE_RE,
      (_match, dq, sq, inverse, body) => {
        const flag = dq ?? sq;
        const enabled = gateValues.get(flag) === true;
        const show = inverse ? !enabled : enabled;
        return show ? body : '';
      },
    );
    const versionExpanded = gateExpanded.replace(
      IF_VERSION_RE,
      (_match, attr, dq, sq, body) => {
        const want = dq ?? sq;
        const matches = vault.version === want;
        const show = attr === 'is' ? matches : !matches;
        return show ? body : '';
      },
    );
    const rendered = substitutePlaceholders(
      versionExpanded,
      buildVaultContext(vault),
      file,
      vault.slug,
    );
    const dest = path.join(OUTPUT, 'public', vault.slug, relFromEarn);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    claimPath(dest, 'FE-earn');
    await fs.writeFile(dest, rendered);
    renderedByVault.get(vault.slug).push(relFromEarn);
  }
}

async function copyMdxOnce(file, srcRoot, dstRoot) {
  const src = await fs.readFile(file, 'utf8');
  assertNoConditionals(src, file);
  const dest = path.join(dstRoot, path.relative(srcRoot, file));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  claimPath(dest, 'FE-sdk');
  await fs.writeFile(dest, src);
}

// <IfGate>/<IfVersion> are FE-earn-only — BE/SC/FE-sdk content must not use them.
function assertNoConditionals(src, file) {
  for (const [re, tag] of [
    [IF_GATE_RE, '<IfGate>'],
    [IF_VERSION_RE, '<IfVersion>'],
  ]) {
    re.lastIndex = 0;
    const hit = re.test(src);
    re.lastIndex = 0;
    if (hit) {
      throw new Error(
        `${tag} is FE-earn-only but appears in ${path.relative(STAGING, file)}. ` +
          `BE/SC content is vault-invariant — remove it or move the rule to FE earn.`,
      );
    }
  }
}

// Copy a whole directory tree verbatim (all file types). Skips internal/
// subtrees; .mdx files are checked to ensure they carry no <IfGate>.
async function copyTree(src, dst, { skipInternal, forbidIfGate, source } = {}) {
  if (!fsExistsSync(src)) return 0;
  let count = 0;
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (skipInternal && entry.isDirectory() && entry.name === 'internal') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += await copyTree(s, d, { skipInternal, forbidIfGate, source });
    } else {
      await fs.mkdir(path.dirname(d), { recursive: true });
      claimPath(d, source);
      if (forbidIfGate && entry.name.endsWith('.mdx')) {
        const content = await fs.readFile(s, 'utf8');
        assertNoConditionals(content, s);
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
      vaults.map((v) => ({
        slug: v.slug,
        name: v.name,
        version: v.version,
        network: v.network,
        implementation: v.performance?.implementation ?? null,
        deprecated: v.deprecated,
      })),
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
