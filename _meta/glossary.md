# Glossary

Shared terms used across the business knowledge base. These definitions are
the source of truth — when a rule MDX uses one of these words it means
exactly this.

## Vault

A smart-contract product into which a user deposits an underlying asset and
receives **share tokens** representing a proportional claim on the vault's
holdings. Each vault in the UI maps to one **VaultsContent** entry in the CMS
and may span one or more contract addresses across one or more networks.

## Vault group

A CMS grouping of related vaults (for example, all Bitcoin-backed vaults).
Groups exist for navigation and display only — they have no on-chain meaning.
A group can be hidden or marked deprecated; deprecation propagates down to
every vault in the group.

## Share token

The ERC-20-like receipt token a user holds after depositing into a vault. The
share-to-asset exchange rate moves with the vault's yield. v2 vaults use
share-denominated accounting for withdrawal queues and caps.

## Underlying asset

The token a vault accepts on deposit and pays out on withdrawal (e.g. USDC,
WBTC, ETH). Display amounts are converted between underlying and shares using
the vault's current exchange rate.

## v1 vault

A first-generation vault: synchronous deposit and withdrawal. No queue, no
epoch concept. Withdraw returns assets immediately within the same
transaction.

## v2 vault

A second-generation vault with **asynchronous withdrawals**: a user submits a
withdrawal _request_ that is settled at the end of a future **epoch**. v2
vaults expose the queue, epoch, and cap concepts described below.

## Epoch

A v2 vault's withdrawal accounting period. At any moment the vault has
exactly one **open epoch** accepting new requests, and zero or more
**closed-pending epochs** that have reached cutoff but not yet been paid out.
The lifecycle for each epoch is: _start → cutoff → payout → next epoch start_.

## Cutoff

The moment within an epoch at which new withdrawal requests stop being
accepted into that epoch (they roll into the next open epoch instead).
Defined by `cutoffCron` on the vault's withdrawal config.

## Payout

The moment at which a closed-pending epoch's queued withdrawals are settled
on-chain and become claimable. Defined by `payoutCron`.

## Withdrawal window

The interval, expressed colloquially, between when a user submits a withdraw
request and when the resulting assets become claimable. Practically equal to
the time from now to the next payout, plus any cap-driven overflow into
later epochs.

## Cap

The per-epoch maximum amount of shares that can be paid out, computed as
`b × (TVL_prev − paid_prev)` where `b = withdrawalQueueThreshold / 10_000`.
Vaults with caps disabled have an effectively infinite cap. The cap UI is
gated by `enableWithdrawalCaps`.

## Overflow

Queued withdrawal demand in excess of an epoch's cap. The surplus rolls into
the next epoch (and the one after, if it still exceeds cap). A user's
request can be **sliced** across multiple epochs; each slice is rendered in
the epoch that will pay it.

## Queue place

A user's position in the FIFO settlement order for an epoch. Oldest request
gets place `1` (paid first). Earn shows place within the request's native
epoch; NAV shows place within the cycle's settlement group, which may
differ.

## RC (release-candidate) withdrawal config

A future override of the standard withdrawal cron schedule, scoped by a
`startingFrom` timestamp. Lets the team announce schedule changes (for
example, weekly → bi-weekly) that activate at a specific epoch boundary
without redeploying.

## Permissioned vault

A vault whose entry is allowlist-gated. Users not on the allowlist cannot
deposit; the UI renders a restricted-access state.

## Isolated environment

A deployment configured to surface only a specific subset of vaults (often a
single vault) under a custom domain. Controlled by
`NEXT_PUBLIC_ISOLATION_ENV` and the vault's `isolationEnvironment` CMS field.
Internal-only concept; not surfaced in public docs as a user-facing rule.

## Pre-deposit vault

A v2 vault that accepts deposits on one chain (L1) before launching on
another (L2). Withdrawals are disabled until users claim their shares on the
destination chain via LayerZero messaging. Once claimed, the L1 shares are
burned and the user holds the L2 shares.

## Bridge ETA / Withdrawal ETA

Forward-looking dates pinned in the CMS to communicate when a cross-chain
bridge step or withdrawal milestone is expected to complete. Used in the UI
copy when no on-chain timestamp is yet available.

## TVL (Total Value Locked)

The aggregate USD value of assets held across all displayed vaults. Vaults
flagged `ignoreTvl` are excluded from the aggregate (e.g. test or duplicate
deployments) but still render as products.
