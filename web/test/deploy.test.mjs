import assert from "node:assert/strict";
import test from "node:test";
import { cdDecode, cdEncode, fromHex, rlpDecode, sha256, toHex } from "../codec.js";
import { EVENT, Rpc } from "../chain.js";
import { CHUNK_SIZE, Deployment, planSteps } from "../deploy.js";

const ACCOUNT = "0x70b4941eb04d153d87bb29bb8a5884af77d3401b";
const CONTRACT = "0x" + "c1".repeat(20);
const code = new Uint8Array(CHUNK_SIZE * 2 + 500).map((_, i) => i % 251);
code.set([0, 0x61, 0x73, 0x6d]);

// A chain with a real JSON-RPC surface, driven through the real Rpc class and wallet interface.
function fakeChain({ reject = new Set(), outcome = () => EVENT.FINALIZED, corrupt = false, chainId = "0x107d" } = {}) {
  const chain = { sent: [], staged: new Uint8Array(0), attempts: 0, chainId, account: ACCOUNT };
  const receipts = new Map();
  const logs = new Map();

  const applyCall = (input) => {
    // addTransaction's txCalldata is the last dynamic field; find its RLP via the known ABI layout.
    const bytes = fromHex(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const tupleAt = 4 + Number(view.getUint32(4 + 28));
    const cdAt = tupleAt + Number(view.getUint32(tupleAt + 8 * 32 + 28));
    const len = Number(view.getUint32(cdAt + 28));
    const list = rlpDecode(bytes.slice(cdAt + 32, cdAt + 32 + len));
    if (list.length === 3) return { method: "deploy" };
    const call = cdDecode(list[0]);
    return { method: call[""], args: call.args };
  };

  const wallet = {
    async request({ method, params }) {
      if (method === "eth_chainId") return chain.chainId;
      if (method === "eth_accounts") return [chain.account];
      if (method !== "eth_sendTransaction") throw new Error("unexpected wallet call " + method);
      const n = chain.attempts++;
      if (reject.has(n)) throw Object.assign(new Error("rejected"), { code: 4001 });
      const call = applyCall(params[0].data);
      assert.equal(params[0].from, ACCOUNT);
      assert.ok(BigInt(params[0].gas) <= 32_000_000n);
      const hash = "0x" + n.toString(16).padStart(64, "0");
      const txId = "0x" + (n + 1).toString(16).padStart(64, "a");
      chain.sent.push(call);
      if (call.method === "put") {
        const [offset, piece] = call.args;
        const data = piece.slice();
        if (corrupt && offset === 0) data[10] ^= 1;
        const grown = new Uint8Array(Math.max(chain.staged.length, offset + data.length));
        grown.set(chain.staged);
        grown.set(data, offset);
        chain.staged = grown;
      }
      const topicRecipient = "0x" + "00".repeat(12) + CONTRACT.slice(2);
      receipts.set(hash, {
        status: "0x1",
        blockNumber: "0x10",
        logs: [{ topics: [EVENT.CREATED, txId] }, { topics: [EVENT.NEW, txId, topicRecipient] }],
      });
      logs.set(txId, [{ topics: [EVENT.ACCEPTED, txId] }, { topics: [outcome(call, n), txId] }]);
      return hash;
    },
  };

  const rpcFetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    const result = (() => {
      switch (method) {
        case "eth_getBlockByNumber": return { timestamp: "0x6000", baseFeePerGas: "0x10" };
        case "eth_estimateGas": return "0x100000";
        case "eth_getTransactionReceipt": return receipts.get(params[0]) ?? null;
        case "eth_getLogs": return logs.get(params[0].topics[1]) ?? [];
        case "gen_call": {
          const call = cdDecode(rlpDecode(fromHex(params[0].data))[0]);
          if (call[""] === "staged_len") return { data: toHex(cdEncode(chain.staged.length)), status: { code: 0 } };
          const [o, n] = call.args;
          return { data: toHex(cdEncode(chain.staged.slice(o, o + n))), status: { code: 0 } };
        }
        default: throw new Error("unexpected rpc " + method);
      }
    })();
    return { status: 200, json: async () => ({ jsonrpc: "2.0", id, result }) };
  };

  return { chain, wallet, rpc: new Rpc("http://fake", rpcFetch) };
}

async function makeDeployment(env, extra = {}) {
  return new Deployment({
    rpc: env.rpc, wallet: env.wallet, account: ACCOUNT, code, codeHash: await sha256(code),
    loaderSource: Uint8Array.of(35, 10), sleep: async () => {}, pollMs: 0, ...extra,
  });
}

test("plan covers the file exactly", () => {
  const steps = planSteps(code.length);
  assert.deepEqual(steps.map((s) => s.id), ["loader", "put:0", `put:${CHUNK_SIZE}`, `put:${CHUNK_SIZE * 2}`, "verify", "activate"]);
  assert.equal(steps.filter((s) => s.offset !== undefined).reduce((n, s) => n + s.length, 0), code.length);
});

test("runs loader, uploads, read-back and activation in order", async () => {
  const env = fakeChain();
  const d = await makeDeployment(env);
  await d.run();
  assert.equal(d.error, null);
  assert.equal(d.done, true);
  assert.equal(d.contract, CONTRACT);
  assert.deepEqual(env.chain.sent.map((c) => c.method), ["deploy", "put", "put", "put", "activate"]);
  assert.deepEqual(env.chain.sent.at(-1).args, [code.length, "slot", true]);
  assert.deepEqual(env.chain.staged, code);
});

test("a rejected signature pauses, and Continue resumes without repeating sent uploads", async () => {
  const env = fakeChain({ reject: new Set([2]) });
  const d = await makeDeployment(env);
  await d.run();
  assert.match(d.error, /rejected/);
  assert.equal(d.done, false);
  assert.equal(env.chain.sent.length, 2);
  await d.run();
  assert.equal(d.error, null);
  assert.equal(d.done, true);
  assert.deepEqual(env.chain.sent.map((c) => c.args?.[0] ?? c.method), ["deploy", 0, CHUNK_SIZE, CHUNK_SIZE * 2, code.length]);
});

test("does not activate when the uploaded bytes differ from the file", async () => {
  const env = fakeChain({ corrupt: true });
  const d = await makeDeployment(env);
  await d.run();
  assert.match(d.error, /do not match/);
  assert.equal(d.done, false);
  assert.ok(!env.chain.sent.some((c) => c.method === "activate"));
});

test("a failed consensus outcome is resent on Continue", async () => {
  let failOnce = true;
  const env = fakeChain({
    outcome: (call) => {
      if (call.method === "put" && failOnce) { failOnce = false; return EVENT.UNDETERMINED; }
      return EVENT.FINALIZED;
    },
  });
  const d = await makeDeployment(env);
  await d.run();
  assert.match(d.error, /Undetermined/);
  await d.run();
  assert.equal(d.error, null);
  assert.equal(d.done, true);
  assert.equal(env.chain.sent.filter((c) => c.method === "put").length, 4);
});

test("resumes from a saved snapshot after a reload", async () => {
  const env = fakeChain({ reject: new Set([3]) });
  let snapshot;
  const first = await makeDeployment(env, { persist: (s) => { snapshot = JSON.parse(JSON.stringify(s)); } });
  await first.run();
  assert.equal(env.chain.sent.length, 3);
  const second = await makeDeployment(env, { saved: snapshot });
  await second.run();
  assert.equal(second.error, null);
  assert.equal(second.done, true);
  assert.equal(env.chain.sent.length, 5);
});

test("refuses to send from the wrong network or account", async () => {
  const wrongChain = fakeChain({ chainId: "0x1" });
  const a = await makeDeployment(wrongChain);
  await a.run();
  assert.match(a.error, /another network/);
  assert.equal(wrongChain.chain.sent.length, 0);

  const wrongAccount = fakeChain();
  wrongAccount.chain.account = "0x" + "99".repeat(20);
  const b = await makeDeployment(wrongAccount);
  await b.run();
  assert.match(b.error, /Select that account/);
  assert.equal(wrongAccount.chain.sent.length, 0);
});
