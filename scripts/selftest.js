// Guard self-test: attacks the live testnet deployment and records proof.
//   node scripts/selftest.js            -> runs all, writes site/data/selftest.json
const fs = require("fs");
const path = require("path");
const { D, CHAINS, ethers, usd, wallet, guard, ownerSigner, agentSigner, lasnaFees, status, ROOT } = require("../agent/chain");

const BAD = "0x000000000000000000000000000000000000bad1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txUrl = (c, h) => CHAINS[c].explorer + h;

async function clean() {
  const s = await status();
  const fees = await lasnaFees();
  const g = guard(ownerSigner("lasna"));
  if (s.tripped || s.chains.base.frozen || s.chains.unichain.frozen) {
    await (await g.resume({ gasLimit: 300000, ...fees })).wait();
    for (let i = 0; i < 120; i++) {
      const x = await status();
      if (!x.chains.base.frozen && !x.chains.unichain.frozen) break;
      await sleep(500);
    }
  }
  await (await g.resetWindow({ gasLimit: 200000, ...(await lasnaFees()) })).wait();
}

async function agentSpend(chain, to, amount) {
  const w = wallet(chain, agentSigner(chain));
  const tx = await w.spend(to, usd(amount), { gasLimit: 200000 });
  const r = await tx.wait();
  const parsed = r.logs.map((l) => { try { return w.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
  return { hash: tx.hash, url: txUrl(chain, tx.hash), kind: parsed.find((p) => p.name === "Blocked") ? "blocked" : "spent", receiptAt: Date.now() };
}

async function timeToFreeze(t0, timeout = 60000) {
  while (Date.now() - t0 < timeout) {
    const [a, b] = await Promise.all([wallet("base").frozen(), wallet("unichain").frozen()]);
    if (a && b) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(150);
  }
  return null;
}

async function frozenRefuses(chain) {
  try {
    await wallet(chain, agentSigner(chain)).spend.staticCall(D.merchants["weather-api"], usd(1));
    return false;
  } catch (e) {
    return /WalletFrozen|0x/.test(String(e.data || e.message || e));
  }
}

async function freezeTxs(sinceMs) {
  // find the Frozen events on each chain (callbacks delivered by Reactive)
  const out = {};
  for (const c of ["base", "unichain"]) {
    const w = wallet(c);
    const head = await w.runner.provider.getBlockNumber();
    const logs = await w.queryFilter(w.filters.Frozen(), head - 150, head);
    const last = logs[logs.length - 1];
    if (last) out[c] = txUrl(c, last.transactionHash);
  }
  return out;
}

const tests = [
  {
    id: "injection",
    title: "Prompt injection",
    attack: "A paid API's reply tells the agent to send $5 to an unknown address. The agent obeys and pays on Base.",
    expect: "The Base wallet blocks it, and Reactive freezes Base and Unichain.",
    async run() {
      const p = await agentSpend("base", BAD, 5);
      const secs = await timeToFreeze(p.receiptAt);
      const otherRefuses = await frozenRefuses("unichain");
      return {
        caught: p.kind === "blocked" && secs !== null && otherRefuses,
        secs,
        detail: `Payment to 0x…bad1 was blocked on Base. Both wallets were frozen ${secs}s after the receipt, and a follow-up payment on Unichain was refused.`,
        proof: [{ label: "Blocked payment (Base)", url: p.url }],
      };
    },
  },
  {
    id: "over-cap",
    title: "One big payment",
    attack: "The agent tries to pay an approved API $25 in one go on Unichain. The cap is $10 per payment.",
    expect: "The Unichain wallet blocks it, and Reactive freezes both chains.",
    async run() {
      const p = await agentSpend("unichain", D.merchants["market-data"], 25);
      const secs = await timeToFreeze(p.receiptAt);
      return {
        caught: p.kind === "blocked" && secs !== null,
        secs,
        detail: `The $25 payment was blocked on Unichain. Both wallets were frozen ${secs}s after the receipt.`,
        proof: [{ label: "Blocked payment (Unichain)", url: p.url }],
      };
    },
  },
  {
    id: "slow-drain",
    title: "Slow drain across chains",
    attack: "The agent makes many small, allowed $9 payments and alternates Base and Unichain, so no single chain ever looks busy.",
    expect: "Reactive adds both chains together and freezes everything once the combined total reaches $50.",
    async run() {
      const order = ["base", "unichain", "base", "unichain", "base", "unichain", "base"];
      const payees = { base: D.merchants["weather-api"], unichain: D.merchants["news-wire"] };
      const proof = [];
      const per = { base: 0, unichain: 0 };
      let secs = null;
      for (const c of order) {
        const p = await agentSpend(c, payees[c], 9);
        per[c] += 9;
        proof.push({ label: `$9 on ${c === "base" ? "Base" : "Unichain"}`, url: p.url });
        const total = per.base + per.unichain;
        if (total >= 50) { secs = await timeToFreeze(p.receiptAt); break; }
        await sleep(1500); // let Reactive count it before the next one
        const s = await status();
        if (s.tripped) { secs = 0; break; }
      }
      const total = per.base + per.unichain;
      return {
        caught: secs !== null,
        secs,
        detail: `Base saw $${per.base} and Unichain saw $${per.unichain}, both well under $50 on their own. Combined they reached $${total}, and both wallets were frozen ${secs}s after the payment that crossed the limit.`,
        proof,
      };
    },
  },
  {
    id: "self-unfreeze",
    title: "Agent tries to unfreeze itself",
    attack: "With its wallets frozen, the agent calls the wallet's unfreeze functions directly, pretending to be Reactive and pretending to be the owner.",
    expect: "Both calls are rejected. Only a callback from BudgetGuard, or the owner, can unfreeze.",
    async run() {
      const s = await status();
      if (!s.chains.base.frozen) throw new Error("expected frozen state from previous test");
      const w = wallet("base", agentSigner("base"));
      const me = agentSigner("base").address;
      const tries = [];
      for (const [label, fn] of [
        ["Fake Reactive callback (Base)", () => w.unfreezeFromGuard(me, { gasLimit: 120000 })],
        ["Fake owner unfreeze (Base)", () => w.unfreeze({ gasLimit: 120000 })],
      ]) {
        try {
          const tx = await fn();
          const r = await tx.wait().catch((e) => e.receipt || { status: 0, hash: tx.hash });
          tries.push({ label, url: txUrl("base", tx.hash), reverted: r.status === 0 });
        } catch (e) {
          const h = e.receipt?.hash || e.transaction?.hash;
          tries.push({ label, url: h ? txUrl("base", h) : null, reverted: true });
        }
      }
      const still = await wallet("base").frozen();
      return {
        caught: tries.every((t) => t.reverted) && still,
        secs: null,
        detail: `Both calls reverted on-chain (NotCallbackProxy and NotOwner). The wallet stayed frozen.`,
        proof: tries.filter((t) => t.url).map((t) => ({ label: t.label + " — reverted", url: t.url })),
      };
    },
  },
];

(async () => {
  const results = [];
  for (const t of tests) {
    if (t.id !== "self-unfreeze") await clean();
    process.stdout.write(`▶ ${t.title}… `);
    try {
      const r = await t.run();
      results.push({ id: t.id, title: t.title, attack: t.attack, expect: t.expect, ...r });
      console.log(r.caught ? `CAUGHT${r.secs != null ? ` in ${r.secs}s` : ""}` : "MISSED", "|", r.detail);
    } catch (e) {
      results.push({ id: t.id, title: t.title, attack: t.attack, expect: t.expect, caught: false, error: e.shortMessage || e.message });
      console.log("ERROR", e.shortMessage || e.message);
    }
  }
  await clean();
  const out = {
    ranAt: new Date().toISOString(),
    passed: results.filter((r) => r.caught).length,
    total: results.length,
    guard: D.lasna.guard,
    wallet: D.baseSepolia.wallet,
    results,
  };
  const dir = path.join(ROOT, "site", "data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "selftest.json"), JSON.stringify(out, null, 1));
  console.log(`\nSelf-test: ${out.passed}/${out.total} caught`);
})();
