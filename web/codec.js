// Encoders with no dependencies. Every format here is checked against the Python
// implementation in gl_tx.py by web/test/codec.test.mjs.

export const utf8 = (s) => new TextEncoder().encode(s);
export const fromUtf8 = (b) => new TextDecoder().decode(b);

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function toHex(bytes, prefix = true) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return prefix ? "0x" + s : s;
}

export function fromHex(hex) {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(bytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), false);
}

// ---------------- GenLayer calldata ----------------

function pushUleb(out, value) {
  let v = BigInt(value);
  if (v === 0n) { out.push(0); return; }
  while (v > 0n) {
    const c = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v > 0n ? c | 0x80 : c);
  }
}

function pushBytes(out, bytes) {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

function encodeValue(out, x) {
  if (x === null || x === undefined) out.push(0);
  else if (x === true) out.push(2 << 3);
  else if (x === false) out.push(1 << 3);
  else if (typeof x === "number" || typeof x === "bigint") {
    const v = BigInt(x);
    pushUleb(out, v >= 0n ? (v << 3n) | 1n : ((-v - 1n) << 3n) | 2n);
  } else if (x instanceof Uint8Array) {
    pushUleb(out, (BigInt(x.length) << 3n) | 3n);
    pushBytes(out, x);
  } else if (typeof x === "string") {
    const b = utf8(x);
    pushUleb(out, (BigInt(b.length) << 3n) | 4n);
    pushBytes(out, b);
  } else if (Array.isArray(x)) {
    pushUleb(out, (BigInt(x.length) << 3n) | 5n);
    for (const v of x) encodeValue(out, v);
  } else if (typeof x === "object") {
    const keys = Object.keys(x).sort();
    pushUleb(out, (BigInt(keys.length) << 3n) | 6n);
    for (const k of keys) {
      const b = utf8(k);
      pushUleb(out, b.length);
      pushBytes(out, b);
      encodeValue(out, x[k]);
    }
  } else throw new TypeError("cannot encode " + typeof x);
}

export function cdEncode(x) {
  const out = [];
  encodeValue(out, x);
  return Uint8Array.from(out);
}

export function cdDecode(buf) {
  let pos = 0;
  const uleb = () => {
    let r = 0n, shift = 0n;
    for (;;) {
      const x = buf[pos++];
      if (x === undefined) throw new Error("calldata truncated");
      r |= BigInt(x & 0x7f) << shift;
      shift += 7n;
      if (x < 0x80) return r;
    }
  };
  const small = (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v);
  const value = () => {
    const v = uleb();
    const type = Number(v & 7n), p = v >> 3n, n = Number(p);
    if (type === 0) {
      if (p === 0n) return null;
      if (p === 1n) return false;
      if (p === 2n) return true;
      if (p === 3n) { const a = buf.slice(pos, pos + 20); pos += 20; return toHex(a); }
      throw new Error("unknown calldata special " + p);
    }
    if (type === 1) return small(p);
    if (type === 2) return small(-p - 1n);
    if (type === 3 || type === 4) {
      const d = buf.slice(pos, pos + n);
      pos += n;
      return type === 3 ? d : fromUtf8(d);
    }
    if (type === 5) return Array.from({ length: n }, value);
    if (type === 6) {
      const m = {};
      for (let i = 0; i < n; i++) {
        const l = Number(uleb());
        const k = fromUtf8(buf.slice(pos, pos + l));
        pos += l;
        m[k] = value();
      }
      return m;
    }
    throw new Error("unknown calldata type " + type);
  };
  return value();
}

export function callObject(method, args = []) {
  const o = { "": method };
  if (args.length) o.args = args;
  return o;
}

// ---------------- RLP ----------------

function rlpLength(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const bytes = [];
  for (let v = len; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.of(offset + 55 + bytes.length, ...bytes);
}

export function rlpEncode(item) {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat([rlpLength(item.length, 0x80), item]);
  }
  const body = concat(item.map(rlpEncode));
  return concat([rlpLength(body.length, 0xc0), body]);
}

export function rlpDecode(buf) {
  let pos = 0;
  const readLen = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[pos++];
    return v;
  };
  const item = () => {
    if (pos >= buf.length) throw new Error("rlp truncated");
    const b = buf[pos++];
    if (b < 0x80) return Uint8Array.of(b);
    if (b < 0xc0) {
      const n = b < 0xb8 ? b - 0x80 : readLen(b - 0xb7);
      if (pos + n > buf.length) throw new Error("rlp truncated");
      const d = buf.slice(pos, pos + n);
      pos += n;
      return d;
    }
    const n = b < 0xf8 ? b - 0xc0 : readLen(b - 0xf7);
    const end = pos + n;
    if (end > buf.length) throw new Error("rlp truncated");
    const list = [];
    while (pos < end) list.push(item());
    return list;
  };
  return item();
}

export const deployCalldata = (code) => rlpEncode([code, cdEncode({}), Uint8Array.of(0)]);
export const callCalldata = (method, args = []) => rlpEncode([cdEncode(callObject(method, args)), Uint8Array.of(0)]);

// ---------------- Solidity ABI ----------------

export function parseAbiType(src) {
  let pos = 0;
  const one = () => {
    let t;
    if (src[pos] === "(") {
      pos++;
      const comps = [];
      while (src[pos] !== ")") {
        comps.push(one());
        if (src[pos] === ",") pos++;
      }
      pos++;
      t = { kind: "tuple", comps };
    } else {
      const start = pos;
      while (pos < src.length && /[a-z0-9]/.test(src[pos])) pos++;
      t = { kind: src.slice(start, pos) };
    }
    while (src.substr(pos, 2) === "[]") {
      pos += 2;
      t = { kind: "array", of: t };
    }
    return t;
  };
  return one();
}

const isDynamic = (t) =>
  t.kind === "array" || t.kind === "bytes" || (t.kind === "tuple" && t.comps.some(isDynamic));

const headSize = (t) =>
  t.kind === "tuple" && !isDynamic(t) ? t.comps.reduce((n, c) => n + headSize(c), 0) : 32;

function word(v) {
  const out = new Uint8Array(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

function encodeSeq(types, values) {
  const size = types.reduce((n, t) => n + (isDynamic(t) ? 32 : headSize(t)), 0);
  const heads = [], tails = [];
  let tailAt = size;
  types.forEach((t, i) => {
    const e = encodeAbi(t, values[i]);
    if (isDynamic(t)) {
      heads.push(word(tailAt));
      tails.push(e);
      tailAt += e.length;
    } else heads.push(e);
  });
  return concat([...heads, ...tails]);
}

export function encodeAbi(t, v) {
  if (t.kind === "tuple") return encodeSeq(t.comps, v);
  if (t.kind === "array") return concat([word(v.length), encodeSeq(v.map(() => t.of), v)]);
  if (t.kind === "bytes") {
    const pad = (32 - (v.length % 32)) % 32;
    return concat([word(v.length), v, new Uint8Array(pad)]);
  }
  if (t.kind === "address" || t.kind === "bytes32") return t.kind === "address" ? word(BigInt(v)) : fromHex(v);
  if (t.kind === "bool") return word(v ? 1 : 0);
  if (t.kind.startsWith("uint")) return word(v);
  throw new Error("unsupported abi type " + t.kind);
}

function readWord(buf, at) {
  if (at + 32 > buf.length) throw new Error("abi data truncated");
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(buf[at + i]);
  return v;
}

function decodeSeq(types, buf, base) {
  let head = base;
  return types.map((t) => {
    let v;
    if (isDynamic(t)) v = decodeAbi(t, buf, base + Number(readWord(buf, head)));
    else v = decodeAbi(t, buf, head);
    head += isDynamic(t) ? 32 : headSize(t);
    return v;
  });
}

export function decodeAbi(t, buf, at = 0) {
  if (t.kind === "tuple") return decodeSeq(t.comps, buf, at);
  if (t.kind === "array") {
    const n = Number(readWord(buf, at));
    return decodeSeq(Array.from({ length: n }, () => t.of), buf, at + 32);
  }
  if (t.kind === "bytes") {
    const n = Number(readWord(buf, at));
    if (at + 32 + n > buf.length) throw new Error("abi data truncated");
    return buf.slice(at + 32, at + 32 + n);
  }
  if (t.kind === "address") return toHex(buf.slice(at + 12, at + 32));
  if (t.kind === "bytes32") return toHex(buf.slice(at, at + 32));
  if (t.kind === "bool") return readWord(buf, at) !== 0n;
  if (t.kind === "uint8") return Number(readWord(buf, at));
  if (t.kind.startsWith("uint")) return readWord(buf, at);
  throw new Error("unsupported abi type " + t.kind);
}

// ---------------- SHA3-256 (GenVM storage slot derivation) ----------------

const ROUND = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;

function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const c = [];
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    let last = s[1];
    for (let i = 0; i < 24; i++) {
      const j = PI[i], tmp = s[j];
      s[j] = rotl(last, ROT[i]);
      last = tmp;
    }
    for (let y = 0; y < 25; y += 5) {
      const row = s.slice(y, y + 5);
      for (let x = 0; x < 5; x++) s[y + x] = row[x] ^ (~row[(x + 1) % 5] & MASK & row[(x + 2) % 5]);
    }
    s[0] ^= ROUND[r];
  }
}

export function sha3_256(data) {
  const rate = 136;
  const padded = new Uint8Array(Math.floor(data.length / rate + 1) * rate);
  padded.set(data);
  padded[data.length] ^= 0x06;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((s[i >> 3] >> BigInt((i & 7) * 8)) & 0xffn);
  return out;
}
