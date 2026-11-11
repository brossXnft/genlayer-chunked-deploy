#!/usr/bin/env python3
"""Writes web/test/vectors.json from the Python implementation the web page has to match.

  python web/test/make_vectors.py     (needs requirements.txt and the ConsensusMain ABI cached by gl_tx.py)
"""
import hashlib, importlib.util, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
spec = importlib.util.spec_from_file_location("g", os.path.join(ROOT, "gl_tx.py"))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
import rlp
from eth_abi import encode

SENDER = "0x70B4941eB04D153D87bb29bb8a5884AF77d3401B"
VALID_UNTIL = 1794320429
piece = bytes(range(256)) * 94  # 24064 B

# Each case: JS-readable description of the value and its encoding.
cd_cases = [
    ({"t": "null"}, None), ({"t": "bool", "v": True}, True), ({"t": "bool", "v": False}, False),
    ({"t": "int", "v": "0"}, 0), ({"t": "int", "v": "127"}, 127), ({"t": "int", "v": "300000000000000000000"}, 300000000000000000000),
    ({"t": "int", "v": "-1"}, -1), ({"t": "int", "v": "-129"}, -129),
    ({"t": "str", "v": "héllo"}, "héllo"), ({"t": "bytes", "v": "00ff10"}, bytes.fromhex("00ff10")),
    ({"t": "call", "m": "staged_len", "a": []}, g.call_obj("staged_len", [])),
    ({"t": "call", "m": "activate", "a": [{"t": "int", "v": "161987"}, {"t": "str", "v": "slot"}, {"t": "bool", "v": True}]},
     g.call_obj("activate", [161987, "slot", True])),
]

types, sel, _ = g.load_abi()


def add_tx(recipient, txcd):
    t = g.CALL_T
    return (sel + encode(types, [(SENDER, recipient, t["nval"], t["maxrot"], VALID_UNTIL, 0, 0, t["fees"], txcd, [])])).hex()


loader = b"# v0.3.0\n\nprint('a loader')\n" * 200
deploy_cd = rlp.encode([loader, g.cd_encode({}), b"\x00"])
put_cd = rlp.encode([g.cd_encode(g.call_obj("put", [24000, piece])), b"\x00"])
activate_cd = rlp.encode([g.cd_encode(g.call_obj("activate", [161987, "slot", True])), b"\x00"])
recipient = "0xe71eaad15ca916a616cbe0e5443452b8d4f2022e"

json.dump({
    "cd": [{"value": d, "hex": g.cd_encode(v).hex()} for d, v in cd_cases],
    "sender": SENDER, "recipient": recipient, "validUntil": VALID_UNTIL,
    "loader": loader.hex(), "deployCalldata": deploy_cd.hex(), "deployTx": add_tx("0x" + "00" * 20, deploy_cd),
    "piece": piece.hex(), "putCalldata": put_cd.hex(), "putTx": add_tx(recipient, put_cd),
    "activateCalldata": activate_cd.hex(), "activateTx": add_tx(recipient, activate_cd),
    "sha3": [{"in": s.hex(), "out": hashlib.sha3_256(s).hexdigest()} for s in
             (b"", bytes(36), bytes(135), bytes(136), bytes(137), bytes(range(256)) * 3)],
}, open(os.path.join(HERE, "vectors.json"), "w"))
print("wrote vectors.json")
