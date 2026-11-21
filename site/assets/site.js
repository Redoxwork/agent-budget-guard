// Shared header/footer + helpers for every page.
const LOGO = `<svg viewBox="0 0 40 40" aria-hidden="true">
  <rect x="2" y="2" width="36" height="36" rx="10" fill="#12122A"/>
  <rect x="13" y="8" width="14" height="24" rx="7" fill="#2A2B4A"/>
  <rect x="14.5" y="18.5" width="11" height="12" rx="5.5" fill="#FF4B2B"/>
  <rect x="17" y="10.5" width="6" height="2.4" rx="1.2" fill="#A9DCFF"/>
  <circle cx="31.5" cy="8.5" r="3.2" fill="#A9DCFF" stroke="#12122A" stroke-width="1.6"/>
</svg>`;

const PAGES = [
  ["index.html", "Home"],
  ["live.html", "Live guard"],
  ["cases.html", "Case files"],
  ["selftest.html", "Self-test"],
  ["how.html", "How it works"],
];

const REPO = "https://github.com/Redoxwork/agent-budget-guard";

function mountChrome() {
  const here = location.pathname.split("/").pop() || "index.html";
  const nav = document.createElement("header");
  nav.className = "nav";
  nav.innerHTML = `<div class="wrap">
    <a class="logo" href="index.html">${LOGO}<span>Budget Guard</span></a>
    <button class="menu-btn" aria-label="Open menu" aria-expanded="false">
      <svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 7h20M3 13h20M3 19h20" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
    </button>
    <ul>${PAGES.map(([h, t]) => `<li><a href="${h}"${h === here ? ' aria-current="page"' : ""}>${t}</a></li>`).join("")}</ul>
  </div>`;
  document.body.prepend(nav);
  const btn = nav.querySelector(".menu-btn");
  btn.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    btn.setAttribute("aria-expanded", open);
  });
  addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });

  const f = document.createElement("footer");
  f.className = "site";
  f.innerHTML = `<div class="wrap">
    <div class="cols">
      <div>
        <a class="logo" href="index.html">${LOGO}<span>Budget Guard</span></a>
        <p>One spending limit for an AI agent across Base and Unichain, enforced by a reactive contract on Reactive Network. Testnet only. Built for the Reactive Omni Buildathon, November 2026.</p>
      </div>
      <ul>${PAGES.map(([h, t]) => `<li><a href="${h}">${t}</a></li>`).join("")}</ul>
      <ul>
        <li><a href="${REPO}">Source on GitHub</a></li>
        <li><a href="https://dev.reactive.network/">Reactive Network docs</a></li>
      </ul>
    </div>
    <div class="base-row"><span>BudgetGuard on Lasna <code>0xA874…94e1</code></span><span>AgentWallet on Base and Unichain <code>0x6A01…1376</code></span></div>
  </div>`;
  document.body.append(f);
}

async function loadJSON(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

const money = (v) => "$" + (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const chainOf = (url = "") => (url.includes("basescan") ? "base" : url.includes("uniscan") ? "unichain" : "lasna");
const CHAIN_NAME = { base: "Base", unichain: "Unichain", lasna: "Lasna" };

mountChrome();
