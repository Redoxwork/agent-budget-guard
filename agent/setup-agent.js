// One-time: create a spend-only agent key, give it gas, point both wallets at it,
// and create the demo merchant addresses (the "paid APIs").
//   node agent/setup-agent.js
const fs = require("fs");
const path = require("path");
const { D, CHAINS, ethers, provider, wallet, ownerSigner, ROOT } = require("./chain");

async function main() {
  const envPath = path.join(ROOT, ".env");
  let env = fs.readFileSync(envPath, "utf8");
  if (!/AGENT_PRIVATE_KEY=0x/.test(env)) {
    const k = ethers.Wallet.createRandom();
    env += `AGENT_PRIVATE_KEY=${k.privateKey}\n`;
    fs.writeFileSync(envPath, env, { mode: 0o600 });
    process.env.AGENT_PRIVATE_KEY = k.privateKey;
    console.log("new agent key:", k.address);
  }
  const agent = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY).address;

  if (!D.merchants) {
    D.merchants = {};
    for (const id of ["weather-api", "market-data", "news-wire"]) D.merchants[id] = ethers.Wallet.createRandom().address;
  }

  for (const c of ["base", "unichain"]) {
    const owner = ownerSigner(c);
    const w = wallet(c, owner);
    const bal = await provider(c).getBalance(agent);
    if (bal < ethers.parseEther("0.0005")) {
      const tx = await owner.sendTransaction({ to: agent, value: ethers.parseEther("0.0015"), gasLimit: 21000 });
      await tx.wait();
      console.log(`${c}: funded agent gas`);
    }
    if ((await w.agent()) !== agent) {
      await (await w.setAgent(agent, { gasLimit: 80000 })).wait();
      console.log(`${c}: agent set to ${agent}`);
    }
    D[CHAINS[c].key].agent = agent;
  }
  fs.writeFileSync(path.join(ROOT, "deployments.json"), JSON.stringify(D, null, 2));
  console.log("merchants:", D.merchants);
}

main().catch((e) => { console.error(e.shortMessage || e); process.exit(1); });
