import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { callCalldata, callObject, cdDecode, cdEncode, deployCalldata, fromHex, rlpDecode, sha3_256, toHex } from "../codec.js";
import { encodeAddTransaction } from "../chain.js";

const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url)));

function value(d) {
  switch (d.t) {
    case "null": return null;
    case "bool": return d.v;
    case "int": return BigInt(d.v);
    case "str": return d.v;
    case "bytes": return fromHex(d.v);
    case "call": return callObject(d.m, d.a.map(value));
  }
}

test("calldata matches gl_tx.cd_encode", () => {
  for (const c of V.cd) assert.equal(toHex(cdEncode(value(c.value)), false), c.hex, JSON.stringify(c.value));
});

test("calldata decodes what it encodes", () => {
  assert.deepEqual(cdDecode(cdEncode({ a: [1, "x", true, null], b: fromHex("00ff") })), { a: [1, "x", true, null], b: fromHex("00ff") });
  assert.equal(cdDecode(cdEncode(-129)), -129);
  assert.equal(cdDecode(cdEncode(2n ** 70n)), 2n ** 70n);
});

test("transaction calldata matches rlp.encode", () => {
  assert.equal(toHex(deployCalldata(fromHex(V.loader)), false), V.deployCalldata);
  assert.equal(toHex(callCalldata("put", [24000, fromHex(V.piece)]), false), V.putCalldata);
  assert.equal(toHex(callCalldata("activate", [161987, "slot", true]), false), V.activateCalldata);
});

test("rlp round trip keeps upload arguments", () => {
  const [call] = rlpDecode(fromHex(V.putCalldata));
  const { "": method, args } = cdDecode(call);
  assert.equal(method, "put");
  assert.equal(args[0], 24000);
  assert.equal(toHex(args[1], false), V.piece);
});

test("addTransaction input matches eth_abi", () => {
  const tx = (recipient, cd) => toHex(encodeAddTransaction({ sender: V.sender, recipient, validUntil: V.validUntil, txCalldata: fromHex(cd) }), false);
  assert.equal(tx("0x" + "00".repeat(20), V.deployCalldata), V.deployTx);
  assert.equal(tx(V.recipient, V.putCalldata), V.putTx);
  assert.equal(tx(V.recipient, V.activateCalldata), V.activateTx);
});

test("sha3_256 matches hashlib", () => {
  for (const c of V.sha3) assert.equal(toHex(sha3_256(fromHex(c.in)), false), c.out);
});
