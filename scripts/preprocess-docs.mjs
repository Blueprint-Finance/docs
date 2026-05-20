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
//   4. Per vault, per theme: expand <IfGate>/<IfVersion>/<IfRc>, fill {{ }},
//      drop empty rules, compose the survivors into one themed page.
//   5. Copy FE sdk/, BE public/, SC public/ verbatim (all file types).
//   6. Assemble docs.json (class A nav + Vaults tab); copy _meta artifacts.
//
// Gate model: every feature gate is vault-level — evaluated as
//   Boolean(vault.content[storyblok_field] ?? default). Group-level gates
//   (group_hidden, …) are dead and unused; they resolve to their default.
// Version axis: <IfVersion is="v2"> / <IfVersion not="v2"> resolves against
//   the vault's vaultVersion.
// Presence axis: <IfRc> keeps its body only when BE returned a non-empty
//   withdrawals_config_rc (a pending release-candidate schedule) for the vault.
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

// Worker is a production build — it MUST NOT pull unpublished CMS content.
// Storyblok's CDN with a public token defaults to `published`, but the param
// is set explicitly here so the intent is visible at the call site and a
// future accidental switch to `draft` is impossible without changing this
// constant. assertPublishedOnly() runs on every Storyblok request URL.
const STORYBLOK_VERSION = 'published';

function assertPublishedOnly(url) {
  const version = url.searchParams.get('version');
  if (version !== STORYBLOK_VERSION) {
    throw new Error(
      `Storyblok request must carry version=${STORYBLOK_VERSION} ` +
        `(got version=${version ?? '<unset>'}). The production worker is ` +
        `forbidden from pulling drafts — fix the call site.`,
    );
  }
}

const IF_GATE_RE =
  /<IfGate\s+flag=(?:"([^"]+)"|'([^']+)')(\s+inverse)?\s*>([\s\S]*?)<\/IfGate>/g;

// <IfVersion is="v2">…</IfVersion> / <IfVersion not="v2">…</IfVersion>
const IF_VERSION_RE =
  /<IfVersion\s+(is|not)=(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/IfVersion>/g;

// <IfRc>…</IfRc> — presence conditional: body kept only when the vault has a
// non-empty BE withdrawals_config_rc (a pending release-candidate schedule).
// Attribute-less by design; no inverse modifier.
const IF_RC_RE = /<IfRc\s*>([\s\S]*?)<\/IfRc>/g;

async function main() {
  const gates = await loadGates();
  const vaults = await fetchVaults();
  if (vaults.length === 0) {
    throw new Error('Storyblok returned zero published vaults.');
  }

  const performance = await fetchVaultPerformance(vaults);
  for (const v of vaults) v.performance = performance.get(v.slug) ?? null;

  const referencedGates = new Set();

  // FE earn → split by `emit` front-matter: class-A files (emit: once) ship
  // once into concepts/earn/<theme>/<rule>.mdx; class-B files (default) feed
  // the per-vault themed composition.
  const earnFiles = (await collectMdx([FE_EARN])).filter(notInternal);
  const { themed: themedRules, classA: classAFiles } =
    await groupEarnRulesByTheme(earnFiles);
  const classAPages = await emitClassAEarnPages(classAFiles);
  rewriteEarnLinks(themedRules, classAFiles);
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
  await emitDocsJson(vaults, composedByVault, sdkPages.sort(), classAPages);

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
  url.searchParams.set('version', STORYBLOK_VERSION);
  url.searchParams.set('resolve_relations', RESOLVE_RELATIONS);
  if (cv) url.searchParams.set('cv', cv);
  assertPublishedOnly(url);

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
    url.searchParams.set('version', STORYBLOK_VERSION);
    url.searchParams.set('by_uuids', batch.join(','));
    // by_uuids defaults to per_page=25 and silently drops the rest — match
    // the batch size explicitly. See FE storyblok.ts for the same fix.
    url.searchParams.set('per_page', String(batch.length));
    url.searchParams.set('resolve_relations', RESOLVE_RELATIONS);
    if (cv) url.searchParams.set('cv', cv);
    assertPublishedOnly(url);

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

// Innermost <IfGate>/<IfVersion>/<IfRc> whose body contains no nested
// conditional — matched repeatedly (inside-out) so arbitrarily nested
// conditionals resolve. <IfRc> is attribute-less; the others carry attrs.
const INNERMOST_COND_RE =
  /<(IfGate|IfVersion|IfRc)\b([^>]*?)>((?:(?!<\/?If(?:Gate|Version|Rc)\b)[\s\S])*?)<\/\1>/;

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
    if (tag === 'IfRc') {
      // Presence conditional — keep the body only when BE returned a non-empty
      // withdrawals_config_rc for this vault (most vaults have {}).
      const rc = vault.performance?.withdrawals_config_rc;
      show =
        rc != null && typeof rc === 'object' && Object.keys(rc).length > 0;
    } else if (tag === 'IfGate') {
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

// Group earn rule files by their theme folder, reading each source once and
// routing by the `emit` front-matter field:
//   - `emit: once`        → class A, written once to concepts/earn/ (see
//                           emitClassAEarnPages); the per-vault composer
//                           never sees these files.
//   - `emit: per_vault`   → class B, the existing per-vault composition path.
//   - absent              → class B (default — backwards-compatible).
//   - anything else       → throw.
async function groupEarnRulesByTheme(earnFiles) {
  const known = new Set(EARN_THEMES.map((t) => t.dir));
  const themed = new Map(EARN_THEMES.map((t) => [t.dir, []]));
  const classA = [];
  for (const file of [...earnFiles].sort()) {
    const theme = path.relative(FE_EARN, file).split(path.sep)[0];
    if (!known.has(theme)) {
      console.warn(
        `⚠ earn rule outside a known theme folder, skipped: ` +
          `${path.relative(STAGING, file)}`,
      );
      continue;
    }
    const src = await fs.readFile(file, 'utf8');
    const { data: fm } = parseFrontmatter(src);
    const emit = fm.emit;
    if (emit === 'once') {
      classA.push({ file, src, theme });
    } else if (emit == null || emit === 'per_vault') {
      themed.get(theme).push({ file, src });
    } else {
      throw new Error(
        `Invalid \`emit\` value ${JSON.stringify(emit)} in ` +
          `${path.relative(STAGING, file)}; expected "once" or "per_vault".`,
      );
    }
  }
  return { themed, classA };
}

// Class-A vault placeholder check — `{{ vault.* }}` is per-vault by
// construction, so it is meaningless on a write-once concept page. The check
// runs before emission so a misclassified file fails loudly instead of being
// shipped with a literal placeholder.
const VAULT_PLACEHOLDER_RE = /\{\{\s*vault\.[^}]+\s*\}\}/;

function assertNoVaultPlaceholders(src, file) {
  const m = VAULT_PLACEHOLDER_RE.exec(src);
  if (!m) return;
  throw new Error(
    `${path.relative(STAGING, file)} is \`emit: once\` (class A) but contains ` +
      `the per-vault placeholder ${m[0]}. Class-A files are vault-invariant — ` +
      `remove the placeholder or change \`emit\` to \`per_vault\`.`,
  );
}

// Emit each class-A earn rule once into concepts/earn/<theme>/<rule>.mdx. The
// file is copied verbatim (front-matter preserved so Mintlify reads title /
// sidebarTitle). Returns the page refs grouped by theme, for the nav builder.
async function emitClassAEarnPages(classA) {
  const pages = [];
  for (const { file, src, theme } of classA) {
    assertNoConditionals(src, file);
    assertNoVaultPlaceholders(src, file);
    const rule = path.basename(file, '.mdx');
    const dest = path.join(OUTPUT, 'concepts', 'earn', theme, `${rule}.mdx`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    claimPath(dest, 'FE-earn-concept');
    await fs.writeFile(dest, src);
    pages.push({ theme, page: `concepts/earn/${theme}/${rule}` });
  }
  return pages;
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
    depth += (line.match(/<If(?:Gate|Version|Rc)\b/g) || []).length;
    depth -= (line.match(/<\/If(?:Gate|Version|Rc)>/g) || []).length;
    if (depth < 0) depth = 0;
  }
  return null;
}

// FE earn rules cross-link by relative path (../vaults/versions, ./caps).
// Composition collapses class-B rules into theme pages, so a link to a class-B
// rule is rewritten to <themePage>#<rule-anchor>. A link to a class-A rule
// (emit: once, lives at concepts/earn/<theme>/<rule>) is rewritten to that
// absolute path instead. Vault-independent — mutates themedRules once.
function rewriteEarnLinks(themedRules, classA) {
  const themePageOf = new Map(EARN_THEMES.map((t) => [t.dir, t.page]));
  const index = new Map();
  for (const [themeDir, rules] of themedRules) {
    for (const { file, src } of rules) {
      const h1 = extractH1(src);
      index.set(`${themeDir}/${path.basename(file, '.mdx')}`, {
        kind: 'classB',
        themePage: themePageOf.get(themeDir),
        anchor: h1 ? slugify(h1) : '',
      });
    }
  }
  for (const { file, src, theme } of classA) {
    const h1 = extractH1(src);
    const rule = path.basename(file, '.mdx');
    index.set(`${theme}/${rule}`, {
      kind: 'classA',
      page: `/concepts/earn/${theme}/${rule}`,
      anchor: h1 ? slugify(h1) : '',
    });
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
        if (hit.kind === 'classA') {
          return `[${text}](${hit.page}#${frag || hit.anchor})`;
        }
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

// Parse YAML front-matter into { data, body }. Files without front-matter
// return { data: {}, body: src }.
function parseFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  try {
    const data = yaml.load(m[1]) ?? {};
    return { data, body: src.slice(m[0].length) };
  } catch (err) {
    throw new Error(`Malformed YAML front-matter: ${err.message}`);
  }
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

// Storyblok rich-text → MDX-safe Markdown. Authored CMS prose for the vault
// Overview — handles the node types vault overviews actually use (paragraph,
// heading, list, link, bold/italic/code marks, hard_break, blockquote,
// horizontal_rule, image). Unknown nodes are skipped silently — the renderer
// stays forgiving rather than failing the worker over a one-off CMS shape.
// Plain text is MDX-escaped: a literal `{` would start an expression and a
// literal `<` would start a tag.
function escapeMdxText(s) {
  return String(s).replace(/([{}<])/g, '\\$1');
}

function renderRichTextMarks(text, marks) {
  // `code` is handled up-front rather than inside the loop because (a) marks
  // array order is not guaranteed by Storyblok, so an in-loop branch that
  // discards `out` and reads `text` would silently drop any mark applied in
  // an earlier iteration (e.g. a `link` that happens to come before `code`),
  // and (b) inside a Markdown code span MDX expression syntax does not
  // apply, so we deliberately skip escapeMdxText() for the contents.
  const hasCode = (marks ?? []).some((m) => m?.type === 'code');
  let out = hasCode ? `\`${text}\`` : escapeMdxText(text);
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':   out = `**${out}**`; break;
      case 'italic': out = `*${out}*`; break;
      case 'strike': out = `~~${out}~~`; break;
      case 'link': {
        const href = mark.attrs?.href ?? '';
        out = `[${out}](${href})`;
        break;
      }
      // code is already wrapped above; underline/anchor/highlight: drop the
      // mark, keep the text.
    }
  }
  return out;
}

function renderRichTextInline(nodes) {
  if (!Array.isArray(nodes)) return '';
  let out = '';
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    if (n.type === 'text') out += renderRichTextMarks(n.text ?? '', n.marks);
    else if (n.type === 'hard_break') out += '  \n';
  }
  return out;
}

function renderRichTextBlocks(nodes) {
  if (!Array.isArray(nodes)) return '';
  const blocks = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    switch (n.type) {
      case 'paragraph':
        blocks.push(renderRichTextInline(n.content));
        break;
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 2));
        blocks.push(`${'#'.repeat(level)} ${renderRichTextInline(n.content)}`);
        break;
      }
      case 'bullet_list':
      case 'ordered_list': {
        // Each list level renders its children with no leading indent and then
        // indents every physical line of the item body (continuation lines,
        // blank paragraph separators, and any nested list output already
        // rendered with its own marker spacing). Outer levels recursing into
        // an item see fully-formed inner Markdown and only need to add their
        // own marker on the first line plus a `contIndent` of spaces on the
        // rest — which is the standard CommonMark nesting rule. The previous
        // depth-based indent was incorrect: nested lists got their continuation
        // applied only to the first physical line of each paragraph (Cursor
        // PR #15 finding) and were also double-indented through recursion.
        const ordered = n.type === 'ordered_list';
        const items = (n.content ?? [])
          .filter((c) => c?.type === 'list_item')
          .map((c, i) => {
            const inner = renderRichTextBlocks(c.content ?? []);
            const marker = ordered ? `${i + 1}.` : '-';
            const contIndent = ' '.repeat(marker.length + 1);
            return inner
              .split('\n')
              .map((line, j) => {
                if (j === 0) return `${marker} ${line}`;
                if (line === '') return '';
                return `${contIndent}${line}`;
              })
              .join('\n');
          })
          .join('\n');
        if (items) blocks.push(items);
        break;
      }
      case 'blockquote': {
        const inner = renderRichTextBlocks(n.content ?? []);
        if (inner) blocks.push(inner.split('\n').map((l) => `> ${l}`).join('\n'));
        break;
      }
      case 'horizontal_rule':
        blocks.push('---');
        break;
      case 'code_block': {
        const lang = (n.attrs?.class ?? '').replace(/^language-/, '');
        const body = (n.content ?? [])
          .map((c) => (c?.type === 'text' ? c.text ?? '' : ''))
          .join('');
        blocks.push(`\`\`\`${lang}\n${body}\n\`\`\``);
        break;
      }
      case 'image': {
        const src = n.attrs?.src ?? '';
        const alt = n.attrs?.alt ?? '';
        if (src) blocks.push(`![${escapeMdxText(alt)}](${src})`);
        break;
      }
      // Unknown nodes are skipped.
    }
  }
  return blocks.filter((b) => b && b.trim()).join('\n\n');
}

function renderStoryblokOverview(overview) {
  if (!overview || typeof overview !== 'object') return '';
  if (overview.type !== 'doc' || !Array.isArray(overview.content)) return '';
  return renderRichTextBlocks(overview.content).trim();
}

// Compose one vault's earn docs: per theme, expand + fill each rule, drop the
// empties, and write the survivors as a single themed page. The Overview theme
// additionally prepends the vault's CMS Overview rich text (Storyblok) above
// the FE-rule-generated content, so the page reads as "what this vault is"
// before "how its earn rules work".
async function composeVaultThemes(vault, themedRules, gates, referencedGates, composedByVault) {
  const context = buildVaultContext(vault);
  const pages = [];
  for (const theme of EARN_THEMES) {
    const sections = [];
    if (theme.dir === 'vaults') {
      const cmsOverview = renderStoryblokOverview(vault.content?.overview);
      if (cmsOverview) sections.push(cmsOverview);
    }
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

// <IfGate>/<IfVersion>/<IfRc> are FE-earn-only — BE/SC/FE-sdk content must not
// use them.
function assertNoConditionals(src, file) {
  for (const [re, tag] of [
    [IF_GATE_RE, '<IfGate>'],
    [IF_VERSION_RE, '<IfVersion>'],
    [IF_RC_RE, '<IfRc>'],
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

// Tabs the worker regenerates from FE/BE/SC sources on every run. They are
// stripped from the base nav before being re-added below, so a previous run's
// output left in `docs.json` (e.g. when main carries the last aggregated tree
// under the single-branch publish model) does not produce duplicate tabs.
const CLASS_B_TABS = new Set(['Vaults', 'SDK', 'Backend API', 'Smart Contracts']);

// Group names inside otherwise-class-A tabs that the worker controls — i.e.
// the worker strips them from the base nav before re-emitting (so a stale
// entry left on main from a previous run does not survive). The publish-time
// merge in scripts/merge-docs-json.mjs MUST stay in sync with this map.
//
// "Earn concepts" used to live inside the Documentation tab (PR #13); it now
// emits at the head of the Vaults tab. The entry stays so any pre-existing
// "Earn concepts" group on main (from a pre-this-PR run) gets cleaned up on
// the first aggregation. Safe to remove once main carries no such group.
const CLASS_B_GROUPS_IN_CLASS_A_TABS = new Map([
  ['Documentation', new Set(['Earn concepts'])],
]);

async function emitDocsJson(vaults, composedByVault, sdkPages, classAPages = []) {
  const base = JSON.parse(await fs.readFile(BASE_DOCS_JSON, 'utf8'));

  // Class A — preserve the base repo's conceptual navigation verbatim,
  // dropping any class-B tab (regenerated below), any class-B group inside
  // a class-A tab (also regenerated below), and stray empty groups.
  const tabs = (base.navigation?.tabs ?? [])
    .filter((tab) => !CLASS_B_TABS.has(tab.tab))
    .map((tab) => {
      const ownedGroups = CLASS_B_GROUPS_IN_CLASS_A_TABS.get(tab.tab);
      const groups = (tab.groups ?? []).filter((g) => {
        if (ownedGroups && ownedGroups.has(g.group)) return false;
        return !Array.isArray(g.pages) || g.pages.length > 0;
      });
      return { ...tab, groups };
    });

  // Class B — "Earn concepts" group sits at the head of the Vaults tab so
  // shared concept pages (emit:once FE rules) read as the introduction to
  // the per-vault docs underneath. Sub-grouped by theme in EARN_THEMES order;
  // null when no rule is marked emit:once (backwards-compatible).
  let earnConceptsGroup = null;
  if (classAPages.length > 0) {
    const byTheme = new Map();
    for (const { theme, page } of classAPages) {
      if (!byTheme.has(theme)) byTheme.set(theme, []);
      byTheme.get(theme).push(page);
    }
    const themeSubGroups = EARN_THEMES
      .filter((t) => byTheme.has(t.dir))
      .map((t) => ({ group: t.title, pages: byTheme.get(t.dir).sort() }));
    earnConceptsGroup = { group: 'Earn concepts', pages: themeSubGroups };
  }

  // Class B — "Vaults" tab. Active vaults are grouped by Storyblok `network`
  // (the canonical chain label — "Ethereum", "Arbitrum", "Base", …); a vault
  // with no network falls back to "Other". Each vault appears as a collapsed
  // nested group of its theme pages (Mintlify only collapses nested groups —
  // top-level groups always expand). Network groups are sorted alphabetically
  // so the order is deterministic regardless of Storyblok group order.
  // Deprecated vaults are pulled into a single flat "Deprecated vaults" group
  // at the tail — they matter much less and the burial-ground stays compact.
  const activeByNetwork = new Map();
  const deprecatedVaultGroups = [];
  for (const vault of vaults) {
    const pages = composedByVault.get(vault.slug) ?? [];
    if (pages.length === 0) continue;
    const entry = { group: vault.name, expanded: false, pages };
    if (vault.deprecated) {
      deprecatedVaultGroups.push(entry);
      continue;
    }
    const network = (vault.network && String(vault.network).trim()) || 'Other';
    if (!activeByNetwork.has(network)) activeByNetwork.set(network, []);
    activeByNetwork.get(network).push(entry);
  }
  const vaultsTabGroups = [...activeByNetwork]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([network, vgs]) => ({ group: network, pages: vgs }));
  if (deprecatedVaultGroups.length > 0) {
    deprecatedVaultGroups.sort((a, b) => a.group.localeCompare(b.group));
    vaultsTabGroups.push({ group: 'Deprecated vaults', pages: deprecatedVaultGroups });
  }
  if (earnConceptsGroup) {
    vaultsTabGroups.unshift(earnConceptsGroup);
  }
  if (vaultsTabGroups.length > 0) {
    tabs.push({ tab: 'Vaults', groups: vaultsTabGroups });
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
