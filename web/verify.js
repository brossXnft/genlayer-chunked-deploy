// Answers "what code does this contract really run, and can anyone change it?" from chain data.
//
// gen_getContractCode returns the code in the default slot, which for a chunk-deployed
// contract is the loader. GenVM runs the code that Root.code_slot points to, so this reads
// that slot directly. Layout: runners/genlayer-py-std/.../storage/root.py in genvm-executor.
import { cdDecode, rlpDecode, sha256, sha3_256, toHex } from "./codec.js";
import { ACCEPTED, EXEC_RETURN, FINALIZED } from "./chain.js";

const ROOT = new Uint8Array(32);
const OFFSET = { CODE: 2, LOCKED_SLOTS: 3, UPGRADERS: 4, CODE_SLOT: 5 };
const MAX_HISTORY = 200;

const u32 = (b, at = 0) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

export function indirect(slot, offset) {
  const data = new Uint8Array(36);
  data.set(slot);
  new DataView(data.buffer).setUint32(32, offset, true);
  return sha3_256(data);
}

const readSlot = (state, slot) => state.get(toHex(slot, false) + "00000000");

function readVla(state, slot) {
  const v = readSlot(state, slot);
  if (!v || v.length < 4) return new Uint8Array(0);
  return v.subarray(4, 4 + u32(v));
}

function readList(state, slot, itemSize) {
  const v = readSlot(state, slot);
  if (!v || v.length < 4) return [];
  const n = u32(v);
  return Array.from({ length: n }, (_, i) => v.slice(4 + i * itemSize, 4 + (i + 1) * itemSize));
}

// The part of the proof that depends only on current storage.
export async function inspectStorage(state) {
  const root = readSlot(state, ROOT);
  if (!root) return null;
  const pointer = root.slice(OFFSET.CODE_SLOT, OFFSET.CODE_SLOT + 32);
  const chunked = pointer.some((b) => b !== 0);
  const codeSlot = chunked ? pointer : indirect(ROOT, OFFSET.CODE);
  const code = readVla(state, codeSlot);
  const locked = readList(state, indirect(ROOT, OFFSET.LOCKED_SLOTS), 32).map((b) => toHex(b, false));
  const upgraders = readList(state, indirect(ROOT, OFFSET.UPGRADERS), 20).map((b) => toHex(b));
  return {
    chunked,
    code,
    sha256: code.length ? await sha256(code) : null,
    isWasm: code[0] === 0 && code[1] === 0x61 && code[2] === 0x73 && code[3] === 0x6d,
    codeSlot: toHex(codeSlot, false),
    upgraders,
    rootLocked: locked.includes(toHex(ROOT, false)),
    codeSlotLocked: locked.includes(toHex(codeSlot, false)),
  };
}

function describeCall(data) {
  try {
    const list = rlpDecode(data.calldata);
    if (list.length === 3 && list[0] instanceof Uint8Array) return { method: "deploy", source: list[0] };
    const call = cdDecode(list[0]);
    return { method: call[""] ?? "call", args: call.args ?? [] };
  } catch {
    return { method: "unknown" };
  }
}

// Replays the upload transactions. Stops at the first activate; later writes only get counted.
export async function readHistory(rpc, address, onProgress = () => {}) {
  const logs = await rpc.newTransactionLogs(address);
  const rows = [];
  let activated = false;
  for (let i = 0; i < logs.length && i < MAX_HISTORY && !activated; i += 4) {
    const batch = logs.slice(i, i + 4);
    const data = await Promise.all(batch.map((l) => rpc.transactionData(l.topics[1])));
    for (const d of data) {
      const call = describeCall(d);
      const last = d.rounds[d.rounds.length - 1];
      const row = {
        txId: d.id,
        sender: d.sender,
        slot: d.slot,
        status: d.status,
        execution: d.execution,
        agree: last ? last.votes.filter((v) => v === 1).length : 0,
        voters: last ? last.validators.length : 0,
        ...call,
      };
      rows.push(row);
      if (call.method === "activate") activated = true;
    }
    onProgress(rows.length, logs.length);
  }
  rows.sort((a, b) => a.slot - b.slot);
  return { rows, total: logs.length };
}

export function reassemble(rows, owner) {
  const puts = rows.filter((r) =>
    r.method === "put" && r.sender === owner && r.execution === EXEC_RETURN && (r.status === FINALIZED || r.status === ACCEPTED));
  if (!puts.length) return null;
  const end = Math.max(...puts.map((p) => p.args[0] + p.args[1].length));
  const out = new Uint8Array(end);
  for (const p of puts) out.set(p.args[1], p.args[0]);
  return out;
}

const check = (id, state, label, detail) => ({ id, state, label, detail });

// `expected` is a lowercase sha256 hex string, or null when the caller only wants to identify the code.
export async function verifyContract(rpc, address, { expected = null, currentLoader = null, onProgress } = {}) {
  const addr = address.toLowerCase();
  let state;
  try {
    state = await rpc.storage(addr);
  } catch (e) {
    if (e.name === "RpcError" && e.code !== undefined) return { found: false, address: addr };
    throw e;
  }
  const live = await inspectStorage(state);
  if (!live || !live.code.length) return { found: false, address: addr };

  const [exposed, history] = await Promise.all([rpc.exposedCode(addr), readHistory(rpc, addr, onProgress)]);
  const exposedSha = await sha256(exposed);
  const deploy = history.rows.find((r) => r.method === "deploy");
  const activate = history.rows.find((r) => r.method === "activate");
  const owner = deploy?.sender ?? null;
  const loaderSha = deploy?.source ? await sha256(deploy.source) : null;

  const checks = [];
  checks.push(
    live.isWasm || !live.chunked
      ? check("code", "pass", "Running code found", `${live.code.length.toLocaleString("en-US")} bytes read from the slot GenVM executes.`)
      : check("code", "warn", "Running code is not WebAssembly", "The code slot does not start with the WASM header."),
  );
  if (expected) {
    checks.push(expected === live.sha256
      ? check("match", "pass", "Matches the expected code", "The SHA-256 of the running code equals the one you supplied.")
      : check("match", "fail", "Does not match the expected code", `Running code hashes to ${live.sha256}.`));
  }
  checks.push(live.upgraders.length === 0
    ? check("owner", "pass", "No owner can replace the code", "The contract's upgraders list is empty.")
    : check("owner", "fail", "An owner can still replace the code", `Upgraders: ${live.upgraders.join(", ")}.`));
  checks.push(live.rootLocked
    ? check("pointer", "pass", "Code pointer is locked", "The root slot holding the code pointer is write-protected.")
    : check("pointer", "fail", "Code pointer is not locked", "The root slot is missing from the locked slots."));
  checks.push(live.codeSlotLocked
    ? check("bytes", "pass", "Code bytes are locked", "The slot holding the code is write-protected.")
    : check("bytes", "warn", "Code bytes are not write-protected", "No outside account can change them, but the contract's own code could overwrite this slot. Audit its storage writes, or redeploy with the current loader."));

  if (live.chunked) {
    const replay = owner ? reassemble(history.rows, owner) : null;
    const replaySha = replay ? await sha256(replay.subarray(0, live.code.length)) : null;
    checks.push(replaySha === live.sha256 && replay.length === live.code.length
      ? check("history", "pass", "Upload history reproduces the code", "Replaying the owner's upload transactions gives the same bytes.")
      : check("history", "warn", "Upload history does not reproduce the code", "The running code was not fully written by the deployer's accepted upload transactions."));
    if (activate) {
      checks.push(activate.status === FINALIZED
        ? check("final", "pass", "Activation is final", "The activation transaction can no longer be appealed.")
        : check("final", "warn", "Activation is not final yet", "The activation transaction can still be appealed. Check again later."));
    } else {
      checks.push(check("final", "warn", "No activation transaction found", "The contract's code pointer was set some other way."));
    }
  }

  return {
    found: true,
    address: addr,
    chunked: live.chunked,
    sha256: live.sha256,
    size: live.code.length,
    exposedIsDifferent: exposedSha !== live.sha256,
    deployer: owner,
    loaderIsCurrent: loaderSha && currentLoader ? loaderSha === currentLoader : null,
    rows: history.rows,
    laterTransactions: Math.max(0, history.total - history.rows.length),
    checks,
    expected,
    verdict: verdictFor(checks, expected),
  };
}

function verdictFor(checks, expected) {
  const failed = checks.find((c) => c.state === "fail");
  if (failed) return { level: "bad", title: failed.label, text: failed.detail };
  const warned = checks.find((c) => c.state === "warn");
  const subject = expected ? "This contract runs exactly the code you expected" : "This contract's running code is identified below";
  if (warned) return { level: "warn", title: subject + ", with a caveat", text: `${warned.label}. ${warned.detail}` };
  return { level: "ok", title: subject + ", and it is locked", text: "Every check passed against current chain data." };
}
