// The chunked deploy as a resumable state machine, with no DOM access. Same sequence as chunked_deploy.py.
import { callCalldata, concat, deployCalldata, sha256, toHex } from "./codec.js";
import { CHAIN, CONSENSUS_MAIN, EVENT, FEE_TEMPLATE, MAX_TX_GAS, ZERO_ADDRESS, encodeAddTransaction } from "./chain.js";

export const CHUNK_SIZE = 24_000;

const OUTCOME = {
  [EVENT.ACCEPTED]: "Accepted",
  [EVENT.FINALIZED]: "Finalized",
  [EVENT.UNDETERMINED]: "Undetermined",
  [EVENT.LEADER_TIMEOUT]: "LeaderTimeout",
  [EVENT.CANCELLED]: "Cancelled",
};
const BAD_OUTCOME = new Set(["Undetermined", "LeaderTimeout", "Cancelled"]);
const hex = (v) => "0x" + BigInt(v).toString(16);

export class UserFacingError extends Error {}

export function planSteps(codeLength, chunk = CHUNK_SIZE) {
  const steps = [{ id: "loader", kind: "send", label: "Deploy loader contract" }];
  for (let offset = 0; offset < codeLength; offset += chunk) {
    const length = Math.min(chunk, codeLength - offset);
    steps.push({ id: `put:${offset}`, kind: "send", offset, length, label: `Upload bytes ${offset.toLocaleString("en-US")}–${(offset + length).toLocaleString("en-US")}` });
  }
  steps.push({ id: "verify", kind: "check", label: "Read uploaded bytes back and compare SHA-256" });
  steps.push({ id: "activate", kind: "send", label: "Activate code and lock the contract" });
  return steps.map((s) => ({ ...s, state: "todo", txHash: null, txId: null, block: null, outcome: null }));
}

// Refunded once consensus finishes, but uploads overlap, so the wallet has to hold them at once.
export const requiredFloat = (codeLength, chunk = CHUNK_SIZE) =>
  FEE_TEMPLATE.value * BigInt(Math.ceil(codeLength / chunk) + 1) + FEE_TEMPLATE.value / 2n;

export class Deployment {
  constructor({ rpc, wallet, account, code, codeHash, loaderSource, saved = null, persist = () => {}, onChange = () => {}, sleep, pollMs = 4000, patience = 60 * 60 * 1000 }) {
    Object.assign(this, { rpc, wallet, account, code, codeHash, loaderSource, persist, onChange, pollMs, patience });
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.contract = saved?.contract ?? null;
    this.steps = saved?.steps ?? planSteps(code.length);
    this.running = false;
    this.error = null;
    this.done = this.steps.every((s) => s.state === "done");
  }

  snapshot() {
    return { codeHash: this.codeHash, account: this.account, contract: this.contract, steps: this.steps };
  }

  changed() {
    this.persist(this.snapshot());
    this.onChange(this);
  }

  step(id) {
    return this.steps.find((s) => s.id === id);
  }

  async run() {
    if (this.running) return;
    this.running = true;
    this.error = null;
    for (const s of this.steps) {
      if (s.state === "failed") Object.assign(s, { state: "todo", txHash: null, txId: null, block: null, outcome: null });
    }
    this.changed();
    try {
      await this.pipeline();
      this.done = true;
    } catch (e) {
      this.error = e instanceof UserFacingError ? e.message : "Unexpected error: " + (e.message || e);
    } finally {
      this.running = false;
      this.changed();
    }
  }

  async pipeline() {
    const loader = this.step("loader");
    await this.deliver(loader, ZERO_ADDRESS, deployCalldata(this.loaderSource));
    await this.settle(loader, true);
    if (!this.contract) throw new UserFacingError("The loader deployed, but its address could not be found in the receipt.");
    await this.waitForLoader();

    const puts = this.steps.filter((s) => s.id.startsWith("put:"));
    for (const p of puts) {
      if (p.state === "done") continue;
      await this.deliver(p, this.contract, callCalldata("put", [p.offset, this.code.subarray(p.offset, p.offset + p.length)]));
    }
    for (const p of puts) await this.settle(p, false);

    await this.verifyUpload(this.step("verify"));

    const activate = this.step("activate");
    await this.deliver(activate, this.contract, callCalldata("activate", [this.code.length, "slot", true]));
    await this.settle(activate, true);
  }

  async ensureWallet() {
    const chain = await this.wallet.request({ method: "eth_chainId" });
    if (Number(chain) !== CHAIN.id) throw new UserFacingError(`Your wallet is on another network. Switch to ${CHAIN.name}, then press Continue.`);
    const [active] = await this.wallet.request({ method: "eth_accounts" });
    if (!active || active.toLowerCase() !== this.account.toLowerCase()) {
      throw new UserFacingError(`This deployment belongs to ${this.account}. Select that account in your wallet, then press Continue.`);
    }
  }

  // Submits one transaction, unless an earlier attempt already got it mined.
  async deliver(step, recipient, txCalldata) {
    if (step.state === "done" || step.txId) return;
    if (step.txHash) return this.collectReceipt(step); // the page reloaded while this one was being mined
    await this.ensureWallet();
    const latest = await this.rpc.call("eth_getBlockByNumber", ["latest", false]);
    const data = toHex(encodeAddTransaction({
      sender: this.account,
      recipient,
      validUntil: Number(latest.timestamp) + FEE_TEMPLATE.validFor,
      txCalldata,
    }));
    const call = { from: this.account, to: CONSENSUS_MAIN, value: hex(FEE_TEMPLATE.value), data };
    let estimate;
    try {
      estimate = BigInt(await this.rpc.call("eth_estimateGas", [call]));
    } catch (e) {
      throw new UserFacingError(`The network refused this transaction: ${e.message}. Check that the wallet holds enough GEN.`);
    }
    const scaled = (estimate * 12n) / 10n;

    step.state = "sign";
    this.changed();
    let hash;
    try {
      hash = await this.wallet.request({
        method: "eth_sendTransaction",
        params: [{
          ...call,
          gas: hex(scaled < MAX_TX_GAS ? scaled : MAX_TX_GAS),
          maxFeePerGas: hex(BigInt(latest.baseFeePerGas) * 3n),
          maxPriorityFeePerGas: "0x0",
          type: "0x2",
        }],
      });
    } catch (e) {
      step.state = "todo";
      if (e.code === 4001) throw new UserFacingError("You rejected the signature. Press Continue to send it again.");
      throw new UserFacingError("The wallet could not send this transaction: " + (e.message || e));
    }

    step.state = "mining";
    step.txHash = hash;
    this.changed();
    await this.collectReceipt(step);
  }

  async collectReceipt(step) {
    let receipt = null;
    for (let i = 0; i < 180 && !receipt; i++) {
      receipt = await this.rpc.call("eth_getTransactionReceipt", [step.txHash]);
      if (!receipt) await this.sleep(1000);
    }
    if (!receipt) {
      step.state = "failed";
      throw new UserFacingError("The transaction was not mined in 3 minutes. Press Continue to send it again.");
    }
    if (receipt.status !== "0x1") {
      step.state = "failed";
      throw new UserFacingError("The transaction reverted. Press Continue to send it again.");
    }
    const created = receipt.logs.find((l) => l.topics[0] === EVENT.CREATED);
    const announced = receipt.logs.find((l) => l.topics[0] === EVENT.NEW && (!created || l.topics[1] === created.topics[1]));
    step.txId = (created ?? announced)?.topics[1] ?? null;
    if (!step.txId) {
      step.state = "failed";
      throw new UserFacingError("The receipt has no GenLayer transaction id.");
    }
    if (step.id === "loader") {
      if (!announced) {
        step.state = "failed";
        throw new UserFacingError("The loader was queued unexpectedly, so its address is unknown. Press Continue to send it again.");
      }
      this.contract = "0x" + announced.topics[2].slice(26);
    }
    step.block = Number(receipt.blockNumber);
    step.state = "consensus";
    this.changed();
  }

  // Waits for validators. Uploads only need Accepted; the loader and activation wait for Finalized.
  async settle(step, needFinal) {
    if (step.state === "done") return;
    const deadline = Date.now() + this.patience;
    while (Date.now() < deadline) {
      const logs = await this.rpc.logsForTransaction(step.txId, step.block);
      const names = logs.map((l) => OUTCOME[l.topics[0]]).filter(Boolean);
      const bad = names.find((n) => BAD_OUTCOME.has(n));
      if (bad) {
        step.state = "failed";
        step.outcome = bad;
        throw new UserFacingError(`Validators ended this transaction with ${bad}. Press Continue to send it again.`);
      }
      const final = names.includes("Finalized");
      const accepted = final || names.includes("Accepted");
      if (accepted && step.state !== "accepted") {
        step.state = "accepted";
        step.outcome = final ? "Finalized" : "Accepted";
        this.changed();
      }
      if (final || (accepted && !needFinal)) {
        step.state = "done";
        step.outcome = final ? "Finalized" : "Accepted";
        this.changed();
        return;
      }
      await this.sleep(this.pollMs);
    }
    throw new UserFacingError("Validators have not finished yet. Press Continue to keep waiting.");
  }

  async waitForLoader() {
    for (let i = 0; i < 15; i++) {
      try {
        if ((await this.rpc.genRead(this.account, this.contract, "staged_len")) !== null) return;
      } catch { /* the node may need a moment to serve a fresh contract */ }
      await this.sleep(this.pollMs);
    }
    throw new UserFacingError("The loader is finalized but cannot be read. Press Continue to check again.");
  }

  async verifyUpload(step) {
    if (step.state === "done") return;
    step.state = "mining";
    this.changed();
    let length = -1;
    for (let i = 0; i < 20 && length !== this.code.length; i++) {
      length = await this.rpc.genRead(this.account, this.contract, "staged_len");
      if (length !== this.code.length) await this.sleep(this.pollMs);
    }
    if (length !== this.code.length) {
      step.state = "failed";
      throw new UserFacingError(`The contract holds ${length} bytes, expected ${this.code.length}. Press Continue to check again.`);
    }
    const parts = [];
    for (let o = 0; o < length; o += CHUNK_SIZE) {
      parts.push(await this.rpc.genRead(this.account, this.contract, "staged", [o, Math.min(CHUNK_SIZE, length - o)]));
    }
    if ((await sha256(concat(parts))) !== this.codeHash) {
      step.state = "failed";
      throw new UserFacingError("The uploaded bytes do not match your file, so the contract was not activated. Start a new deployment.");
    }
    step.state = "done";
    step.outcome = "Verified";
    this.changed();
  }
}
