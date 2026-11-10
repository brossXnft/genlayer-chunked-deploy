# v0.3.0
# { "Depends": "py-genlayer:babwp9t37jw9g4j2bccgn14g6x7x9s1f7dsmh7emvz735pz4zxa0" }

# NOTE: the blank line above matters: GenVM concatenates every leading '#' line into the
# runner JSON, so a comment right under the header breaks the deploy (FINISHED_WITH_ERROR).
#
# Staged code loader: upload a large contract (e.g. Rust WASM) in chunks, then switch
# this contract's code to it. Owner-only. Mechanism = GenVM test runner/code_slot_exec
# (Root.code_slot) with an in-place fallback (overwrite the default code slot).
import genlayer as gl
from genlayer.types import *

STAGE_OFFSET = 0x5354_4147  # arbitrary indirection offset from root -> private staging slot


def _root_cls():
	return gl.storage.Root


def _stage():
	r = _root_cls()
	return r.MANAGER.get_store_slot(gl.storage.ROOT_SLOT_ID).indirect(STAGE_OFFSET)


def _staged_len() -> int:
	return int.from_bytes(_stage().read(0, 4), 'little')


class CodeLoader(gl.contract.Contract):
	# NO storage fields: the contract-instance slot belongs to the code installed by `activate`.
	# (A loader field such as `owner: Address` would be read back as the new contract's initial
	# state, e.g. a Rust counter starting at the owner address bytes.)

	def __init__(self):
		# root/code/locked_slots/upgraders are locked after deploy; upgraders bypass locks.
		# The deployer is the only upgrader, which is also the owner check below.
		_root_cls().get().upgraders.get().append(gl.message.sender_address)

	def _only_owner(self):
		if gl.message.sender_address not in list(_root_cls().get().upgraders.get()):
			raise gl.vm.UserError('only owner')

	@gl.public.view
	def features(self) -> str:
		r = _root_cls()
		names = ['code_slot', 'get_vacant_slot', 'get_resolved_code', 'lock_default', 'upgraders', 'code']
		have = [n for n in names if hasattr(r, n) or n in getattr(r, '__annotations__', {})]
		return ','.join(have)

	@gl.public.view
	def staged_len(self) -> int:
		return _staged_len()

	@gl.public.view
	def staged(self, offset: int, length: int) -> bytes:
		return _stage().read(4 + offset, length)

	@gl.public.write
	def put(self, offset: int, chunk: bytes) -> int:
		self._only_owner()
		s = _stage()
		s.write(4 + offset, chunk)
		cur = _staged_len()
		end = offset + len(chunk)
		if end > cur:
			s.write(0, end.to_bytes(4, 'little'))
			cur = end
		return cur

	@gl.public.write
	def activate(self, expected_len: int, mode: str, lock: bool) -> str:
		self._only_owner()
		s = _stage()
		n = _staged_len()
		if n != expected_len:
			raise gl.vm.UserError('staged length mismatch')
		if s.read(4, 4) != b'\x00asm':
			raise gl.vm.UserError('staged code is not wasm')
		root = _root_cls().get()
		if mode == 'slot':
			root.code_slot = s.as_int()  # executor reads [u32 len][code] from this slot
		elif mode == 'inplace':
			root.code.get().assign(s.read(4, n))
		else:
			raise gl.vm.UserError('mode must be slot or inplace')
		if lock:
			root.upgraders.get().truncate()  # immutable afterwards, like a normal deploy
		return mode
