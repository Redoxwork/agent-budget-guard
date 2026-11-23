# Agent Budget Guard

**One spending limit for your AI agent, across every chain — enforced by Reactive Network.**

AI agents now hold wallets on several chains. Nothing stops one from blowing its budget on Base *and* Unichain at the same time, or from paying an attacker after a prompt injection. Agent Budget Guard gives the agent a single cross-chain budget. A Reactive contract keeps one combined total and freezes every wallet on every chain in about a second. No keeper, no bot, no server.

Track: **Reactive Meets AI** — Reactive Omni Buildathon.

**Demo video (3:36):** https://youtu.be/qGPGWZg9rWs

**Live site:** https://redoxwork.github.io/agent-budget-guard/ (the Live guard page reads all three chains straight from your browser)

## How it works

```
 Base Sepolia                Reactive Lasna                Unichain Sepolia
┌──────────────┐  Spent /   ┌────────────────┐   Spent /   ┌──────────────┐
│ AgentWallet  │──Blocked──▶│  BudgetGuard   │◀──Blocked───│ AgentWallet  │
│  (agent pays)│            │ combined total │             │  (agent pays)│
│              │◀──freeze───│ trips at limit │───freeze───▶│              │
└──────────────┘  callback  └────────────────┘  callback   └──────────────┘
```

- **AgentWallet** (one per chain): the agent calls `spend(to, amount)`. Allowlist and per-payment cap are checked locally. A policy break doesn't revert. It emits `Blocked` so Reactive sees the attempt.
- **BudgetGuard** (Lasna): subscribes to `Spent` and `Blocked` from every registered wallet.
  - On `Spent`: it adds to one combined total for the window. If the total reaches the daily limit, it freezes **all** wallets.
  - On `Blocked`: it treats this as an attack and freezes **all** wallets immediately, so an attack seen on Unichain also locks Base.
- `freeze()` only accepts calls that come through that chain's Reactive callback proxy **and** carry BudgetGuard as the injected sender.
- The owner can always `withdraw` (funds are never stuck) and `resume()` from the guard, which unfreezes every chain by callback.

## Live on testnet

| Contract | Chain | Address |
|---|---|---|
| BudgetGuard | Reactive Lasna (5318007) | `0xA8748447cECf3cC34331CE855E2a38f0D60794e1` |
| AgentWallet | Base Sepolia (84532) | `0x6A0180ab7b95EFc96EE51d1425444377E5eb1376` |
| AgentWallet | Unichain Sepolia (1301) | `0x6A0180ab7b95EFc96EE51d1425444377E5eb1376` |
| MockUSD | Base + Unichain Sepolia | `0xA8748447cECf3cC34331CE855E2a38f0D60794e1` |

**Proof runs (21 Nov 2026)**
- Attack: the agent tried to pay an unknown address on Unichain ([tx](https://sepolia.uniscan.xyz/tx/0xcbf798db629449517c3ee29371b96764b6d0082de0b0cd4b50386bb61d2793d7)). Both the Base and Unichain wallets were frozen about 1s later.
- Budget: $10 spends alternating Base → Unichain → Base → Unichain. The combined total went $28 → $38 → $48 → $58. The last spend ([tx](https://sepolia.uniscan.xyz/tx/0x27bea62896c73746a0d031a955af8c33b7468a53496ac4b4f0e419f33d416983)) crossed the $50 limit, and both chains were frozen about 1s later.
- Resume: one owner call on Lasna unfroze both chains by callback in about 2s.

Drive it yourself:
```bash
node scripts/live.js spend base 9
node scripts/live.js attack unichain 5
node scripts/live.js status
node scripts/live.js resume
node scripts/live.js reset
```

## The AI agent

`agent/` holds a real tool-using agent. Its job is to write a morning brief for a trader, and it pays per call for three APIs: `weather-api` on Base ($2), `market-data` on Unichain ($8) and `news-wire` on Unichain ($3). Its key can **only spend**. It can't change limits, the allowlist or freezes.

```bash
node agent/setup-agent.js                      # one-time: spend-only agent key + demo payees
node agent/policy.js "Max $50 a day, nothing over $10 at once, only pay weather-api, market-data and news-wire" --apply
node agent/run.js --scripted                   # normal run
node agent/run.js --scripted --inject          # news API carries a prompt injection -> freeze
node agent/run.js --inject                     # real LLM (set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL)
node agent/run.js --inject --compromised       # real LLM told to obey tool output (simulated jailbreak)
```

**Plain-English policy:** the AI turns your sentence into rules, but it only *proposes* them. Code checks them against hard bounds (it can't invent payees, and caps are bounded), shows them to you, and writes them on-chain only with `--apply`. From then on Reactive enforces the rules, so the agent can't talk its way past them.

**Live injection run (21 Nov 2026):** the agent bought weather ($2, Base), market data ($8, Unichain) and news ($3, Unichain). The news response told it to pay `0x…bad1` $5. The Base wallet blocked the payment, and BudgetGuard froze Base **and** Unichain 0.8s after the receipt. The agent's next two purchases were refused on both chains.

## Why this needs Reactive
An agent that spends on two chains has two separate wallets, and neither chain can see what the other one spent. A per-chain limit lets a careful attacker drain $27 on Base and $27 on Unichain while each chain thinks everything is fine. Fixing that without Reactive means running an off-chain bot that watches both chains, holds keys, and has to stay online. With Reactive, the combined limit lives in a reactive contract: it subscribes to both chains' events, keeps one total, and pushes freeze callbacks to every chain on its own. There's no server to hack or keep alive.

## Full loop: transaction hashes (live demo, 22 Nov 2026, 23:27 UTC)
| Step | Chain | Tx |
|---|---|---|
| 1. Origin: the AI agent's payment to the attacker is blocked (`Blocked` event) | Base Sepolia | [0x13e3…42eb](https://sepolia.basescan.org/tx/0x13e302593658f603a2b11d64d42efb477a1510b3b045ceeccccfb94a11a242eb) |
| 2. Reaction: `BudgetGuard.react()` trips and requests freeze callbacks | Reactive Lasna | `0x9c8f2c3296eded39f9eee4876b1c6d55a589a73545368db1dca2cd050a9d9491` |
| 3. Callback: `AgentWallet.freeze()` via the Reactive callback proxy | Base Sepolia | [0x9b7b…8c56](https://sepolia.basescan.org/tx/0x9b7be33960742e62c7d8f9a201ec550513975293a1021f0bc56eb601fb518c56) |
| 4. Callback: `AgentWallet.freeze()` via the Reactive callback proxy | Unichain Sepolia | [0x28e6…82c6](https://sepolia.uniscan.xyz/tx/0x28e624c90bd50e826ffd6ba424acd9f80f7d3abbcb9313b8e9123657c62d82c6) |

**Latency:** the origin block (23:27:26) and the Lasna reaction landed in the same second, and both freeze callbacks landed in blocks stamped 23:27:28, so the full loop took about 2 seconds. From the agent's side, both wallets already read as frozen 0.1s after its blocked payment's receipt came back, so the freeze arrived before its next move. More loops (budget limit, slow cross-chain drain, oversized payment) are linked on the [Self-test page](https://redoxwork.github.io/agent-budget-guard/selftest.html).

## Run tests

```bash
npm install
npx hardhat test
```

The tests simulate the whole Reactive loop locally. They feed real wallet logs into `react()` and deliver the requested callbacks through each chain's proxy. 11 tests cover: combined total across chains, budget trip, attack trip, over-cap trip, resume, window roll, and security checks.

## Deploy to testnet

You need testnet ETH on Base Sepolia and Unichain Sepolia, plus lREACT on Lasna (see the Reactive docs faucet).

```bash
cp .env.example .env   # add a TESTNET-ONLY private key
node scripts/fund.js 0.01 0.016 0.016   # optional: Sepolia ETH -> lREACT + bridge to Base/Unichain
npx hardhat run scripts/deploy.js --network lasna
npx hardhat run scripts/deploy.js --network baseSepolia
npx hardhat run scripts/deploy.js --network unichainSepolia
STEP=link npx hardhat run scripts/deploy.js --network lasna
node agent/setup-agent.js        # spend-only agent key + demo payees
node agent/policy.js "Max $50 a day, nothing over $10 at once, only pay weather-api, market-data and news-wire" --apply
```

Addresses are saved to `deployments.json`.

## Self-test in GitHub Actions
`.github/workflows/selftest.yml` runs on every code change: unit tests, then `scripts/selftest.js` attacks the live testnet contracts with 4 scenarios, commits `site/data/selftest.json` and republishes the site. To enable it in a fork, add two repository secrets (testnet keys only):
- `PRIVATE_KEY`: the owner/deployer key
- `AGENT_PRIVATE_KEY`: the agent's spend-only key

## Notes for building on Reactive Omni
- Use `SYSTEM.requestCallbackV_1_0(...)` rather than the deprecated `Callback` event. The first argument of the callback payload is overwritten with the reactive contract's address, so destination contracts check both `msg.sender == callbackProxy` and that injected sender.
- Omni has a single state (no RVM), so `subscribe()` can be called after deployment (`addWallet`).
- Lasna rejects transactions with a zero priority fee; set `maxPriorityFeePerGas`.
- The reactive contract's own balance pays for callbacks. Keep it topped up (`scripts/fund.js` + a plain transfer), or freezes stop arriving.
- Don't name a destination function `pay(...)`: `AbstractPayer` already has `pay(uint256)`.

## License
MIT

## Roadmap for the buildathon
- [x] Contracts and simulated full loop
- [x] Live testnet loop (Base + Unichain + Lasna)
- [x] AI agent that pays for APIs from the wallets
- [x] Plain-English policy → on-chain rules (AI writes the policy, Reactive enforces it)
- [x] Website in `site/`: Home, Live guard (reads all three chains in the browser, no server), Case files, Self-test, How it works
- [x] Self-test: `node scripts/selftest.js` runs 4 attacks on testnet. Result: 4/4 caught
- [x] Demo video
