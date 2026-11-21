// Plain-English policy -> on-chain rules.
//   node agent/policy.js "Max $50 a day, nothing over $10 at once, only pay weather-api and market-data"
//   node agent/policy.js "..." --apply
//
// The AI only PROPOSES rules. Code validates them against hard bounds, shows the diff,
// and only --apply writes them on-chain. Reactive + the wallets then enforce them;
// the agent can't talk its way past them.
const { D, usd, guard, wallet, ownerSigner, lasnaFees, status } = require("./chain");
const { chat, hasLLM, MODEL } = require("./llm");

const HARD = { maxDaily: 1000, maxPerTx: 250 };
const KNOWN = Object.keys(D.merchants || {});

const SYSTEM = `You turn a user's plain-English spending rules for their AI agent into JSON.
Known payees (use these exact ids): ${KNOWN.join(", ")}.
Return ONLY a JSON object:
{"dailyLimitUsd": number, "perTxCapUsd": number, "allow": [payee ids], "notes": "one short sentence"}
- dailyLimitUsd: total the agent may spend per day across ALL chains.
- perTxCapUsd: max for a single payment. If not stated, use min(dailyLimitUsd/5, 10).
- allow: only payees the user allows. "only X and Y" means exactly those. If the user says nothing about payees, allow all known payees.
- Never invent payees. Never add addresses.`;

async function compile(text) {
  if (hasLLM()) {
    const r = await chat({ system: SYSTEM, messages: [{ role: "user", content: text }], json: true });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("model returned no JSON: " + r.text);
    return { source: `LLM (${MODEL})`, policy: JSON.parse(m[0]) };
  }
  return { source: "offline parser (no LLM key set)", policy: offlineParse(text) };
}

// Fallback so the tool still works without an API key.
function offlineParse(text) {
  const t = text.toLowerCase();
  const nums = [...t.matchAll(/\$?\s?(\d+(?:\.\d+)?)\s*(?:usd|dollars?|\$)?\s*(a day|per day|\/day|daily|a week|at once|per (?:payment|tx|transaction)|each|single)?/g)];
  let daily, cap;
  for (const n of nums) {
    const v = Number(n[1]);
    if (/day|daily/.test(n[2] || "")) daily = v;
    else if (/once|payment|tx|transaction|each|single/.test(n[2] || "")) cap = v;
  }
  if (daily === undefined && nums[0]) daily = Number(nums[0][1]);
  const named = KNOWN.filter((k) => t.includes(k) || t.includes(k.replace("-", " ")) || t.includes(k.split("-")[0]));
  const only = /\bonly\b/.test(t);
  return {
    dailyLimitUsd: daily ?? 50,
    perTxCapUsd: cap ?? Math.min((daily ?? 50) / 5, 10),
    allow: only && named.length ? named : named.length ? named : KNOWN,
    notes: "parsed offline",
  };
}

function validate(p) {
  const errs = [];
  if (!(p.dailyLimitUsd > 0 && p.dailyLimitUsd <= HARD.maxDaily)) errs.push(`dailyLimitUsd must be 0–${HARD.maxDaily}`);
  if (!(p.perTxCapUsd > 0 && p.perTxCapUsd <= HARD.maxPerTx)) errs.push(`perTxCapUsd must be 0–${HARD.maxPerTx}`);
  if (p.perTxCapUsd > p.dailyLimitUsd) errs.push("perTxCapUsd can't exceed dailyLimitUsd");
  if (!Array.isArray(p.allow)) errs.push("allow must be a list");
  else for (const a of p.allow) if (!KNOWN.includes(a)) errs.push(`unknown payee "${a}" (rejected — AI can't add addresses)`);
  return errs;
}

async function apply(p) {
  const fees = await lasnaFees();
  const g = guard(ownerSigner("lasna"));
  const out = [];
  const tx = await g.setDailyLimit(usd(p.dailyLimitUsd), { gasLimit: 100000, ...fees });
  await tx.wait();
  out.push(`lasna setDailyLimit $${p.dailyLimitUsd}: ${tx.hash}`);
  for (const c of ["base", "unichain"]) {
    const w = wallet(c, ownerSigner(c));
    const t1 = await w.setPerTxCap(usd(p.perTxCapUsd), { gasLimit: 80000 });
    await t1.wait();
    out.push(`${c} setPerTxCap $${p.perTxCapUsd}: ${t1.hash}`);
    for (const id of KNOWN) {
      const want = p.allow.includes(id);
      const addr = D.merchants[id];
      if ((await w.allowed(addr)) === want) continue;
      const t2 = await w.setRecipient(addr, want, id, { gasLimit: 120000 });
      await t2.wait();
      out.push(`${c} ${want ? "allow" : "remove"} ${id}: ${t2.hash}`);
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const doApply = args.includes("--apply");
  const text = args.filter((a) => a !== "--apply").join(" ");
  if (!text) return console.log('usage: node agent/policy.js "Max $50 a day, nothing over $10 at once" [--apply]');

  const { source, policy } = await compile(text);
  console.log(`\nYou said: "${text}"\nCompiled by: ${source}\n`);
  console.log(JSON.stringify(policy, null, 2));
  const errs = validate(policy);
  if (errs.length) {
    console.log("\nREJECTED:\n- " + errs.join("\n- "));
    process.exit(2);
  }
  console.log("\nValid. Enforced as:");
  console.log(`  • Reactive BudgetGuard (Lasna): $${policy.dailyLimitUsd}/day combined across Base + Unichain`);
  console.log(`  • Each AgentWallet: max $${policy.perTxCapUsd} per payment`);
  console.log(`  • Allowed payees: ${policy.allow.join(", ")} — anything else = attack → freeze all chains`);
  if (!doApply) return console.log("\nDry run. Add --apply to write it on-chain.");
  console.log("\nApplying…");
  for (const l of await apply(policy)) console.log("  " + l);
  console.log("\nNow:", JSON.stringify(await status()));
}

if (require.main === module) main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
module.exports = { compile, validate, apply };
