# CLAUDE.md

Read **`AGENTS.md`** first — it is the architecture + contract for this repo. This
file is the quick index and the don't-break checklist.

## What this repo is (one line)

An aggregation worker, not a hand-edited site: `scripts/preprocess-docs.mjs` assembles
FE/BE/SC `docs/business/` + Storyblok + earn-apy into a Mintlify site published to
`main`. `public/`, `concepts/`, `_meta/`, `docs.json` are **generated** — never hand-edit
them; edit the source instead.

## Key files

| Path | Role |
|---|---|
| `scripts/preprocess-docs.mjs` | the whole pipeline: fetch → transform → compose → emit `docs.json` |
| `scripts/merge-docs-json.mjs` | publish-time nav merge; holds **synced copies** of `CLASS_B_TABS` + `CLASS_B_GROUPS_IN_CLASS_A_TABS` |
| `.github/workflows/aggregate-docs.yml` | triggers, source-branch refs, publish step, `OWNED` paths |
| `scripts/preview.mjs` | local build/preview |
| `AGENTS.md` | architecture + invariants (read this) |

## Before you change anything — the don't-break checklist

1. **Synced constants** — `CLASS_B_TABS` / `CLASS_B_GROUPS_IN_CLASS_A_TABS` exist in
   both `preprocess-docs.mjs` and `merge-docs-json.mjs`; edit both, keep identical.
2. **Placeholder names are a cross-repo API** — `vault.withdrawal.cycle_summary`,
   `cycle_days`, `vault.withdrawalRc.transition_phrase`, gate names in `gates.yaml`.
   FE templates reference them by string; a rename silently breaks FE rendering.
3. **Transform surface is four patterns** — `<IfGate>`, `<IfVersion>`, `<IfRc>`,
   `{{ vault.* }}`. Everything else (Mintlify JSX) passes through verbatim.
4. **Storyblok published-only** — `STORYBLOK_VERSION = 'published'`, asserted per request.
   Never send `version=draft` from the production worker.
5. **Vault filters** — `hiddenCard`, `excludeFromMainEnvironment`, hidden groups,
   `Storyblok ∩ earn-whitelist`. These decide which vaults ship.
6. **Publish loop guard** — push with `GITHUB_TOKEN` + `paths-ignore` on all owned paths.
7. **`OWNED` = `public _meta concepts docs.json`** — a new output dir not added here
   never reaches main.
8. **Class-A purity** — `emit: once` files: no conditionals, no `{{ vault.* }}`,
   leading H1 stripped on emit.

## Working norms

- Verify edits with `node --check scripts/preprocess-docs.mjs` and a focused smoke
  script before committing.
- Each PR is reviewed by the Cursor bot — push, comment `@cursor review`, then use the
  `pr-cursor-wait` skill to poll; address findings before merge.
- Decision history lives in `~/.claude/coordination/mintlify.md` (the *why*; machine-local).
  `AGENTS.md` is the current *contract*.
- Commit/PR prose: state the change factually; no purpose-adverbial filler.
