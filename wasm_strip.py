#!/usr/bin/env python3
"""Strip custom sections from a wasm module; optionally add a `genvm.version` custom section.
usage: wasm_strip.py in.wasm out.wasm [--version v0.3.0]"""
import sys

def uleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7F) << s; s += 7
        if x < 0x80: return r, i

def enc_uleb(n):
    out = bytearray()
    while True:
        x = n & 0x7F; n >>= 7
        out.append(x | (0x80 if n else 0))
        if not n: return bytes(out)

src, dst = sys.argv[1], sys.argv[2]
ver = sys.argv[sys.argv.index("--version") + 1] if "--version" in sys.argv else None
b = open(src, "rb").read()
assert b[:4] == b"\0asm", "not wasm"
out, i, dropped = bytearray(b[:8]), 8, []
while i < len(b):
    sid = b[i]; n, j = uleb(b, i + 1); end = j + n
    if sid == 0:
        l, k = uleb(b, j); dropped.append((b[k:k + l].decode(errors="replace"), n))
    else:
        out += b[i:end]
    i = end
if ver:
    name = b"genvm.version"; body = enc_uleb(len(name)) + name + ver.encode()
    out += b"\x00" + enc_uleb(len(body)) + body
open(dst, "wb").write(out)
print(f"{src}: {len(b):,} -> {dst}: {len(out):,} bytes; dropped {dropped}; version={ver}")
