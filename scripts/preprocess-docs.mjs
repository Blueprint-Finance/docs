#!/usr/bin/env node
// Concrete Mintlify preprocessor.
//
// Aggregates docs/business/ from FE/BE/SC into one Mintlify site — two content
// classes (see ~/.claude/coordination/mintlify.md "Documentation compilation
// model"):
//   - Class A: the base repo's conceptual docs — its docs.json nav is kept.
//   - Class B: per-vault composed docs — FE earn rules, gated/version-resolved
//     and {{ }}-filled, composed into one page per theme, per vault.
//
// Pipeline:
//   1. Load _meta/gates.yaml → gate name → {storyblok_field, default}.
//   2. Fetch the `earn` story from Storyblok (mirrors the FE getStory
//      contract in Concrete-app/src/core/utils/storyblok.ts).
//   3. Fetch per-vault config from BE earn-apy /vault:performance.
//   4. Per vault, per theme: expand <IfGate>/<IfVersion>, fill {{ vault.* }},
//      drop empty rules, compose the survivors into one themed page.
//   5. Copy FE sdk/, BE public/, SC public/ verbatim (all file types).
//   6. Assemble docs.json (class A nav + Vaults tab); copy _meta artifacts.
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

  // FE earn → per-vault composition: group rules by theme, then per vault
  // compose each theme's surviving rules into a single themed page.
  const earnFiles = (await collectMdx([FE_EARN])).filter(notInternal);
  const themedRules = await groupEarnRulesByTheme(earnFiles);
  rewriteEarnLinks(themedRules);
  const composedByVault = new Map();
  for (const vault of vaults) {
    await composeVaultThemes(
      vault, themedRules, gates, referencedGates, composedByVault,
    );
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
  await emitDocsJson(vaults, composedByVault, sdkPages.sort());

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
    `Composed ${vaults.length} vault docs from ${earnFiles.length} earn rules; ` +
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
        group: group.name ?? 'Vaults',
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
    // Objects/arrays (e.g. `{{ vault.withdrawal }}` with no leaf field) would
    // stringify to "[object Object]" — treat them as unresolved instead.
    if (value == null || value === '' || typeof value === 'object') {
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

// Innermost <IfGate>/<IfVersion> whose body contains no nested conditional —
// matched repeatedly (inside-out) so arbitrarily nested conditionals resolve.
const INNERMOST_COND_RE =
  /<(IfGate|IfVersion)\s+([^>]*?)>((?:(?!<\/?If(?:Gate|Version)\b)[\s\S])*?)<\/\1>/;

function readAttr(attrs, name) {
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[1] ?? m[2]) : undefined;
}

// Expand every <IfGate>/<IfVersion> in `src` for one vault, inside-out, so
// nesting resolves (e.g. <IfVersion> within <IfGate>, or stacked <IfGate>s).
// Unknown gate ⇒ throw.
function expandConditionals(src, vault, gates, referencedGates, file) {
  const gateValues = evaluateGates(vault.content, gates);
  let out = src;
  for (let guard = 0; guard < 100000; guard += 1) {
    const m = INNERMOST_COND_RE.exec(out);
    if (!m) return out;
    const [whole, tag, attrs, body] = m;
    let show;
    if (tag === 'IfGate') {
      const flag = readAttr(attrs, 'flag');
      referencedGates.add(flag);
      if (!gates.has(flag)) {
        throw new Error(
          `Unknown gate "${flag}" referenced in ${path.relative(STAGING, file)} — ` +
            `add it to _meta/gates.yaml or remove the <IfGate>.`,
        );
      }
      const enabled = gateValues.get(flag) === true;
      // Detect the `inverse` modifier only outside quoted values, so a gate
      // literally named "inverse" (flag="inverse") is not misread as it.
      const inverse = /\binverse\b/.test(attrs.replace(/"[^"]*"|'[^']*'/g, ''));
      show = inverse ? !enabled : enabled;
    } else {
      const notVal = readAttr(attrs, 'not');
      show =
        notVal !== undefined
          ? vault.version !== notVal
          : vault.version === readAttr(attrs, 'is');
    }
    out =
      out.slice(0, m.index) +
      (show ? body : '') +
      out.slice(m.index + whole.length);
  }
  throw new Error(
    `<IfGate>/<IfVersion> expansion did not terminate in ` +
      `${path.relative(STAGING, file)}.`,
  );
}

// --- Per-vault composition (class B) -----------------------------------------
// FE earn rules live under FE_EARN/<theme>/<rule>.mdx. Each theme composes into
// one page per vault; rule order within a theme is filename order.
const EARN_THEMES = [
  { dir: 'vaults', page: 'overview', title: 'Overview' },
  { dir: 'deposits', page: 'depositing', title: 'Depositing' },
  { dir: 'withdrawals', page: 'withdrawing', title: 'Withdrawing' },
  { dir: 'rewards', page: 'rewards', title: 'Rewards' },
  { dir: 'cross-chain', page: 'cross-chain', title: 'Cross-chain' },
];

// Group earn rule files by their theme folder, reading each source once.
async function groupEarnRulesByTheme(earnFiles) {
  const known = new Set(EARN_THEMES.map((t) => t.dir));
  const themed = new Map(EARN_THEMES.map((t) => [t.dir, []]));
  for (const file of [...earnFiles].sort()) {
    const theme = path.relative(FE_EARN, file).split(path.sep)[0];
    if (!known.has(theme)) {
      console.warn(
        `⚠ earn rule outside a known theme folder, skipped: ` +
          `${path.relative(STAGING, file)}`,
      );
      continue;
    }
    themed.get(theme).push({ file, src: await fs.readFile(file, 'utf8') });
  }
  return themed;
}

const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

// GitHub/Mintlify-style heading anchor slug.
function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// First H1 that sits outside any <IfGate>/<IfVersion> block — that heading is
// present on the composed page for every vault, so its anchor is stable. An
// H1 inside a conditional would render (and slug) differently per vault.
function extractH1(src) {
  let depth = 0;
  for (const line of stripFrontmatter(src).split('\n')) {
    if (depth === 0) {
      const m = /^#\s+(.+?)\s*$/.exec(line);
      if (m) return m[1];
    }
    depth += (line.match(/<If(?:Gate|Version)\b/g) || []).length;
    depth -= (line.match(/<\/If(?:Gate|Version)>/g) || []).length;
    if (depth < 0) depth = 0;
  }
  return null;
}

// FE earn rules cross-link by relative path (../vaults/versions, ./caps).
// Composition collapses rules into theme pages, so each such link is rewritten
// to <themePage>#<rule-anchor>. Vault-independent — mutates themedRules once.
function rewriteEarnLinks(themedRules) {
  const themePageOf = new Map(EARN_THEMES.map((t) => [t.dir, t.page]));
  const index = new Map();
  for (const [themeDir, rules] of themedRules) {
    for (const { file, src } of rules) {
      const h1 = extractH1(src);
      index.set(`${themeDir}/${path.basename(file, '.mdx')}`, {
        themePage: themePageOf.get(themeDir),
        anchor: h1 ? slugify(h1) : '',
      });
    }
  }
  for (const [themeDir, rules] of themedRules) {
    const ownThemePage = themePageOf.get(themeDir);
    for (const rule of rules) {
      rule.src = rule.src.replace(MD_LINK_RE, (whole, text, target) => {
        if (/^(https?:|mailto:|#|\/)/i.test(target)) return whole;
        const [rawPath, frag] = target.split('#');
        const resolved = path.posix
          .join(themeDir, rawPath)
          .replace(/\.mdx?$/, '');
        const hit = index.get(resolved);
        if (!hit) return whole;
        const page = hit.themePage === ownThemePage ? '' : hit.themePage;
        return `[${text}](${page}#${frag || hit.anchor})`;
      });
    }
  }
}

function stripFrontmatter(src) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(src);
  return m ? src.slice(m[0].length) : src;
}

// Shift ATX headings down one level (# → ##) so a rule's H1 sits under the
// theme page; fenced code blocks are left untouched.
function demoteHeadings(md) {
  // null = outside a fence; '`' or '~' = inside a fence opened with that char.
  // A closing fence must use the opening character (CommonMark).
  let fenceChar = null;
  return md
    .split('\n')
    .map((line) => {
      const fence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const ch = fence[1][0];
        if (fenceChar === null) fenceChar = ch;
        else if (fenceChar === ch) fenceChar = null;
        return line;
      }
      return fenceChar === null && /^#{1,5}\s/.test(line) ? `#${line}` : line;
    })
    .join('\n');
}

// A rule whose body (minus headings) is all whitespace gated out entirely for
// this vault — it contributes nothing and is dropped from the page.
function isEffectivelyEmpty(body) {
  return body.replace(/^#{1,6}\s.*$/gm, '').trim() === '';
}

// Compose one vault's earn docs: per theme, expand + fill each rule, drop the
// empties, and write the survivors as a single themed page.
async function composeVaultThemes(vault, themedRules, gates, referencedGates, composedByVault) {
  const context = buildVaultContext(vault);
  const pages = [];
  for (const theme of EARN_THEMES) {
    const sections = [];
    for (const { file, src } of themedRules.get(theme.dir) ?? []) {
      const expanded = expandConditionals(src, vault, gates, referencedGates, file);
      const rendered = substitutePlaceholders(expanded, context, file, vault.slug);
      const body = stripFrontmatter(rendered).trim();
      if (isEffectivelyEmpty(body)) continue;
      sections.push(demoteHeadings(body));
    }
    if (sections.length === 0) continue;
    const title = `${vault.name} — ${theme.title}`;
    const page =
      `---\ntitle: ${JSON.stringify(title)}\n` +
      `sidebarTitle: ${JSON.stringify(theme.title)}\n---\n\n` +
      sections.join('\n\n') +
      '\n';
    const dest = path.join(OUTPUT, 'public', vault.slug, `${theme.page}.mdx`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    claimPath(dest, 'FE-earn');
    await fs.writeFile(dest, page);
    pages.push(`public/${vault.slug}/${theme.page}`);
  }
  composedByVault.set(vault.slug, pages);
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

async function emitDocsJson(vaults, composedByVault, sdkPages) {
  const base = JSON.parse(await fs.readFile(BASE_DOCS_JSON, 'utf8'));

  // Class A — preserve the base repo's conceptual navigation verbatim,
  // dropping only stray empty groups (e.g. an unfilled placeholder).
  const tabs = (base.navigation?.tabs ?? []).map((tab) => ({
    ...tab,
    groups: (tab.groups ?? []).filter(
      (g) => !Array.isArray(g.pages) || g.pages.length > 0,
    ),
  }));

  // Class B — "Vaults" tab: a top-level group per Storyblok vault-group, each
  // vault a nested collapsed group (expanded:false) of its theme pages.
  // (Mintlify only collapses nested groups; top-level groups always expand.)
  const byGroup = new Map();
  for (const vault of vaults) {
    const pages = composedByVault.get(vault.slug) ?? [];
    if (pages.length === 0) continue;
    const gname = vault.group || 'Vaults';
    if (!byGroup.has(gname)) byGroup.set(gname, []);
    byGroup.get(gname).push({ group: vault.name, expanded: false, pages });
  }
  if (byGroup.size > 0) {
    tabs.push({
      tab: 'Vaults',
      groups: [...byGroup].map(([gname, vaultGroups]) => ({
        group: gname,
        pages: vaultGroups,
      })),
    });
  }

  // FE SDK.
  if (sdkPages.length > 0) {
    tabs.push({ tab: 'SDK', groups: [{ group: 'SDK', pages: sdkPages }] });
  }

  // Transitional developer-reference tabs from BE/SC's own docs.json.
  // (Curating this material into class A is future content work.)
  const beGroups = await loadSourceGroups(BE_DOCS_JSON);
  if (beGroups.length > 0) tabs.push({ tab: 'Backend API', groups: beGroups });
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
