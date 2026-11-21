// Moves Sepolia ETH from the deploy wallet to Base Sepolia, Unichain Sepolia (OP Stack bridges)
// and buys lREACT via the Reactive faucet on Sepolia.
// Usage: node scripts/fund.js <faucetEth> <baseEth> <uniEth>
require("dotenv").config();
const { ethers } = require("ethers");

const SEPOLIA_RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const BRIDGE = {
  base: "0xfd0Bf71F60660E2f608ed56e1659C450eB113120",
  unichain: "0xea58fcA6849d79EAd1f26608855c2D6407d54Ce2",
};
const REACTIVE_FAUCET = "0x9b9BB25f1A81078C544C829c5EB7822d747Cf434";

async function main() {
  const [faucetEth, baseEth, uniEth] = process.argv.slice(2);
  const p = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const w = new ethers.Wallet(process.env.PRIVATE_KEY, p);
  console.log("balance", ethers.formatEther(await p.getBalance(w.address)));
  const bridgeAbi = ["function depositETH(uint32 _minGasLimit, bytes _extraData) payable"];

  if (Number(faucetEth) > 0) {
    const f = new ethers.Contract(REACTIVE_FAUCET, ["function request(address) payable"], w);
    const tx = await f.request(w.address, { value: ethers.parseEther(faucetEth) });
    console.log("reactive faucet", tx.hash); await tx.wait();
  }
  for (const [name, amt] of [["base", baseEth], ["unichain", uniEth]]) {
    if (!(Number(amt) > 0)) continue;
    const b = new ethers.Contract(BRIDGE[name], bridgeAbi, w);
    const tx = await b.depositETH(200000, "0x", { value: ethers.parseEther(amt) });
    console.log("bridge", name, tx.hash); await tx.wait();
  }
  console.log("balance after", ethers.formatEther(await p.getBalance(w.address)));
}
main().catch((e) => { console.error(e.shortMessage || e); process.exit(1); });
