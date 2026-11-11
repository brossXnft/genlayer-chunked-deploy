// Bradbury Phase 2 constants and read access. Mirrors gl_tx.py.
import { callCalldata, cdDecode, decodeAbi, encodeAbi, fromBase64, fromHex, fromUtf8, parseAbiType, toHex } from "./codec.js";

export const CHAIN = {
  id: 4221,
  idHex: "0x107d",
  name: "GenLayer Bradbury",
  symbol: "GEN",
  rpc: "https://rpc-bradbury.genlayer.com",
  walletRpc: "https://rpc-genlayer-chain-testnet-cfn8m3xc6l.t.conduit.xyz",
  explorer: "https://scan.bradbury.genlayer.com",
};

export const CONSENSUS_MAIN = "0x2E2766cbc3E5e61Ce93bBcdCBb3eAcB82082A019";
export const CONSENSUS_DATA = "0xc5FA6f82BEe53598825d6edf7E3e24613082c75B";
export const ZERO_ADDRESS = "0x" + "00".repeat(20);
export const MAX_TX_GAS = 32_000_000n;

// Same template as CALL_T in gl_tx.py. `value` must match the fees exactly; most of it is refunded.
export const FEE_TEMPLATE = {
  validators: 5,
  maxRotations: 3,
  validFor: 3600,
  value: 100_000_000_000_010_352n,
  fees: [100, 200, 0, 25_000_000_000_000_000n, 0, 0, [3], 2, 300_000_000, 300_000_000],
};

export const EVENT = {
  CREATED: "0x8620e7f03a280a3d2aa84bd41ba19524c2d7f1dbfa9d79cb81877b0f8c963f9b",
  NEW: "0xdab9102861c7483a187584d6371d88316f005af507982ccf95c110879f3ed5a5",
  ACCEPTED: "0xf250caa116f9eac0e4e82d403f131ce0a520b6c232dbcbe270b3729b0aaca09e",
  FINALIZED: "0x24196ec40f90671b7144e716978686b4f3c7d6b00b23da3971ef2b52af27d87f",
  UNDETERMINED: "0xb9f69df2250e1788b862d0715b1dad98b2a50311c017ebb71f6cd83de656b06d",
  LEADER_TIMEOUT: "0xe51a41760ba25c8a4ac33894d5eb8698cf110a90d4e6f764fa0579ec8767b466",
  CANCELLED: "0x0a94f6cf3e473cb72e765b24d1365bfcbef8d31a73215bb27e50df39757f578a",
};

export const STATUS_NAME = [
  "Uninitialized", "Pending", "Proposing", "Committing", "Revealing", "Accepted", "Undetermined",
  "Finalized", "Canceled", "AppealRevealing", "AppealCommitting", "ValidatorsTimeout", "LeaderTimeout",
];
export const FINALIZED = 7;
export const ACCEPTED = 5;
export const EXEC_RETURN = 1; // txExecutionResult: the leader's execution returned without error

const ADD_TX_SELECTOR = fromHex("0x35a251fb");
// The outer parentheses are the argument list: addTransaction takes one tuple.
const ADD_TX_ARGS = parseAbiType(
  "((address,address,uint256,uint256,uint256,uint256,uint256," +
    "(uint256,uint256,uint256,uint256,uint256,uint256,uint256[],uint256,uint256,uint256)," +
    "bytes,(uint8,bool,uint256,address,bytes32,uint256,bytes)[]))",
);

export function encodeAddTransaction({ sender, recipient, validUntil, txCalldata, template = FEE_TEMPLATE }) {
  const body = encodeAbi(ADD_TX_ARGS, [[
    sender, recipient, template.validators, template.maxRotations, validUntil, 0, 0, template.fees, txCalldata, [],
  ]]);
  const out = new Uint8Array(4 + body.length);
  out.set(ADD_TX_SELECTOR);
  out.set(body, 4);
  return out;
}

const ALL_DATA_SELECTOR = "3b01d02b";
const ALL_DATA_TYPE = parseAbiType(
  "((uint8,uint8,uint8,address,address,address,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32,bytes32," +
    "bytes,bytes,(uint256,uint256,uint256)[],uint256,uint256,uint256,uint256,uint256,address,uint8)," +
    "(uint256,uint256,uint256,uint256,uint256,uint256,uint8,address[],uint8[],bytes32[],bytes32[])[])",
);

export function decodeTransactionData(hex) {
  const [tx, rounds] = decodeAbi(ALL_DATA_TYPE, fromHex(hex));
  return {
    result: tx[0],
    execution: tx[1],
    status: tx[2],
    sender: tx[4],
    recipient: tx[5],
    slot: Number(tx[7]),
    id: tx[11],
    calldata: tx[15],
    rounds: rounds.map((r) => ({ result: r[6], validators: r[7], votes: r[8] })),
  };
}

export class RpcError extends Error {
  constructor(method, message, code) {
    super(message);
    this.name = "RpcError";
    this.method = method;
    this.code = code;
  }
}

export class Rpc {
  constructor(url = CHAIN.rpc, fetchFn = (...a) => globalThis.fetch(...a)) {
    this.url = url;
    this.fetch = fetchFn;
    this.id = 0;
  }

  async call(method, params = []) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
      let response;
      try {
        response = await this.fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        });
      } catch (e) {
        lastError = new RpcError(method, "Network error talking to " + this.url);
        continue;
      }
      if (response.status >= 500 || response.status === 429) {
        lastError = new RpcError(method, `RPC answered HTTP ${response.status}`);
        continue;
      }
      const body = await response.json();
      if (body.error) throw new RpcError(method, body.error.message || "RPC error", body.error.code);
      return body.result;
    }
    throw lastError;
  }

  async genRead(from, to, method, args = []) {
    const data = toHex(callCalldata(method, args));
    let r = await this.call("gen_call", [{ type: "read", to, from, data, transaction_hash_variant: "latest-nonfinal" }]);
    if (r && typeof r === "object") {
      if (r.status && r.status.code) throw new RpcError("gen_call", r.stderr || r.status.message || "read failed");
      r = r.data || "";
    }
    return r ? cdDecode(fromHex(r)) : null;
  }

  async storage(address) {
    const hex = await this.call("gen_getContractState", [{ address }]);
    const state = new Map();
    for (const [k, v] of Object.entries(JSON.parse(fromUtf8(fromHex(hex))))) state.set(toHex(fromBase64(k), false), fromBase64(v));
    return state;
  }

  async exposedCode(address) {
    return fromBase64(await this.call("gen_getContractCode", [{ address }]));
  }

  async transactionData(txId) {
    const hex = await this.call("eth_call", [{ to: CONSENSUS_DATA, data: "0x" + ALL_DATA_SELECTOR + txId.slice(2) }, "latest"]);
    return decodeTransactionData(hex);
  }

  newTransactionLogs(address) {
    return this.call("eth_getLogs", [{
      address: CONSENSUS_MAIN,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [EVENT.NEW, null, "0x" + "00".repeat(12) + address.slice(2).toLowerCase()],
    }]);
  }

  logsForTransaction(txId, fromBlock) {
    return this.call("eth_getLogs", [{
      address: CONSENSUS_MAIN,
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "latest",
      topics: [null, txId],
    }]);
  }
}

export const txUrl = (id) => `${CHAIN.explorer}/tx/${id}`;
export const addressUrl = (a) => `${CHAIN.explorer}/address/${a}`;
export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);
export const isSha256 = (s) => /^[0-9a-fA-F]{64}$/.test(s);
