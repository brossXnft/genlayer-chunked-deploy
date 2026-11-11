import { sha256 } from "./codec.js";
import { CHAIN, Rpc, STATUS_NAME, addressUrl, isAddress, isSha256, txUrl } from "./chain.js";
import { CHUNK_SIZE, Deployment, planSteps, requiredFloat } from "./deploy.js";
import { verifyContract } from "./verify.js";

const $ = (id) => document.getElementById(id);
const rpc = new Rpc();

// All chain-derived values go through textContent, never innerHTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener" }, text);
const short = (s) => `${s.slice(0, 10)}…${s.slice(-6)}`;
const num = (n) => n.toLocaleString("en-US");
const gen = (wei) => (Number(wei / 10n ** 14n) / 1e4).toFixed(4) + " GEN";

function setStatus(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle("error", isError);
}

// ---------------- tabs ----------------

function showTab(name) {
  for (const n of ["verify", "deploy"]) {
    $(`tab-${n}`).setAttribute("aria-selected", String(n === name));
    $(`panel-${n}`).hidden = n !== name;
  }
}
$("tab-verify").onclick = () => showTab("verify");
$("tab-deploy").onclick = () => showTab("deploy");

// ---------------- report ----------------

const MARK = { pass: "✓", warn: "!", fail: "✕" };

function describeRow(r) {
  if (r.method === "deploy") return "Deploy loader";
  if (r.method === "put") return `Upload at ${num(r.args[0])} (${num(r.args[1].length)} B)`;
  if (r.method === "activate") return `Activate (lock: ${r.args[2]})`;
  return r.method;
}

function renderReport(target, report) {
  target.replaceChildren();
  if (!report.found) {
    target.append(el("div", { class: "verdict bad" }, el("h2", {}, "No contract found"), el("p", {}, "Nothing is stored at this address on Bradbury.")));
    return;
  }
  target.append(el("div", { class: `verdict ${report.verdict.level}` }, el("h2", {}, report.verdict.title), el("p", {}, report.verdict.text)));

  const facts = el("dl", { class: "facts" });
  const fact = (label, value) => facts.append(el("dt", {}, label), el("dd", {}, value));
  fact("Contract", link(addressUrl(report.address), report.address));
  fact("Deployed", report.chunked ? "In pieces, through a loader" : "In one transaction");
  fact("Code size", `${num(report.size)} bytes`);
  fact("SHA-256 of running code", el("code", {}, report.sha256));
  if (report.deployer) fact("Deployer", link(addressUrl(report.deployer), report.deployer));
  if (report.chunked && report.exposedIsDifferent) fact("Explorers show", "The loader only. They cannot display this code.");
  if (report.loaderIsCurrent !== null) fact("Loader version", report.loaderIsCurrent ? "Current" : "Older than the current loader");
  const shareUrl = new URL(location.pathname, location.origin);
  shareUrl.searchParams.set("address", report.address);
  shareUrl.searchParams.set("sha256", report.sha256);
  fact("Link to this check", link(shareUrl.href, "Open"));
  target.append(el("div", { class: "card" }, el("h2", {}, "What the chain runs"), facts));

  const checks = el("ul", { class: "checks" });
  for (const c of report.checks) {
    checks.append(el("li", {},
      el("span", { class: `mark ${c.state}`, ariaLabel: c.state }, MARK[c.state]),
      el("strong", {}, c.label),
      el("p", {}, c.detail)));
  }
  target.append(el("div", { class: "card" }, el("h2", {}, "Checks"), checks));

  if (report.rows.length) {
    const body = el("tbody");
    for (const r of report.rows) {
      body.append(el("tr", {},
        el("td", {}, describeRow(r)),
        el("td", {}, r.voters ? `${r.agree}/${r.voters} agree` : "–"),
        el("td", {}, STATUS_NAME[r.status] ?? String(r.status)),
        el("td", {}, link(txUrl(r.txId), short(r.txId)))));
    }
    const head = el("thead", {}, el("tr", {}, ...["Action", "Validators", "Status", "Transaction"].map((h) => el("th", { scope: "col" }, h))));
    const later = report.laterTransactions ? el("p", { class: "status" }, `${num(report.laterTransactions)} later transactions are not listed.`) : null;
    target.append(el("div", { class: "card" }, el("h2", {}, "Upload history"), el("div", { class: "table-wrap" }, el("table", {}, head, body)), later));
  }
}

// ---------------- verify ----------------

const EXAMPLE = {
  address: "0xe71eaad15ca916a616cbe0e5443452b8d4f2022e",
  sha256: "c7c7f51b6d540dad640ef3533ec6ce8bec3d83f6479e78858334df3a01ea0012",
};

async function currentLoaderHash() {
  const response = await fetch("code_loader.py");
  return sha256(new Uint8Array(await response.arrayBuffer()));
}

async function runVerify() {
  const address = $("verify-address").value.trim();
  const expected = $("verify-hash").value.trim().replace(/^0x/, "").toLowerCase();
  const status = $("verify-status");
  if (!isAddress(address)) return setStatus(status, "Enter a 42-character address that starts with 0x.", true);
  if (expected && !isSha256(expected)) return setStatus(status, "A SHA-256 hash has 64 hexadecimal characters.", true);
  $("verify-go").disabled = true;
  $("verify-report").replaceChildren();
  setStatus(status, "Reading contract storage…");
  try {
    const report = await verifyContract(rpc, address, {
      expected: expected || null,
      currentLoader: await currentLoaderHash().catch(() => null),
      onProgress: (done, total) => setStatus(status, `Reading upload history: ${done} of ${total}…`),
    });
    setStatus(status, "");
    renderReport($("verify-report"), report);
  } catch (e) {
    setStatus(status, `Could not finish the check: ${e.message}. Try again.`, true);
  } finally {
    $("verify-go").disabled = false;
  }
}

$("verify-form").onsubmit = (e) => { e.preventDefault(); runVerify(); };
$("verify-example").onclick = () => {
  $("verify-address").value = EXAMPLE.address;
  $("verify-hash").value = EXAMPLE.sha256;
  runVerify();
};
$("verify-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (file) $("verify-hash").value = await sha256(new Uint8Array(await file.arrayBuffer()));
};

// ---------------- wallet ----------------

const wallets = new Map();
let wallet = null;
let account = null;

window.addEventListener("eip6963:announceProvider", (e) => {
  wallets.set(e.detail.info.uuid, e.detail);
  const pick = $("wallet-pick");
  pick.replaceChildren(...[...wallets].map(([id, w]) => el("option", { value: id }, w.info.name)));
  pick.hidden = wallets.size < 2;
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

async function switchChain(provider) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.idHex }] });
  } catch (e) {
    if (e.code !== 4902 && e.data?.originalError?.code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CHAIN.idHex,
        chainName: CHAIN.name,
        nativeCurrency: { name: "GEN", symbol: CHAIN.symbol, decimals: 18 },
        rpcUrls: [CHAIN.walletRpc],
        blockExplorerUrls: [CHAIN.explorer],
      }],
    });
  }
}

async function refreshBalance() {
  if (!account) return;
  const status = $("wallet-status");
  try {
    const balance = BigInt(await rpc.call("eth_getBalance", [account, "latest"]));
    setStatus(status, `${short(account)} on ${CHAIN.name}, balance ${gen(balance)}.`);
    return balance;
  } catch {
    setStatus(status, `${short(account)} connected. Could not read its balance.`);
  }
}

$("wallet-connect").onclick = async () => {
  const status = $("wallet-status");
  const chosen = wallets.get($("wallet-pick").value)?.provider ?? [...wallets.values()][0]?.provider ?? window.ethereum;
  if (!chosen) return setStatus(status, "No browser wallet found. Install one, such as MetaMask, then reload.", true);
  try {
    const [first] = await chosen.request({ method: "eth_requestAccounts" });
    await switchChain(chosen);
    wallet = chosen;
    account = first;
    wallet.on?.("accountsChanged", (a) => { account = a[0] ?? null; refreshBalance(); updateDeployState(); });
    await refreshBalance();
    updateDeployState();
  } catch (e) {
    setStatus(status, e.code === 4001 ? "Connection rejected in the wallet." : `Could not connect: ${e.message}`, true);
  }
};

// ---------------- deploy ----------------

let file = null; // { bytes, hash, name }
let deployment = null;

const storageKey = () => `chunked-deploy:${file.hash}:${account.toLowerCase()}`;

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(storageKey())); } catch { return null; }
}
function saveDeployment(snapshot) {
  try { localStorage.setItem(storageKey(), JSON.stringify(snapshot)); } catch { /* resuming is a convenience */ }
}
function clearSaved() {
  try { localStorage.removeItem(storageKey()); } catch { /* nothing to clear */ }
}

const STATE_TEXT = {
  todo: "Waiting",
  sign: "Confirm in wallet",
  mining: "In progress",
  consensus: "Validators voting",
  accepted: "Accepted, finalizing",
  failed: "Failed",
};
const dotClass = (s) => (s === "done" ? "done" : s === "failed" ? "failed" : s === "todo" ? "" : "active");

function renderSteps(steps) {
  $("deploy-steps").replaceChildren(...steps.map((s) => el("li", {},
    el("span", { class: `dot ${dotClass(s.state)}` }),
    el("span", {}, s.label),
    el("span", { class: "step-state" },
      s.state === "done" ? s.outcome : STATE_TEXT[s.state],
      s.txId ? " · " : null,
      s.txId ? link(txUrl(s.txId), "view") : null))));
}

function updateDeployState() {
  const go = $("deploy-go");
  if (!file) { go.disabled = true; return; }
  const saved = account ? loadSaved() : null;
  if (!deployment) renderSteps(saved?.steps ?? planSteps(file.bytes.length));
  const started = deployment?.steps.some((s) => s.state !== "todo") || saved?.steps.some((s) => s.state !== "todo");
  go.textContent = deployment?.done ? "Deployed" : started ? "Continue" : "Start deployment";
  go.disabled = !account || Boolean(deployment?.running) || Boolean(deployment?.done);
  $("deploy-reset").hidden = !started || Boolean(deployment?.running);
  if (!account) setStatus($("deploy-status"), "Connect a wallet to continue.");
}

function onDeploymentChange(d) {
  renderSteps(d.steps);
  updateDeployState();
  const status = $("deploy-status");
  if (d.error) setStatus(status, d.error, true);
  else if (d.running) setStatus(status, d.contract ? `Contract address: ${d.contract}` : "Keep this page open until the deployment finishes.");
}

async function finishDeployment(d) {
  setStatus($("deploy-status"), `Deployed at ${d.contract}. Checking the result on chain…`);
  try {
    const report = await verifyContract(rpc, d.contract, { expected: d.codeHash, currentLoader: await currentLoaderHash().catch(() => null) });
    renderReport($("deploy-report"), report);
    setStatus($("deploy-status"), `Deployed at ${d.contract}.`);
  } catch (e) {
    setStatus($("deploy-status"), `Deployed at ${d.contract}, but the follow-up check failed: ${e.message}`, true);
  }
}

$("deploy-file").onchange = async (e) => {
  const status = $("deploy-file-status");
  const picked = e.target.files[0];
  deployment = null;
  file = null;
  $("deploy-plan").hidden = true;
  $("deploy-report").replaceChildren();
  $("deploy-steps").replaceChildren();
  setStatus(status, "");
  setStatus($("deploy-status"), "");
  if (!picked) return updateDeployState();
  const bytes = new Uint8Array(await picked.arrayBuffer());
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    setStatus(status, "This file is not WebAssembly. Choose a compiled .wasm contract.", true);
    return updateDeployState();
  }
  file = { bytes, hash: await sha256(bytes), name: picked.name };
  const pieces = Math.ceil(bytes.length / CHUNK_SIZE);
  const plan = $("deploy-plan");
  plan.replaceChildren(
    el("dt", {}, "Size"), el("dd", {}, `${num(bytes.length)} bytes`),
    el("dt", {}, "SHA-256"), el("dd", {}, el("code", {}, file.hash)),
    el("dt", {}, "Transactions"), el("dd", {}, `${pieces + 2}: loader, ${pieces} upload${pieces > 1 ? "s" : ""}, activation`),
    el("dt", {}, "Wallet must hold"), el("dd", {}, `About ${gen(requiredFloat(bytes.length))}. Most of it is refunded.`),
  );
  plan.hidden = false;
  updateDeployState();
};

$("deploy-go").onclick = async () => {
  if (!file || !account || !wallet) return;
  const status = $("deploy-status");
  if (!deployment) {
    const balance = await refreshBalance();
    const saved = loadSaved();
    if (!saved && balance !== undefined && balance < requiredFloat(file.bytes.length)) {
      return setStatus(status, `This wallet holds ${gen(balance)}. It needs about ${gen(requiredFloat(file.bytes.length))} while the upload runs.`, true);
    }
    const response = await fetch("code_loader.py");
    if (!response.ok) return setStatus(status, "Could not load the loader contract source.", true);
    deployment = new Deployment({
      rpc, wallet, account,
      code: file.bytes,
      codeHash: file.hash,
      loaderSource: new Uint8Array(await response.arrayBuffer()),
      saved,
      persist: saveDeployment,
      onChange: onDeploymentChange,
    });
  }
  const d = deployment;
  await d.run();
  if (d.done && !d.error) {
    await finishDeployment(d);
  }
};

$("deploy-reset").onclick = () => {
  if (file && account) clearSaved();
  deployment = null;
  $("deploy-report").replaceChildren();
  setStatus($("deploy-status"), "");
  updateDeployState();
};

// ---------------- deep link ----------------

const params = new URLSearchParams(location.search);
if (params.get("address")) {
  $("verify-address").value = params.get("address");
  $("verify-hash").value = params.get("sha256") ?? "";
  runVerify();
}
