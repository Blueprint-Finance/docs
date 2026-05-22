> For Mintlify product knowledge (components, configuration, writing standards),
> install the Mintlify skill: `npx skills add https://mintlify.com/docs`

# Concrete docs — aggregation worker

## What this repo actually is

This is **not** a hand-authored Mintlify site. It is the **aggregation worker** for
Concrete's docs: a GitHub Actions pipeline that pulls `docs/business/` from three
source repos plus two live data sources, runs a preprocessor over them, and writes
the assembled Mintlify site back to this repo's `main`. Mintlify deploys from `main`.

The MDX you see under `public/`, the `concepts/` tree, `_meta/`, and `docs.json`
are **generated build artifacts**. The worker overwrites them on every run.

```
FE concrete-app    ─┐
BE cb_backend      ─┤  docs/business/  ─┐
SC earn-v2-core    ─┘                   │
Storyblok CMS  (vault list + config) ───┤──▶  scripts/preprocess-docs.mjs  ──▶  OUTPUT
earn-apy API   (per-vault BE data)   ───┘                                         │
                                                                                  ▼
                                          publish step ── merge-docs-json.mjs ──▶ main ──▶ Mintlify
```

## The single most important rule

**Do not hand-edit generated paths.** Anything the worker owns is reset on the next
aggregation run. Owned paths (`OWNED` in `.github/workflows/aggregate-docs.yml`):

- `public/**` — per-vault composed pages, FE SDK, BE/SC reference trees
- `concepts/**` — class-A "emit: once" earn concept pages
- `_meta/**` — `vaults.json`, copied FE meta artifacts
- `docs.json` — navigation (class-B tabs + worker-owned groups are regenerated)

Edit content at its **source**: FE/BE/SC `docs/business/` for pages, Storyblok for
vault config, this repo only for **class-A** narrative (see below) and tooling
(`scripts/`, `.github/`).

The single-branch model is deliberate: the worker writes to `main` with the default
`GITHUB_TOKEN` (which by GitHub policy does not trigger downstream workflow runs) and
`paths-ignore` covers every owned path — together that closes the worker→worker loop.
Mintlify's web editor can still edit non-owned fields; `merge-docs-json.mjs` preserves
those at publish time (see Publish model).

## Two content classes

Everything the worker produces is one of two classes. Know which you're touching.

- **Class A — curated narrative.** The base repo's own conceptual docs (`docs.json`
  nav kept verbatim) plus FE earn rules marked `emit: once` in front-matter, which the
  worker ships once to `concepts/earn/<theme>/<rule>.mdx`. Class-A is vault-invariant:
  no `<IfGate>`/`<IfVersion>`/`<IfRc>` and no `{{ vault.* }}` placeholders allowed
  (asserted at emit time). Class-A pages have their leading body H1 stripped — Mintlify
  renders the front-matter `title` as the page heading.

- **Class B — generated reference.** Per-vault composed earn docs (FE rules without
  `emit: once`), FE SDK, BE API, SC contracts. Class-B nav tabs are regenerated every
  run. `CLASS_B_TABS = {Vaults, SDK, Backend API, Smart Contracts}`.

## Pipeline (scripts/preprocess-docs.mjs, in order)

1. `loadGates()` — `_meta/gates.yaml` → `Map<gateName, {storyblok_field, default}>`.
2. `fetchVaults()` — Storyblok `earn` story (mirrors FE `getStory`). Filters: skip
   hidden Storyblok groups, `hiddenCard`, `excludeFromMainEnvironment`, then the
   live set is **Storyblok ∩ FE `_meta/earn-whitelist.json`**.
3. `fetchVaultPerformance()` — per-vault enrichment from earn-apy (`withdrawals_config`,
   `withdrawals_config_rc`, `implementation`). Unset `EARN_APY_API_URL` ⇒ skipped.
4. `groupEarnRulesByTheme()` — split FE earn rules by `emit` front-matter into class-A
   vs class-B, keyed by theme folder.
5. `emitClassAEarnPages()` — write class-A pages once to `concepts/earn/<theme>/`.
6. `rewriteEarnLinks()` — rewrite inter-rule links (class-B → `<themePage>#anchor`;
   class-A → `/concepts/earn/<theme>/<rule>`).
7. `composeVaultThemes()` per vault — expand conditionals, fill placeholders, drop
   empty rules, compose one page per theme. Overview prepends the View-on-app CTA,
   the CMS Overview rich text, the RC learn-more line, and the Audits section.
8. Copy FE `sdk/` (verbatim), BE `public/` and SC `public/` whole trees (verbatim,
   `internal/` pruned).
9. `copyMetaArtifacts()` + `emitDocsJson()` — assemble `docs.json` and `_meta/vaults.json`.

`EARN_THEMES` (folder → page → sidebar title): `vaults`→`overview`→Overview,
`deposits`→`depositing`→Depositing, `withdrawals`→`withdrawing`→Withdrawing,
`rewards`→`rewards`→Rewards, `cross-chain`→`cross-chain`→Cross-chain.

## The transform surface (the FE/BE/SC authoring contract)

The preprocessor is a **textual** transformer. It touches exactly four patterns;
everything else (including all Mintlify JSX like `<Note>`, `<Card>`, `<Steps>`) is
copied verbatim. The four:

1. **`<IfGate flag="x" [inverse]>`** — kept/dropped per the vault's gate value.
2. **`<IfVersion is="v2">` / `<IfVersion not="v2">`** — resolved against the vault's
   `vaultVersion`.
3. **`<IfRc>`** — attribute-less presence conditional; kept only when the vault has a
   non-empty earn-apy `withdrawals_config_rc`.
4. **`{{ vault.* }}`** — substituted from the per-vault context (`buildVaultContext`).

`<IfGate>/<IfVersion>/<IfRc>` are **FE-earn-only** — banned (asserted) in class-A,
FE SDK, BE, SC. After expansion the worker asserts none remain.

### Gates

Every gate is **vault-level**, evaluated as `Boolean(content[storyblok_field] ?? default)`.
`_meta/gates.yaml` (authored in FE) is the single source of truth for gate names →
Storyblok fields. Group-level gates are dead. Unknown gate referenced in MDX ⇒ throw.

### Placeholder context (`vault.*`)

`buildVaultContext` exposes per vault: `slug`, `name`, `version`, `network`,
`implementation`, `withdrawal.{…earn-apy withdrawals_config, cycle_summary, cycle_days}`,
`withdrawalRc.{…earn-apy withdrawals_config_rc, transition_phrase}`.

- `cycle_summary` — schedule-pane prose; RC-aware primary source via
  `pickPrimaryCronSource`, fallback chain RC-days → queue-delay → eta → empty.
- `cycle_days` — worst-case day count, step-for-step aligned with `cycle_summary`.
- `transition_phrase` — tense-aware RC transition string keyed on `starting_from`.

Unresolved placeholder → `—` + end-of-run warning. The **only** path allowed to
resolve to an intentional empty string (no warning) is in `ALLOWED_EMPTY_PLACEHOLDERS`
(currently just `vault.withdrawal.cycle_summary`). These placeholder names are a
**cross-repo API** — FE templates depend on them; renaming one silently breaks FE
rendering.

## Publish model

The publish step (`.github/workflows/aggregate-docs.yml`):

1. `git reset --hard origin/main` (fresh tip).
2. `node scripts/merge-docs-json.mjs` — re-merge `docs.json` against fresh main:
   class-A tabs come from main (preserving Mintlify-editor edits to non-owned fields),
   class-B tabs + worker-owned groups inside class-A tabs come from the worker output.
3. rsync `OWNED` paths from `OUTPUT` over main (`--delete` on dirs; an owned dir the
   run didn't produce is removed so stale copies don't linger).
4. Commit + push to `main` with `GITHUB_TOKEN`.

`merge-docs-json.mjs` holds **copies** of `CLASS_B_TABS` and
`CLASS_B_GROUPS_IN_CLASS_A_TABS` that **must stay byte-identical** to the ones in
`preprocess-docs.mjs`.

## Load-bearing invariants

These read like incidental implementation details. Each is actually a contract, and
breaking one fails **silently** — a corrupted nav, leaked draft content, a worker that
loops, or FE pages rendering `—`. The failure mode is noted per item.

1. **Synced constants** — `CLASS_B_TABS` and `CLASS_B_GROUPS_IN_CLASS_A_TABS` are
   duplicated in `preprocess-docs.mjs` and `merge-docs-json.mjs`; keep them identical.
   Desync ⇒ the publish-time merge drops or duplicates nav tabs/groups.
2. **Placeholder names are a public API** — `vault.withdrawal.cycle_summary`,
   `cycle_days`, `vault.withdrawalRc.transition_phrase`, and every name in `gates.yaml`.
   FE/BE/SC templates reference them by exact string; a rename ⇒ FE renders `—`.
3. **Four-pattern transform surface** — IfGate / IfVersion / IfRc / `{{ }}` and nothing
   else; JSX passes through untouched. Widen it and you risk mangling authored Mintlify
   components; narrow it and FE conditionals leak into the published page.
4. **Storyblok is published-only** — `STORYBLOK_VERSION = 'published'`, asserted on
   every request URL. Sending `version=draft` ⇒ the public build can pull unpublished
   CMS edits.
5. **Vault exclusion filters** — `hiddenCard`, `excludeFromMainEnvironment`, hidden
   groups, and the `Storyblok ∩ earn-whitelist` intersection all gate which vaults ship.
   Drop one ⇒ a non-user-facing vault is exposed in the docs.
6. **Loop guard** — push with `GITHUB_TOKEN` (no PAT) + `paths-ignore` on every owned
   path. Both halves required; lose either ⇒ the worker's own push re-triggers the worker.
7. **OWNED path coverage** — `public _meta concepts docs.json`. A new generated output
   directory not added to `OWNED` ⇒ it never reaches main.
8. **Class-A purity** — no conditionals, no `{{ vault.* }}`, leading H1 stripped. A
   conditional or placeholder here ⇒ it ships unresolved (class-A is vault-invariant).
9. **`merge-docs-json` preserves editor edits** — non-owned `docs.json` fields and
   class-A nav come from fresh main, not the worker's stale snapshot. Skip it ⇒ Mintlify
   web-editor edits get clobbered on the next run.

## Local dev

```bash
cd scripts && npm ci          # deps: js-yaml, cron-parser
npm run preview               # build + serve a local aggregation (see scripts/preview.mjs)
node --check preprocess-docs.mjs   # syntax check after edits
```

The worker's source branches are pinned to feature branches in `aggregate-docs.yml`
(`fe_ref`/`be_ref`/`sc_ref` defaults) until the source-repo PRs merge — see the TODO
in that file before flipping any to `main`.

## Where decisions live

Architecture **history** and cross-repo decisions are in the coordination hub
`~/.claude/coordination/mintlify.md` (local to the maintainer's machine; a decision log,
not a contract). This file is the current **contract**; the hub is the *why*.

## Style (applies to any hand-authored class-A narrative here)

- Active voice, second person ("you"). One idea per sentence.
- Sentence case for headings. Bold for UI elements. Code formatting for files/commands/paths.
- No purpose-adverbial filler ("for better readability", "to improve UX"). State the
  change; if the why matters, give the concrete reason.
