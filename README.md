# genlayer-chunked-deploy

Deploy GenLayer Intelligent Contracts that are too large for a single transaction, such as **Rust/WASM contracts built with `genlayer_sdk`**, on Bradbury Phase 2 (chain 4221), and prove which code such a contract really runs.

The [web app](https://brossxnft.github.io/genlayer-chunked-deploy/) does both from the browser. The command-line tool does the deploy.

## The trust problem
A chunk-deployed contract is installed by a small loader. `gen_getContractCode`, and so every explorer, keeps returning the loader's source, while GenVM runs the code that `Root.code_slot` points to. Without further checks nobody can tell what such a contract executes, or whether its deployer can still replace it.

The verifier answers that from chain data, with no wallet:
1. Reads the contract's storage with `gen_getContractState` and follows `Root.code_slot` to the bytes GenVM executes.
2. Hashes them and compares with the SHA-256 or `.wasm` you supply.
3. Checks that `upgraders` is empty and that the root and code slots are in `locked_slots`.
4. Replays the deployer's accepted `put` transactions from `ConsensusData` and confirms they produce the same bytes.

Its results are only as honest as the RPC node it reads (`rpc-bradbury.genlayer.com`).

## Web app
Static files with no backend, build step or third-party script. Open it from GitHub Pages, or locally:
```bash
python -m http.server 8765 --bind 127.0.0.1    # then open http://127.0.0.1:8765
```
- **Verify:** paste an address, optionally with the expected hash. A verified result has a shareable link (`?address=…&sha256=…`).
- **Deploy:** connect a wallet on Bradbury, choose a `.wasm`, and confirm one transaction per step. Each step shows signing, mining and validator consensus. A deployment survives a page reload and continues after a rejected signature, and the contract is activated only if the uploaded bytes read back with the same SHA-256.

Tests compare every encoder byte for byte with `gl_tx.py` and run the deploy flow against a fake chain:
```bash
cd web && npm test                # needs Node 22
python web/test/make_vectors.py   # regenerates vectors.json
```

## Why it is needed
- A Bradbury transaction is capped at **32,000,000 gas** (`ArbGasInfo.maxTxGasLimit`).
- Code costs about **2.45 M + 790 gas per byte** to submit, and this is pure L2 cost (`gasUsedForL1` = 0). The largest contract that fits in one deploy is therefore about **36 KB**.
- Python contracts fit because the interpreter is preinstalled on validators. A Rust contract has to ship its whole WASM, and the smallest `genlayer_sdk` contract is still about 88 KB after every size optimisation that keeps behaviour (opt-level z, LTO, `build-std` + `optimize_for_size`, a small freeing allocator, `wasm-opt -Oz`: 118 KB → 100.8 KB → 88.2 KB).

## How
This uses the code-slot mechanism GenVM already has (see the executor integration test `tests/integration/runner/code_slot_exec`):

1. Deploy `code_loader.py`, a small Python contract. Its constructor records the deployer as `owner` and adds it to `Root.upgraders`, so the owner can still write locked root slots after `lock_default()`.
2. Send `put(offset, chunk)` transactions (24 KB each, about 19.5 M gas) that write the WASM into a private staging slot laid out as `[u32 LE length][bytes]`. Only the owner can call it.
3. Verify the staged bytes through `staged(offset, len)` with `gen_call` (sha256 must match).
4. Call `activate(len, "slot", lock=true)`. It checks the length and the `\0asm` magic, sets `Root.code_slot` to the staging slot, adds that slot to `locked_slots`, and clears `upgraders`, so the contract ends up as immutable as a normal deploy. From then on GenVM loads the WASM (runner `chain:<addr>:d:<hash>`).

Transactions to the same contract are queued: later `put`s only emit `CreatedTransaction` until they are promoted. `chunked_deploy.py` follows each one by its txId.

## Use
```bash
pip install -r requirements.txt
export GL_PK=0x...               # or GL_KEY_FILE=/path/with/GL_PK=line   (testnet key only)
python chunked_deploy.py contract.wasm --test-method anything     # dry run: estimateGas only
python chunked_deploy.py contract.wasm --test-method anything --send
```
Options:
- `--chunk N` (default 24000)
- `--keep-upgrader`: leave the owner as upgrader. Only for experiments; the default locks the contract.

Other tools:
- `gl_tx.py`: deploy, call, read (`gen_call`), watch.
- `gl_txdata.py <txId>`: decodes `ConsensusData.getTransactionAllData`. `txExecutionResult` 1 means return, 2 means error.
- `wasm_strip.py`: strips custom sections and can add a `genvm.version` section. That section is optional: WASM without it runs, verified.

## Verified on Bradbury Phase 2 (2026-11-10)
| Contract | WASM | Txs | Net cost | Check |
|---|---|---|---|---|
| `0xe71eaad15ca916a616cbe0e5443452b8d4f2022e` | official `fetch_webpage.rs` (SDK v0.3-dev), 161,987 B | 9 | ≈0.002 GEN | write tx `0xc80cca70…5b91`: `txExecutionResult` 1, 5/5 validators agree, `nd_outs = [Return("Hello world!")]` |
| `0xa017712f04531feccc1204b08c231372e848b269` | same, without `genvm.version` | 9 | 0.00195 GEN | `gen_call` returns `'Hello world!'` |

These two contracts predate the code-slot lock: nobody outside can change their code, but their own code could overwrite its slot. The verifier reports this as a caveat. The lock in the current loader has not been exercised on Bradbury yet.

Fee template (what `estimate_transaction_fees` returns too): value `100000000000010352` wei, fees `(100, 200, 0, 0.025 GEN, 0, 0, [3], 2, 3e8, 3e8)`, 5 validators, maxRotations 3, validUntil = now + 3600. Most of the fee is refunded (`FeesRefunded`).

## Notes
- Requirements for the Python loader on Bradbury today: runner `py-genlayer:babwp9t37jw9g4j2bccgn14g6x7x9s1f7dsmh7emvz735pz4zxa0`, a `# v0.3.0` first line, and a **blank line after the header**. A comment directly under the header makes the deploy fail silently.
- `gen_call` is only served by the GenLayer node RPC `https://rpc-bradbury.genlayer.com`; the chain RPC has none. Its calldata limit (131,072 hex chars, about 65 KB) is why a large WASM cannot be deploy-simulated first.
- The contract's own `is_init` handler does not run, because the loader is what got deployed. Contracts that need initialisation should expose an explicit init method and call it once after activation.
- The loader **must not have storage fields**. The contract-instance slot (root offset `CONTRACT`) belongs to the code installed by `activate`. An earlier loader with an `owner: Address` field left its bytes there, and the uploaded Rust contract read them back as its initial state: a `u32` counter started at about 513 M, and a `DynArray` length of about 512 M made the leader time out. The owner check now relies on `Root.upgraders` membership instead.
