# Decode ConsensusData.getTransactionAllData(txId) on Bradbury Phase 2.
# usage: python - <txId> [<txId> ...]   (script via stdin)  -> prints named fields
import json, os, sys, urllib.request
from eth_abi import decode
from eth_utils import keccak

RPC = "https://rpc-genlayer-chain-testnet-cfn8m3xc6l.t.conduit.xyz"
CD = "0xc5FA6f82BEe53598825d6edf7E3e24613082c75B"
URL = ("https://raw.githubusercontent.com/genlayerlabs/genlayer-networks/main/"
       "bradbury-phase-2/abi/ConsensusData.sol/ConsensusData.json")
CACHE = os.path.join(os.path.expanduser(os.environ.get("GL_HOME", "~/genlayer")), "abi_ConsensusData.json")


def http(url, data=None):
    r = urllib.request.Request(url, data, {"content-type": "application/json", "user-agent": "research-client"})
    return json.load(urllib.request.urlopen(r, timeout=60))


if not os.path.exists(CACHE):
    open(CACHE, "w").write(json.dumps(http(URL)))
abi = json.load(open(CACHE)); abi = abi.get("abi", abi)
fn = next(e for e in abi if e.get("type") == "function" and e["name"] == "getTransactionAllData")


def t(i):
    if i["type"].startswith("tuple"):
        return "(" + ",".join(t(c) for c in i["components"]) + ")" + i["type"][5:]
    return i["type"]


sig = "getTransactionAllData(" + ",".join(t(i) for i in fn["inputs"]) + ")"
sel = keccak(text=sig)[:4]
out_types = [t(o) for o in fn["outputs"]]


def named(spec, val, depth=0, path=""):
    pad = "  " * depth
    if spec["type"].startswith("tuple") and spec["type"].endswith("[]"):
        print(f"{pad}{spec['name']}: [{len(val)} items]")
        sub = dict(spec, type=spec["type"][:-2])
        for k, v in enumerate(val[:6]):
            named(dict(sub, name=f"[{k}]"), v, depth + 1)
        return
    if spec["type"].startswith("tuple"):
        print(f"{pad}{spec['name']}:")
        for c, v in zip(spec["components"], val):
            named(c, v, depth + 1)
        return
    if isinstance(val, bytes):
        s = val.hex()
        txt = ""
        try:
            d = val.decode()
            if d.isprintable() and d: txt = f"  text={d[:120]!r}"
        except Exception:
            pass
        print(f"{pad}{spec['name']} ({spec['type']}, {len(val)} B): {s[:96]}{'…' if len(s) > 96 else ''}{txt}")
    elif isinstance(val, (list, tuple)):
        print(f"{pad}{spec['name']} ({spec['type']}): {list(val)[:12]}")
    else:
        print(f"{pad}{spec['name']} ({spec['type']}): {val}")


for tx in sys.argv[1:]:
    data = "0x" + (sel + bytes.fromhex(tx.removeprefix("0x"))).hex()
    r = http(RPC, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                              "params": [{"to": CD, "data": data}, "latest"]}).encode())
    print("=" * 20, tx)
    if "error" in r:
        print("ERR", r["error"]); continue
    vals = decode(out_types, bytes.fromhex(r["result"][2:]))
    for spec, v in zip(fn["outputs"], vals):
        named(spec, v)
