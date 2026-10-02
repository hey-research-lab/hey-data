// src/evm.ts — identical in every repo that handles addresses
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/; // input: either case, "0x" prefix lowercase
export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

export const isAddress = (v: unknown): v is string => typeof v === 'string' && ADDRESS_RE.test(v);
/** Canonical form for keys, comparison, dedupe, URLs and machine output: lowercase. */
export const normalizeAddress = (v: string): string => {
  if (!isAddress(v))
    throw Object.assign(new Error(`not an EVM address: ${JSON.stringify(v).slice(0, 80)}`), {
      code: 'invalid_address',
    });
  return v.toLowerCase();
};
export const isTxHash = (v: unknown): v is string => typeof v === 'string' && TX_HASH_RE.test(v);
export const normalizeTxHash = (v: string): string => {
  if (!isTxHash(v))
    throw Object.assign(new Error('not a transaction hash'), { code: 'invalid_tx_hash' });
  return v.toLowerCase();
};
