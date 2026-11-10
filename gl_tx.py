#!/usr/bin/env python3
"""GenLayer Bradbury Phase 2 helper (no SDK): deploy / call / read / watch.

  gl_tx.py deploy <file.py|file.wasm> [--send]
  gl_tx.py call   <addr> <method> '<json args>' [--send] [--wait MIN]
  gl_tx.py read   <addr> <method> '<json args>'
  gl_tx.py watch  <txId> [--from-block N] [--wait MIN]
  gl_tx.py upload <loader_addr> <file.wasm> [--chunk N] [--start-offset N] [--send]

json args: strings "hex:<..>" become bytes, "file:<path>[@off:len]" reads bytes.
Default = dry run (eth_estimateGas). Key from ~/genlayer/bradbury.env (never printed).
Log: ~/genlayer/txlog.jsonl
"""
import json, os, sys, time, urllib.request
import rlp
from eth_abi import encode
from eth_account import Account
from eth_utils import keccak

RPC = "https://rpc-genlayer-chain-testnet-cfn8m3xc6l.t.conduit.xyz"
GEN_RPC = "https://rpc-bradbury.genlayer.com"  # has gen_call
CHAIN_ID = 4221
CM = "0x2E2766cbc3E5e61Ce93bBcdCBb3eAcB82082A019"
HOME = os.path.expanduser(os.environ.get("GL_HOME", "~/genlayer"))  # ABI cache + tx log
os.makedirs(HOME, exist_ok=True)
ABI_CACHE = os.path.join(HOME, "abi_ConsensusMainWithFees.json")
LOG = os.path.join(HOME, "txlog.jsonl")
MAX_TX_GAS = 32_000_000
E18 = 10**18
# templates copied from successful Phase 2 txs (value must match exactly)
DEPLOY_T = dict(nval=5, maxrot=3, valid=3600, value=50_000_000_000_016_941,
                fees=(600, 600, 0, 25 * 10**15, 0, 0, [1], 2, 300_000_000, 300_000_000))
CALL_T = dict(nval=5, maxrot=3, valid=3600, value=100_000_000_000_010_352,
              fees=(100, 200, 0, 25 * 10**15, 0, 0, [3], 2, 300_000_000, 300_000_000))


# ---------------- GenLayer calldata ----------------
def cd_encode(x):
    out = bytearray()
    def uleb(i):
        if i == 0: out.append(0)
        while i > 0:
            c = i & 0x7F; i >>= 7
            out.append(c | (0x80 if i else 0))
    def imp(b):
        if b is None: out.append(0)
        elif b is True: out.append(2 << 3)
        elif b is False: out.append(1 << 3)
        elif isinstance(b, int):
            uleb((b << 3) | 1) if b >= 0 else uleb(((-b - 1) << 3) | 2)
        elif isinstance(b, (bytes, bytearray)):
            uleb((len(b) << 3) | 3); out.extend(b)
        elif isinstance(b, str):
            e = b.encode(); uleb((len(e) << 3) | 4); out.extend(e)
        elif isinstance(b, (list, tuple)):
            uleb((len(b) << 3) | 5); [imp(v) for v in b]
        elif isinstance(b, dict):
            ks = sorted(b); uleb((len(ks) << 3) | 6)
            for k in ks:
                e = k.encode(); uleb(len(e)); out.extend(e); imp(b[k])
        else: raise TypeError(type(b))
    imp(x); return bytes(out)


def cd_decode(buf):
    pos = 0
    def uleb():
        nonlocal pos
        r = s = 0
        while True:
            x = buf[pos]; pos += 1; r |= (x & 0x7F) << s; s += 7
            if x < 0x80: return r
    def imp():
        nonlocal pos
        v = uleb(); t, p = v & 7, v >> 3
        if t == 0:
            if p == 0: return None
            if p == 1: return False
            if p == 2: return True
            if p == 3: a = buf[pos:pos + 20]; pos += 20; return "0x" + a.hex()
            raise ValueError(f"special {p}")
        if t == 1: return p
        if t == 2: return -p - 1
        if t in (3, 4):
            d = buf[pos:pos + p]; pos += p
            return bytes(d) if t == 3 else d.decode(errors="replace")
        if t == 5: return [imp() for _ in range(p)]
        if t == 6:
            m = {}
            for _ in range(p):
                l = uleb(); k = buf[pos:pos + l].decode(); pos += l; m[k] = imp()
            return m
        raise ValueError(f"type {t}")
    return imp()


def call_obj(method, args):
    o = {"": method}
    if args: o["args"] = args
    return o


def parse_args(js):
    def conv(v):
        if isinstance(v, str) and v.startswith("hex:"): return bytes.fromhex(v[4:])
        if isinstance(v, str) and v.startswith("file:"):
            spec = v[5:]; rng = None
            if "@" in spec: spec, rng = spec.split("@")
            d = open(spec, "rb").read()
            if rng: o, l = map(int, rng.split(":")); d = d[o:o + l]
            return d
        if isinstance(v, list): return [conv(x) for x in v]
        return v
    return [conv(v) for v in json.loads(js)] if js else []


# ---------------- chain plumbing ----------------
def http(url, payload):
    req = urllib.request.Request(url, json.dumps(payload).encode(),
                                 {"content-type": "application/json", "user-agent": "research-client"})
    return json.load(urllib.request.urlopen(req, timeout=60))


def rpc(method, params, url=RPC):
    r = http(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if "error" in r: raise RuntimeError(f"{method}: {r['error']}")
    return r["result"]


def load_abi():
    abi = json.load(open(ABI_CACHE)); abi = abi.get("abi", abi)
    def t(i):
        if i["type"].startswith("tuple"):
            return "(" + ",".join(t(c) for c in i["components"]) + ")" + i["type"][5:]
        return i["type"]
    fn = next(e for e in abi if e.get("type") == "function" and e["name"] == "addTransaction")
    types = [t(i) for i in fn["inputs"]]
    sel = keccak(text="addTransaction(" + ",".join(types) + ")")[:4]
    events = {"0x" + keccak(text=e["name"] + "(" + ",".join(t(i) for i in e["inputs"]) + ")").hex(): e["name"]
              for e in abi if e.get("type") == "event"}
    return types, sel, events


def account():
    """Signer: env GL_PK, else GL_PK=... line in $GL_KEY_FILE (default $GL_HOME/bradbury.env). Never printed."""
    pk = os.environ.get("GL_PK")
    if not pk:
        key_file = os.path.expanduser(os.environ.get("GL_KEY_FILE", os.path.join(HOME, "bradbury.env")))
        pk = [l.split("=", 1)[1].strip() for l in open(key_file) if l.startswith("GL_PK=")][0]
    a = Account.from_key(pk); del pk
    return a


def log(rec):
    rec["ts"] = int(time.time()); open(LOG, "a").write(json.dumps(rec) + "\n")


def build(acct, recipient, tx_calldata, tpl):
    types, sel, _ = load_abi()
    now = int(rpc("eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
    params = (acct.address, recipient, tpl["nval"], tpl["maxrot"], now + tpl["valid"], 0, 0,
              tpl["fees"], tx_calldata, [])
    return sel + encode(types, [params])


def send(acct, data, tpl, dry, label):
    call = {"from": acct.address, "to": CM, "value": hex(tpl["value"]), "data": "0x" + data.hex()}
    try:
        gas = int(rpc("eth_estimateGas", [call]), 16)
    except Exception as e:
        print(f"[{label}] estimateGas FAILED: {e}"); return None
    print(f"[{label}] input {len(data):,} B, estimateGas {gas:,}, value {tpl['value']/E18:.4f} GEN")
    if dry: return None
    base = int(rpc("eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)
    tx = {"chainId": CHAIN_ID, "nonce": int(rpc("eth_getTransactionCount", [acct.address, "pending"]), 16),
          "to": CM, "value": tpl["value"], "data": data, "gas": min(MAX_TX_GAS, int(gas * 1.2)),
          "maxFeePerGas": base * 3, "maxPriorityFeePerGas": 0, "type": 2}
    s = acct.sign_transaction(tx)
    raw = getattr(s, "raw_transaction", None) or s.rawTransaction
    h = rpc("eth_sendRawTransaction", ["0x" + raw.hex().removeprefix("0x")])
    rc = None
    for _ in range(90):
        rc = rpc("eth_getTransactionReceipt", [h])
        if rc: break
        time.sleep(1)
    _, _, events = load_abi()
    tx_id = recip = None
    for lg in rc["logs"]:
        n = events.get(lg["topics"][0])
        if n == "NewTransaction":
            tx_id = lg["topics"][1]; recip = "0x" + lg["topics"][2][-40:]
        elif n == "CreatedTransaction" and tx_id is None:
            tx_id = lg["topics"][1]  # queued behind another tx to the same recipient
    cost = int(rc["gasUsed"], 16) * int(rc.get("effectiveGasPrice", "0x0"), 16)
    print(f"[{label}] L2 {h} status {rc['status']} gasUsed {int(rc['gasUsed'],16):,} gas-cost {cost/E18:.6f} GEN txId {tx_id} recipient {recip}")
    log({"label": label, "l2_tx": h, "status": rc["status"], "gasUsed": int(rc["gasUsed"], 16),
         "tx_id": tx_id, "recipient": recip, "block": int(rc["blockNumber"], 16)})
    return {"tx_id": tx_id, "recipient": recip, "block": int(rc["blockNumber"], 16), "ok": rc["status"] == "0x1"}


FINAL = ("TransactionAccepted", "TransactionUndetermined", "TransactionFinalized", "TransactionCancelled",
         "TransactionLeaderTimeout")


def watch(tx_id, from_block, wait_min, stop_on_accept=True):
    if not tx_id:
        raise ValueError("watch needs a txId")
    _, _, events = load_abi()
    start, seen, deadline, last = from_block, set(), time.time() + wait_min * 60, None
    while time.time() < deadline:
        head = int(rpc("eth_blockNumber", []), 16)
        for s in range(start, head + 1, 2000):
            for lg in rpc("eth_getLogs", [{"address": CM, "fromBlock": hex(s), "toBlock": hex(min(s + 1999, head)),
                                           "topics": [None, tx_id]}]):
                k = (lg["transactionHash"], lg["logIndex"])
                if k in seen: continue
                seen.add(k); name = events.get(lg["topics"][0], lg["topics"][0][:10])
                print(f"   {time.strftime('%H:%M:%SZ', time.gmtime())} blk {int(lg['blockNumber'],16)} {name}")
                last = name
                if name in FINAL and (stop_on_accept or name != "TransactionAccepted"):
                    log({"label": "outcome", "tx_id": tx_id, "outcome": name}); return name
        start = head + 1
        time.sleep(4)
    return last


def gen_read(acct_addr, to, method, args):
    data = rlp.encode([cd_encode(call_obj(method, args)), b"\x00"])
    r = rpc("gen_call", [{"type": "read", "to": to, "from": acct_addr, "data": "0x" + data.hex(),
                          "transaction_hash_variant": "latest-nonfinal"}], url=GEN_RPC)
    meta = {}
    if isinstance(r, dict):  # newer nodes: {data, status, stdout, stderr, logs, leaderPublicData}
        meta = {k: r.get(k) for k in ("status", "stdout", "stderr") if r.get(k)}
        if os.environ.get("GL_LOGS"): meta["logs"] = r.get("logs")
        r = r.get("data") or ""
    raw = bytes.fromhex(r.removeprefix("0x"))
    try: val = cd_decode(raw) if raw else None
    except Exception: val = {"raw_hex": raw.hex()}
    st = meta.get("status") or {}
    if meta and (st.get("code") not in (None, 0) or meta.get("stderr") or meta.get("logs")):
        return {"value": val, **meta}
    return val


def main():
    a = sys.argv[1:]
    if not a: print(__doc__); sys.exit(1)
    cmd, dry = a[0], "--send" not in a
    wait = float(a[a.index("--wait") + 1]) if "--wait" in a else 15
    acct = account()
    if cmd == "deploy":
        code = open(a[1], "rb").read()
        cdata = open(a[a.index("--calldata-file") + 1], "rb").read() if "--calldata-file" in a else cd_encode({})
        tpl = CALL_T if ("--tpl" in a and a[a.index("--tpl") + 1] == "call") else DEPLOY_T
        txcd = rlp.encode([code, cdata, b"\x00"])
        r = send(acct, build(acct, "0x" + "00" * 20, txcd, tpl), tpl, dry, f"deploy {os.path.basename(a[1])}")
        if r and r["ok"]: print("outcome:", watch(r["tx_id"], r["block"], wait))
    elif cmd == "call":
        to, method, args = a[1], a[2], parse_args(a[3] if len(a) > 3 and not a[3].startswith("--") else "")
        txcd = rlp.encode([cd_encode(call_obj(method, args)), b"\x00"])
        r = send(acct, build(acct, to, txcd, CALL_T), CALL_T, dry, f"call {method}")
        if r and r["ok"]: print("outcome:", watch(r["tx_id"], r["block"], wait))
    elif cmd == "read":
        to, method, args = a[1], a[2], parse_args(a[3] if len(a) > 3 else "")
        res = gen_read(acct.address, to, method, args)
        s = repr(res); print(s if len(s) < 2000 else s[:2000] + f"... ({len(s)} chars)")
    elif cmd == "watch":
        fb = int(a[a.index("--from-block") + 1]) if "--from-block" in a else int(rpc("eth_blockNumber", []), 16) - 5000
        print("outcome:", watch(a[1], fb, wait))
    elif cmd == "upload":
        to, path = a[1], a[2]
        chunk = int(a[a.index("--chunk") + 1]) if "--chunk" in a else 24000
        off0 = int(a[a.index("--start-offset") + 1]) if "--start-offset" in a else 0
        code = open(path, "rb").read(); pend = []
        for off in range(off0, len(code), chunk):
            piece = code[off:off + chunk]
            txcd = rlp.encode([cd_encode(call_obj("put", [off, piece])), b"\x00"])
            r = send(acct, build(acct, to, txcd, CALL_T), CALL_T, dry, f"put @{off} len {len(piece)}")
            if r: pend.append((off, r))
        for off, r in pend:
            print(f"put @{off}:", watch(r["tx_id"], r["block"], wait))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
