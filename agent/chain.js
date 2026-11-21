// Shared on-chain helpers for the agent, policy tool and dashboard.
require("dotenv").config({ path: __dirname + "/../.env", quiet: true });
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments.json")));

const CHAINS = {
  base: { key: "baseSepolia", id: 84532, rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org", explorer: "https://sepolia.basescan.org/tx/" },
  unichain: { key: "unichainSepolia", id: 1301, rpc: process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org", explorer: "https://sepolia.uniscan.xyz/tx/" },
  lasna: { id: 5318007, rpc: process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/" },
};

const abi = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, `artifacts/contracts/${n}.sol/${n}.json`))).abi;
const providers = {};
const provider = (c) => (providers[c] ||= new ethers.JsonRpcProvider(CHAINS[c].rpc, CHAINS[c].id, { staticNetwork: true }));

const usd = (n) => ethers.parseUnits(String(n), 6);
const fmt = (n) => Number(ethers.formatUnits(n, 6));

const guard = (signer) => new ethers.Contract(D.lasna.guard, abi("BudgetGuard"), signer || provider("lasna"));
const wallet = (c, signer) => new ethers.Contract(D[CHAINS[c].key].wallet, abi("AgentWallet"), signer || provider(c));

const ownerSigner = (c) => new ethers.Wallet(process.env.PRIVATE_KEY, provider(c));
const agentSigner = (c) => new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider(c));

// Lasna rejects zero-tip txs; give it explicit fees.
async function lasnaFees() {
  const f = await provider("lasna").getFeeData();
  const gp = f.gasPrice || 100_000_000_000n;
  return { maxPriorityFeePerGas: 2_000_000_000n, maxFeePerGas: (gp * 3n) / 2n + 2_000_000_000n };
}

async function status() {
  const s = await guard().status();
  const out = {
    spent: fmt(s[0]),
    limit: fmt(s[1]),
    windowStart: Number(s[2]),
    windowLength: Number(s[3]),
    tripped: s[4],
    reason: Number(s[5]),
    onChain: Number(s[6]),
    chains: {},
  };
  for (const c of ["base", "unichain"]) {
    const w = wallet(c);
    const [frozen, reason, cap] = await Promise.all([w.frozen(), w.frozenReason(), w.perTxCap()]);
    out.chains[c] = { frozen, reason: Number(reason), perTxCap: fmt(cap) };
  }
  return out;
}

module.exports = { D, CHAINS, ethers, provider, usd, fmt, guard, wallet, ownerSigner, agentSigner, lasnaFees, status, ROOT };
