#!/usr/bin/env python3
"""Deploy a contract larger than one Bradbury transaction (e.g. a Rust/WASM contract).

  chunked_deploy.py <code.wasm|code.py> [--chunk 24000] [--keep-upgrader] [--loader code_loader.py]
                    [--test-method fetch] [--send]

Steps: deploy owner-only loader -> put chunks -> verify staged bytes (sha256) ->
activate(len, "slot", lock) -> wait finalized -> gen_call read of --test-method.
Without --send: dry run (estimateGas of the loader deploy and of every chunk tx).
"""
import hashlib, json, os, sys, time
import importlib.util as u

HERE = os.path.dirname(os.path.abspath(__file__))
s = u.spec_from_file_location("g", os.path.join(HERE, "gl_tx.py")); g = u.module_from_spec(s); s.loader.exec_module(g)
import rlp


def arg(name, default=None):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else default


def main():
    if len(sys.argv) < 2: print(__doc__); sys.exit(1)
    code_path = sys.argv[1]; send = "--send" in sys.argv
    chunk = int(arg("--chunk", "24000")); lock = "--keep-upgrader" not in sys.argv
    loader_path = arg("--loader", os.path.join(HERE, "code_loader.py")); test_method = arg("--test-method")
    code = open(code_path, "rb").read(); sha = hashlib.sha256(code).hexdigest()
    print(f"code {code_path}: {len(code):,} B sha256 {sha[:16]} -> {-(-len(code)//chunk)} chunks of {chunk}")
    acct = g.account(); me = acct.address
    bal0 = int(g.rpc("eth_getBalance", [me, "latest"]), 16)

    # 1. loader
    lcode = open(loader_path, "rb").read()
    txcd = rlp.encode([lcode, g.cd_encode({}), b"\x00"])
    r = g.send(acct, g.build(acct, "0x" + "00" * 20, txcd, g.CALL_T), g.CALL_T, not send, "loader deploy")
    if not send:
        for off in range(0, len(code), chunk):
            piece = code[off:off + chunk]
            data = g.build(acct, "0x" + "11" * 20, rlp.encode([g.cd_encode(g.call_obj("put", [off, piece])), b"\x00"]), g.CALL_T)
            print(f"  chunk @{off}: input {len(data):,} B (~{2_450_000 + 790 * len(data):,} gas est.)")
        return
    if not (r and r["ok"]): sys.exit("loader deploy failed")
    if g.watch(r["tx_id"], r["block"], 10, stop_on_accept=False) != "TransactionFinalized": sys.exit("loader not finalized")
    loader = r["recipient"]; print("loader", loader)
    time.sleep(5)
    if g.gen_read(me, loader, "staged_len", []) != 0: sys.exit("loader not readable (deploy failed?)")

    # 2. chunks (queued per recipient; each gets its own txId)
    pend = []
    for off in range(0, len(code), chunk):
        piece = code[off:off + chunk]
        txcd = rlp.encode([g.cd_encode(g.call_obj("put", [off, piece])), b"\x00"])
        pr = g.send(acct, g.build(acct, loader, txcd, g.CALL_T), g.CALL_T, False, f"put @{off}")
        if not (pr and pr["ok"]): sys.exit(f"chunk @{off} send failed")
        pend.append((off, pr))
    for off, pr in pend:
        out = g.watch(pr["tx_id"], pr["block"], 15)
        if out != "TransactionAccepted" and out != "TransactionFinalized": sys.exit(f"chunk @{off}: {out}")

    # 3. verify staged bytes
    for _ in range(10):
        if g.gen_read(me, loader, "staged_len", []) == len(code): break
        time.sleep(6)
    got = b"".join(g.gen_read(me, loader, "staged", [o, min(chunk, len(code) - o)]) for o in range(0, len(code), chunk))
    if hashlib.sha256(got).hexdigest() != sha: sys.exit("staged bytes mismatch")
    print("staged bytes verified")

    # 4. activate
    txcd = rlp.encode([g.cd_encode(g.call_obj("activate", [len(code), "slot", lock])), b"\x00"])
    ar = g.send(acct, g.build(acct, loader, txcd, g.CALL_T), g.CALL_T, False, "activate")
    out = g.watch(ar["tx_id"], ar["block"], 10, stop_on_accept=False)
    print("activate:", out)
    bal1 = int(g.rpc("eth_getBalance", [me, "latest"]), 16)
    g.log({"label": "chunked_deploy", "contract": loader, "code": os.path.basename(code_path), "len": len(code),
           "sha256": sha, "lock": lock, "cost_gen": (bal0 - bal1) / 1e18})
    print(f"CONTRACT {loader}  (net cost {(bal0 - bal1)/1e18:.6f} GEN, lock={lock})")

    # 5. smoke test
    if test_method:
        time.sleep(5)
        try: print("test", test_method, "->", repr(g.gen_read(me, loader, test_method, []))[:300])
        except Exception as e: print("test", test_method, "ERR", str(e)[:300])


if __name__ == "__main__":
    main()
