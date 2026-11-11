import assert from "node:assert/strict";
import test from "node:test";
import { concat, sha256, toHex } from "../codec.js";
import { indirect, inspectStorage, reassemble } from "../verify.js";

const ROOT = new Uint8Array(32);
const key = (slot) => toHex(slot, false) + "00000000";
const le32 = (n) => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255);
const WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 9, 9);
const CODE_SLOT = new Uint8Array(32).fill(0xab);
const OWNER = new Uint8Array(20).fill(0x11);

function state({ pointer = CODE_SLOT, upgraders = [], lockRoot = true, lockCode = true } = {}) {
  const root = new Uint8Array(64);
  root.set(pointer, 5);
  const defaultCode = indirect(ROOT, 2), lockedSlot = indirect(ROOT, 3), upgraderSlot = indirect(ROOT, 4);
  const locked = [defaultCode, lockedSlot, upgraderSlot, ...(lockRoot ? [ROOT] : []), ...(lockCode ? [CODE_SLOT] : [])];
  return new Map([
    [key(ROOT), root],
    [key(defaultCode), concat([le32(6), new Uint8Array([35, 32, 118, 48, 46, 51])])],
    [key(CODE_SLOT), concat([le32(WASM.length), WASM, new Uint8Array(32)])],
    [key(lockedSlot), concat([le32(locked.length), ...locked])],
    [key(upgraderSlot), concat([le32(upgraders.length), ...upgraders])],
  ]);
}

test("reads the code GenVM runs, not the loader", async () => {
  const r = await inspectStorage(state());
  assert.equal(r.chunked, true);
  assert.deepEqual(r.code, WASM);
  assert.equal(r.sha256, await sha256(WASM));
  assert.equal(r.isWasm, true);
});

test("a contract with no code pointer reads the default code slot", async () => {
  const r = await inspectStorage(state({ pointer: new Uint8Array(32) }));
  assert.equal(r.chunked, false);
  assert.equal(r.code.length, 6);
});

test("reports locks and owners", async () => {
  const locked = await inspectStorage(state());
  assert.deepEqual([locked.rootLocked, locked.codeSlotLocked, locked.upgraders], [true, true, []]);
  const open = await inspectStorage(state({ lockRoot: false, lockCode: false, upgraders: [OWNER] }));
  assert.deepEqual([open.rootLocked, open.codeSlotLocked, open.upgraders], [false, false, [toHex(OWNER)]]);
});

test("an address without storage is reported as empty", async () => {
  assert.equal(await inspectStorage(new Map()), null);
});

test("replay ignores other senders and failed uploads", () => {
  const put = (sender, offset, bytes, execution = 1, status = 7) => ({ method: "put", sender, execution, status, args: [offset, Uint8Array.from(bytes)] });
  const out = reassemble([
    put("0xaa", 0, [1, 2]),
    put("0xaa", 2, [3, 4]),
    put("0xbb", 0, [9, 9]),
    put("0xaa", 2, [7, 7], 2),
    put("0xaa", 2, [8, 8], 1, 1),
  ], "0xaa");
  assert.deepEqual(out, Uint8Array.of(1, 2, 3, 4));
});
