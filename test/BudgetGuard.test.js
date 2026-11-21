const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const SYSTEM = "0x8888888888888888888888888888888888888888";
const BASE = 84532n;
const UNI = 1301n;
const usd = (n) => ethers.parseUnits(String(n), 6);

describe("Agent Budget Guard — full reactive loop (simulated)", function () {
  let owner, agent, merchant, attacker, proxyBase, proxyUni, stranger;
  let sys, guard, token, wBase, wUni, sysSigner;

  // Reactive Network simulation ---------------------------------------
  // 1) take wallet logs from a tx, 2) feed them to guard.react() as the system contract,
  // 3) take the callbacks guard requested and deliver them through each chain's proxy.
  async function relay(receipt, chainId) {
    const callbacks = [];
    for (const log of receipt.logs) {
      const t = log.topics.map((x) => BigInt(x));
      const rec = {
        chainId,
        contractAddress: log.address,
        topic0: t[0] ?? 0n, topic1: t[1] ?? 0n, topic2: t[2] ?? 0n, topic3: t[3] ?? 0n,
        data: log.data,
        blockNumber: BigInt(log.blockNumber),
        opCode: BigInt(log.topics.length),
        blockHash: BigInt(log.blockHash),
        txHash: BigInt(log.transactionHash),
        logIndex: BigInt(log.index),
      };
      const r = await (await guard.connect(sysSigner).react(rec)).wait();
      for (const l of r.logs) {
        if (l.address.toLowerCase() !== SYSTEM.toLowerCase()) continue;
        const p = sys.interface.parseLog(l);
        if (p && p.name === "CallbackRequested") callbacks.push(p.args);
      }
    }
    for (const cb of callbacks) await deliver(cb);
    return callbacks;
  }

  async function deliver(cb) {
    const proxy = cb.chainId === BASE ? proxyBase : proxyUni;
    // Reactive overwrites the first 160 bits (first arg) with the reactive contract's address
    const payload = cb.payload.slice(0, 10) + ethers.zeroPadValue(guard.target, 32).slice(2) + cb.payload.slice(74);
    await (await proxy.sendTransaction({ to: cb.recipient, data: payload })).wait();
  }

  async function collect(tx) {
    const r = await (await tx).wait();
    const out = [];
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== SYSTEM.toLowerCase()) continue;
      const p = sys.interface.parseLog(l);
      if (p && p.name === "CallbackRequested") out.push(p.args);
    }
    return out;
  }

  beforeEach(async () => {
    [owner, agent, merchant, attacker, proxyBase, proxyUni, stranger] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockSystem");
    const m = await Mock.deploy();
    await network.provider.send("hardhat_setCode", [SYSTEM, await ethers.provider.getCode(m.target)]);
    sys = Mock.attach(SYSTEM);
    await network.provider.send("hardhat_impersonateAccount", [SYSTEM]);
    await network.provider.send("hardhat_setBalance", [SYSTEM, "0x56BC75E2D63100000"]);
    sysSigner = await ethers.getSigner(SYSTEM);

    guard = await (await ethers.getContractFactory("BudgetGuard")).deploy(usd(50), 86400);
    token = await (await ethers.getContractFactory("MockUSD")).deploy();

    const W = await ethers.getContractFactory("AgentWallet");
    wBase = await W.deploy(proxyBase.address, guard.target, token.target, agent.address, usd(10));
    wUni = await W.deploy(proxyUni.address, guard.target, token.target, agent.address, usd(10));

    await guard.addWallet(BASE, wBase.target);
    await guard.addWallet(UNI, wUni.target);

    for (const w of [wBase, wUni]) {
      await token.mint(w.target, usd(500));
      await w.setRecipient(merchant.address, true, "API provider");
    }
  });

  it("subscribes to Spent + Blocked on both chains", async () => {
    expect(await sys.subCount()).to.equal(4n);
    expect(await guard.walletCount()).to.equal(2n);
  });

  it("keeps one combined total and freezes BOTH chains when the budget is used up", async () => {
    const plan = [[wBase, BASE, 9], [wUni, UNI, 9], [wBase, BASE, 10], [wUni, UNI, 10], [wBase, BASE, 8]]; // = 46
    for (const [w, c, amt] of plan) {
      const cbs = await relay(await (await w.connect(agent).spend(merchant.address, usd(amt))).wait(), c);
      expect(cbs.length).to.equal(0);
    }
    const s = await guard.status();
    expect(s.spent).to.equal(usd(46));
    expect(await guard.spentByChain(await guard.windowStart(), BASE)).to.equal(usd(27));
    expect(await guard.spentByChain(await guard.windowStart(), UNI)).to.equal(usd(19));

    // this one crosses $50 on Unichain -> freeze fans out to Base AND Unichain
    const cbs = await relay(await (await wUni.connect(agent).spend(merchant.address, usd(5))).wait(), UNI);
    expect(cbs.length).to.equal(2);
    expect(await wBase.frozen()).to.equal(true);
    expect(await wUni.frozen()).to.equal(true);
    expect(await wBase.frozenReason()).to.equal(1);
    expect(await guard.trippedOnChain()).to.equal(UNI);

    await expect(wBase.connect(agent).spend(merchant.address, usd(1))).to.be.revertedWithCustomError(wBase, "WalletFrozen");
  });

  it("a blocked attack on one chain freezes every chain instantly", async () => {
    const r = await (await wUni.connect(agent).spend(attacker.address, usd(5))).wait();
    expect(await token.balanceOf(attacker.address)).to.equal(0n); // never moved
    const cbs = await relay(r, UNI);
    expect(cbs.length).to.equal(2);
    expect(await wBase.frozen()).to.equal(true);
    expect(await wUni.frozen()).to.equal(true);
    expect(await wBase.frozenReason()).to.equal(2);
  });

  it("over-cap single payment is blocked and trips the guard", async () => {
    const r = await (await wBase.connect(agent).spend(merchant.address, usd(25))).wait();
    await relay(r, BASE);
    expect(await wUni.frozen()).to.equal(true);
  });

  it("owner resume() unfreezes all wallets via callbacks", async () => {
    await relay(await (await wUni.connect(agent).spend(attacker.address, usd(5))).wait(), UNI);
    const cbs = await collect(guard.resume());
    expect(cbs.length).to.equal(2);
    for (const cb of cbs) await deliver(cb);
    expect(await wBase.frozen()).to.equal(false);
    expect(await wUni.frozen()).to.equal(false);
    expect(await guard.tripped()).to.equal(false);
  });

  it("window rolls after a day", async () => {
    await relay(await (await wBase.connect(agent).spend(merchant.address, usd(10))).wait(), BASE);
    await time.increase(86400 + 5);
    expect((await guard.status()).spent).to.equal(0n);
    await relay(await (await wBase.connect(agent).spend(merchant.address, usd(3))).wait(), BASE);
    expect(await guard.spentInWindow()).to.equal(usd(3));
  });

  describe("security", () => {
    it("only the system contract can call react()", async () => {
      const rec = { chainId: BASE, contractAddress: wBase.target, topic0: 0, topic1: 0, topic2: 0, topic3: 0, data: "0x", blockNumber: 0, opCode: 0, blockHash: 0, txHash: 0, logIndex: 0 };
      await expect(guard.connect(stranger).react(rec)).to.be.revertedWithCustomError(guard, "NotAuthorized");
    });

    it("random address cannot freeze a wallet", async () => {
      await expect(wBase.connect(stranger).freeze(guard.target, 1, BASE)).to.be.revertedWithCustomError(wBase, "NotCallbackProxy");
    });

    it("proxy callback from a different reactive contract is rejected", async () => {
      await expect(wBase.connect(proxyBase).freeze(stranger.address, 1, BASE)).to.be.revertedWithCustomError(wBase, "CallbackNotAuthorized");
    });

    it("events from unregistered contracts are ignored", async () => {
      const W = await ethers.getContractFactory("AgentWallet");
      const rogue = await W.deploy(proxyBase.address, guard.target, token.target, agent.address, usd(10));
      const r = await (await rogue.connect(agent).spend(attacker.address, usd(1))).wait();
      const cbs = await relay(r, BASE);
      expect(cbs.length).to.equal(0);
      expect(await guard.tripped()).to.equal(false);
    });

    it("only the agent can spend, owner can still withdraw when frozen", async () => {
      await expect(wBase.connect(stranger).spend(merchant.address, 1)).to.be.revertedWithCustomError(wBase, "NotAgent");
      await relay(await (await wUni.connect(agent).spend(attacker.address, usd(5))).wait(), UNI);
      await wBase.withdraw(owner.address, usd(100));
      expect(await token.balanceOf(owner.address)).to.equal(usd(100));
    });
  });
});
