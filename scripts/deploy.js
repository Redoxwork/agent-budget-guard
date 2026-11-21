// Usage (in order):
//   npx hardhat run scripts/deploy.js --network lasna            -> deploys BudgetGuard
//   npx hardhat run scripts/deploy.js --network baseSepolia      -> deploys MockUSD + AgentWallet
//   npx hardhat run scripts/deploy.js --network unichainSepolia  -> deploys MockUSD + AgentWallet
//   STEP=link npx hardhat run scripts/deploy.js --network lasna  -> registers both wallets on the guard
const fs = require("fs");
const { ethers, network } = require("hardhat");

const FILE = __dirname + "/../deployments.json";
const PROXY = {
  baseSepolia: "0x476F44b11F5C942c58f4c8E3d0300E5710743585",
  unichainSepolia: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
};
const CHAIN_ID = { baseSepolia: 84532, unichainSepolia: 1301 };
const usd = (n) => ethers.parseUnits(String(n), 6);

const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE)) : {});
const save = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));

async function main() {
  const [me] = await ethers.getSigners();
  const d = load();
  const name = network.name;
  console.log(`network=${name} deployer=${me.address}`);

  if (name === "lasna" && process.env.STEP === "link") {
    const guard = await ethers.getContractAt("BudgetGuard", d.lasna.guard);
    for (const n of ["baseSepolia", "unichainSepolia"]) {
      if (!d[n]) throw new Error(`deploy ${n} first`);
      const tx = await guard.addWallet(CHAIN_ID[n], d[n].wallet, { gasLimit: 1500000, maxPriorityFeePerGas: 1000000000n });
      await tx.wait();
      console.log(`linked ${n} wallet ${d[n].wallet}`);
    }
    return;
  }

  if (name === "lasna") {
    const limit = usd(process.env.DAILY_LIMIT || 50);
    const windowLen = Number(process.env.WINDOW_SECONDS || 86400);
    const fund = ethers.parseEther(process.env.GUARD_FUND || "1");
    const G = await ethers.getContractFactory("BudgetGuard");
    const guard = await G.deploy(limit, windowLen, { value: fund });
    await guard.waitForDeployment();
    d.lasna = { guard: guard.target };
    save(d);
    console.log("BudgetGuard:", guard.target);
    return;
  }

  if (PROXY[name]) {
    if (!d.lasna) throw new Error("deploy BudgetGuard on lasna first");
    const agent = process.env.AGENT_ADDRESS || me.address;
    const merchant = process.env.MERCHANT_ADDRESS || me.address;

    const token = await (await ethers.getContractFactory("MockUSD")).deploy();
    await token.waitForDeployment();

    const W = await ethers.getContractFactory("AgentWallet");
    const wallet = await W.deploy(PROXY[name], d.lasna.guard, token.target, agent, usd(process.env.PER_TX_CAP || 10), {
      value: ethers.parseEther(process.env.WALLET_GAS_FUND || "0.002"), // pays Reactive callback fees on this chain
    });
    await wallet.waitForDeployment();

    await (await token.mint(wallet.target, usd(500), { gasLimit: 120000 })).wait();
    await (await wallet.setRecipient(merchant, true, "Demo API provider", { gasLimit: 150000 })).wait();

    d[name] = { token: token.target, wallet: wallet.target, agent, merchant };
    save(d);
    console.log(`${name} MockUSD: ${token.target}\n${name} AgentWallet: ${wallet.target}`);
    return;
  }

  throw new Error(`unknown network ${name}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
