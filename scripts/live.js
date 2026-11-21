// Live demo driver. Usage:
//   node scripts/live.js spend base 9          -> agent pays allowed merchant $9 on Base Sepolia
//   node scripts/live.js attack unichain 5     -> agent tries to pay an unknown address on Unichain
//   node scripts/live.js status                -> guard + wallet state
//   node scripts/live.js resume                -> owner resumes (unfreezes all chains)
//   node scripts/live.js reset                 -> start a fresh spending window ($0 spent)
require("dotenv").config();
const fs = require("fs");
const { ethers } = require("ethers");

const d = JSON.parse(fs.readFileSync(__dirname + "/../deployments.json"));
const RPC = {
  base: "https://sepolia.base.org",
  unichain: "https://sepolia.unichain.org",
  lasna: "https://lasna-rpc.rnk.dev/",
};
const KEY = { base: "baseSepolia", unichain: "unichainSepolia" };
const art = (n) => JSON.parse(fs.readFileSync(`${__dirname}/../artifacts/contracts/${n}.sol/${n}.json`)).abi;
const pk = process.env.PRIVATE_KEY;
const usd = (n) => ethers.parseUnits(String(n), 6);
const fmt = (n) => "$" + ethers.formatUnits(n, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prov = (c) => new ethers.JsonRpcProvider(RPC[c]);
const guard = (signer) => new ethers.Contract(d.lasna.guard, art("BudgetGuard"), signer || prov("lasna"));
const wallet = (c, signer) => new ethers.Contract(d[KEY[c]].wallet, art("AgentWallet"), signer || prov(c));

async function status() {
  const s = await guard().status();
  const out = { combinedSpent: fmt(s[0]), limit: fmt(s[1]), tripped: s[4], reason: Number(s[5]), onChain: Number(s[6]) };
  for (const c of ["base", "unichain"]) {
    const w = wallet(c);
    out[c] = { frozen: await w.frozen(), reason: Number(await w.frozenReason()) };
  }
  return out;
}

async function watch(label, done, timeoutS = 90) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutS) {
    const s = await status();
    if (done(s)) {
      console.log(`${label} after ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(s));
      return s;
    }
    await sleep(1000);
  }
  console.log(`${label}: timed out`, JSON.stringify(await status()));
}

async function main() {
  const [cmd, chain, amt] = process.argv.slice(2);
  if (cmd === "status") return console.log(JSON.stringify(await status(), null, 2));

  if (cmd === "reset") {
    const g = guard(new ethers.Wallet(pk, prov("lasna")));
    const tx = await g.resetWindow({ gasLimit: 200000, maxPriorityFeePerGas: 2_000_000_000n, maxFeePerGas: ((await prov("lasna").getFeeData()).maxFeePerGas || 0n) * 2n });
    await tx.wait();
    return console.log("window reset", JSON.stringify(await status()));
  }

  if (cmd === "resume") {
    const g = guard(new ethers.Wallet(pk, prov("lasna")));
    const fee = await prov("lasna").getFeeData();
    const tx = await g.resume({ gasLimit: 1500000, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: (fee.maxFeePerGas || 0n) + 1_000_000_000n });
    console.log("resume tx", tx.hash);
    await tx.wait();
    return watch("unfrozen everywhere", (s) => !s.base.frozen && !s.unichain.frozen, 120);
  }

  const before = await guard().spentInWindow();
  const w = wallet(chain, new ethers.Wallet(pk, prov(chain)));
  const to = cmd === "attack" ? ethers.Wallet.createRandom().address : d[KEY[chain]].merchant;
  const tx = await w.spend(to, usd(amt), { gasLimit: 200000 });
  const r = await tx.wait();
  console.log(`${cmd} ${fmt(usd(amt))} on ${chain}: ${tx.hash} (block ${r.blockNumber})`);

  await watch("guard saw it", async (s) => true, 1); // print immediately
  await watch(
    "reactive result",
    (s) => s.tripped || s.base.frozen || s.unichain.frozen || s.combinedSpent !== fmt(before),
    90
  );
  // if tripped, wait for both freezes to land
  const s = await status();
  if (s.tripped) await watch("both chains frozen", (x) => x.base.frozen && x.unichain.frozen, 120);
}

main().catch((e) => { console.error(e.shortMessage || e); process.exit(1); });
