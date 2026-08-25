# LOYAL — handover

Written 2026-08-26. Everything below was verified against the live chain or a
fork of it; nothing here is from memory or a deploy log.

**Nothing is committed.** The whole tree is uncommitted work.

---

## 1. What LOYAL is, and where

| | |
|---|---|
| Token | `0x1B7f9c45DfF56d8b4309f01afb4763d9C595318e` — `Loyal (LOYAL)`, 1,000,000,000 supply, 18 decimals |
| Chain | **4663, Robinhood Chain** — *not* BNB |
| Curve | `0x46286E8Fb83BAAfaa7D9Af26cc6d52e3EEcA205b` (Pons), **not graduated** |
| Curve deployer | `0x16E7C1B229d5701e75Cccb68C13fcbf98FE5c027` — an **EOA** |
| Creator tax | **200 bps = 2%** (`creatorTaxBps()`), plus 1% Pons fee |
| Graduation | 4.2 ETH threshold, ~0.32 ETH raised (~7.6%) |
| Pons factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Pons fee escrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` |

The reserve stack (Treasury, FeeSink, StakedLoyal, Redeemer, Distributor) is
**written, tested, and not deployed**.

> The tax is **2%**, not 4%. It was hardcoded at 4% at one point and the page
> contradicted itself in two visible places. The frontend now reads it live and
> only falls back to a constant when the RPC is unreachable.

---

## 2. Three separate projects in this repo

| Directory | What it is | State |
|---|---|---|
| `contracts/` | **LOYAL** on 4663 | active work — rebranded, tiers added, tested |
| `frontend/` | the old AGORA frontend on 4663 | untouched this session |
| `torii-bnb/` | **TORII** on BNB Chain 56 | separate product, own token, own frontend |
| `loyal-frontend/` | **LOYAL** frontend, Next.js + cyberpunk | active work |

`torii-bnb` is a different token on a different chain. Do not cross-wire them.

---

## 3. Contracts — what changed

### Rebrand AGORA → LOYAL, complete

42 files, zero leftovers. Critically this included **seven symbols a previous
rebrand deliberately left frozen** (`agora`, `setAgora`, `stakedAgora`,
`cumulativeToAgora`, `ReroutedToAgora`, `AgoraSet`, `AgoraAlreadySet`) because
renaming them changes function selectors and would have broken contracts already
live on 4663. LOYAL is a **fresh deployment**, so that constraint is gone and they
were renamed properly.

`StakedAgora.sol` → `StakedLoyal.sol`.

### Suits removed entirely

`StakedSuits.sol` deleted. The Distributor lost its second sink and with it the
split, `suitsBps`, the reroute logic **and `Ownable`** — it now has no privileged
caller at all, an immutable destination, and no way to redirect the income
stream.

### Beefy removed entirely

Deleted: `adapters/BeefyCLMAdapter.sol`, `interfaces/IBeefyCLM.sol`,
`libraries/UniV3Math.sol`, `mocks/BeefyMocks.sol`, `test/BeefyAdapter.test.ts`,
`scripts/deploy-beefy-adapter.ts`, `scripts/rehearse-beefy.ts`,
`scripts/queue-adapter.ts`, `BEEFY-README.md`.

> **Open question for the next session.** The Treasury still carries the generic
> yield-sleeve machinery — `queueAdapter`, `activateAdapter`, `sleeveBps`,
> `realizeSurplus`, `withdraw()`. Nothing uses it and no adapter exists. Leaving
> it costs nothing functionally but keeps `withdraw()` alive, which is the single
> reason the floor is "reported, not guaranteed". Ask whether they want it
> stripped — it would materially strengthen the trust story, and it is a large
> refactor of a well-tested contract, so it is their call.

### Loyalty tiers — the product change

`StakedLoyal` now splits income by **weight**, not share count.

| Tier | Lock | Multiplier | bps |
|---|---|---|---|
| `NONE` | none | **0.5×** | 5000 |
| `DAY` | 1 day | **1×** | 10000 |
| `WEEK` | 7 days | **3×** | 30000 |

Design decisions worth not re-litigating:

- **`totalAssets()` and the share price are untouched.** One stLOYAL is one
  LOYAL, always. Only the reward accumulator is weighted, so every ERC-4626
  integrator downstream still works.
- **Multipliers divide, they do not mint.** A vault where everyone is unlocked
  still pays out every wei.
- **Locked shares cannot move** — `transfer`, `withdraw` and `redeem` all revert
  `StillLocked`. Enforced once in `_update`, since every exit burns.
- **Expiry needs a poke.** Weight cannot update itself, so `kick(address)` is
  permissionless and demotes an expired lock to 0.5×. Every other staker is paid
  to call it — removing a stale 3× raises their own share. The window between
  expiry and kick is bounded by attention, not code, and that is stated in the
  contract rather than hidden.
- **History is not rewritten.** Rewards earned at 3× survive the kick, because
  the accumulator already divided them by a `totalWeight` that included it.

### stLOYAL has 21 decimals

`_decimalsOffset()` returns 3, so `decimals() = 18 + 3`. Formatting a share
balance through `formatEther` prints it **1000× too large** — this was a live
display bug on a sibling deployment. The frontend has `ST_LOYAL_DECIMALS`.

---

## 4. Tests — 168 local + 15 fork, all green

```
npx hardhat test                                    # 168 passing
FORK=1 npx hardhat test test/ForkLoyal.test.ts      # 7 passing
FORK=1 npx hardhat test test/ForkRelaunch.test.ts   # 8 passing
```

New this session:

- **`test/LoyaltyTiers.test.ts`** (34) — multipliers, locks, kick, plus
  adversarial: the 4626 first-depositor donation attack, **reentrancy on the ETH
  payout** (there is a `ReentrantClaimer` mock), the 21-decimal round trip, dust
  bounds, and the invariant `totalWeight == Σ weightOf` through a messy sequence.
- **`test/Distributor.test.ts`** (13) — replaces coverage deleted with
  `SuitsSplit.test.ts`. One test catches a real trap: `distribute` must check
  `totalWeight()`, not `totalSupply()`. At 1 share unit, supply is 1 but weight
  truncates to 0, so a supply-checking router would forward ETH the vault rejects.
- **`test/ForkLoyal.test.ts`** (7) — the vault against the **real LOYAL token** on
  a 4663 fork. The important one is *no fee on transfer*; a mock cannot falsify
  that because a mock is written to satisfy it.
- **`test/ForkRelaunch.test.ts`** (8) — see §5.

### Fork gotcha

Chain 4663 has no hardfork history in Hardhat's table. A call executed **at** the
fork block fails with `No known hardfork for execution on historical block`.
`await network.provider.send("evm_mine")` once in `before` fixes it.

---

## 5. ⚠ The deploy — read this before spending gas

LOYAL is **already launched with an EOA as the curve's fee recipient**. The
previous version of this product (v1) died on exactly this step: the fee
recipient was moved to a contract that could not sweep, `deployer` moved with it,
and the entire fee stream was stranded permanently. v2 avoided it by launching
with the FeeSink already set. **LOYAL cannot use that ordering.**

Rehearsed on a fork against the real contracts, and all of this is confirmed:

1. `curve.setCreatorFeeRecipient(x)` reverts **`NotFactory()`** (`0x32cc7236`).
   Only the Pons factory may call it.
2. The factory is keyed by **TOKEN**, not by curve. Passing the curve reverts
   **`TokenNotFound()`** (`0xcbdb7b30`).
3. The factory offers **two non-equivalent routes**:
   - `transferCreatorFeeRecipient(token, to)` — **applies immediately**
   - `setCreatorFeeRecipient(token, to)` → wait **72h** →
     `executeCreatorFeeRecipientChange(token)` — timelocked
   (`CREATOR_FEE_RECIPIENT_TIMELOCK` = 259200s, execution window also 259200s)
4. After it lands, `curve.deployer()` **is** the FeeSink, and the old EOA can no
   longer `sweepFees`. Both asserted.

**Recommendation: use the timelocked route.** Three days to notice a wrong
address before it costs the fee stream forever. The immediate route is the one
that killed v1.

### Deploy order

```bash
cd contracts
# .env needs: DEPLOYER_PRIVATE_KEY, TREASURY_OWNER, RH_RPC_URL
npx hardhat run scripts/deploy.ts --network robinhood     # → Treasury + FeeSink
# then: TOKEN, TREASURY, FEE_SINK into .env
npx hardhat run scripts/bind.ts --network robinhood       # → StakedLoyal, Redeemer, Distributor + wiring
```

`bind.ts` was updated: no Suits vault, and the Distributor is constructed with
one argument (`stakedLoyal`) and no owner.

The user said they will set the fee receiver themselves once given the address —
**that address is the FeeSink from step 1**, and it must go through the factory
by the route above.

`TREASURY_OWNER` controls 14 `onlyOwner` functions including `withdraw()` and
`setOperator()`. Whoever holds it can move every wei of the reserve. Should be a
multisig; blank falls back to the deployer EOA with a warning.

---

## 6. loyal-frontend

Next.js 14.2.5, App Router, Tailwind, shadcn-style primitives written in-repo.
`create-next-app` is broken in this npm version (infinite recursion) — the
project was scaffolded by hand. **Do not re-run it.**

```bash
cd loyal-frontend && npm run dev     # :3000
```

Routes: `/` (the dictionary + ledger + risks), `/stake` (the offer).

Design decisions that took iteration and should not be undone casually:

- **The masthead is a real dictionary entry**, and the client's line —
  *"Give me 1 Day to earn your loyalty…"* — is the **usage example** under sense
  2. In a box it reads as marketing; in italics under the sense it reads as
  evidence. That placement is the whole idea.
- **The tiers are a chart, not three cards.** Bar height *is* the multiplier
  (3× is six times 0.5×), horizontal position is the lock. Three equal cards
  said the options were peers; they are not. The unlocked bar flickers and the
  week bar is solid — commitment reads as stability without a sentence.
- **Selection visibly drives the panel below** (`key={tier.key}` remounts it, the
  panel restates the choice, the button names it). It did not, and nobody could
  tell clicking did anything.
- **The chain state is a ledger, not stat cards.** Cards flattened price, supply
  and an undeployed contract into equal importance.
- **`null` ≠ `0n`.** A value that could not be read renders "unavailable", never
  zero. Most of the stack is undeployed, so this is load-bearing.
- One shared poller (`useChain`) — two pollers meant the same figure briefly
  disagreeing in two places.

Wallet: hand-rolled `useWallet` (no wagmi). Never prompts on load —
`eth_accounts` on mount, `eth_requestAccounts` only from a click. Three header
states: not connected / wrong network / connected.

Socials in the header: `t.me/LoyalRobinhood`, `x.com/LoyalRobinhood`.
Logo `public/logo.webp` → `src/app/icon.png` (favicon).

### To finish when contracts land

Fill `LOYAL` in `src/lib/chain.ts` — the zero addresses are deliberate, the reads
resolve to `null`, and the UI says "not deployed". Then wire the stake form's
write path (`deposit` + `lock`) using `wallet.getSigner()`; the ABI in
`src/lib/reads.ts` is already correct.

---

## 7. Open items

1. **Strip the sleeve from Treasury?** (§3) — their call.
2. **Deploy** (§5) — blocked on their key, which I will not touch.
3. **Stake write path** in the frontend — blocked on deployment.
4. `scripts/collect-fees.ts` and `claim-yield.ts` have **pre-existing** `tsc`
   errors in files I did not touch. Not regressions.
5. `frontend/` (the AGORA one) still references Suits and Beefy. Untouched — it
   is a different, live deployment.
