// src/chain.ts — identical in every repo that touches a chain id
export const CHAIN_NAME = 'Robinhood Chain' as const;
export const CHAIN_ID = 4663 as const;
export const CAIP2 = 'eip155:4663' as const;
export const EXPLORER_URL = 'https://robinhoodchain.blockscout.com' as const; // HEY's BRAND.explorerUrl
export const PUBLIC_RPC_HOST = 'rpc.mainnet.chain.robinhood.com' as const; // a public fact; never called in tests
export const explorerAddressUrl = (a: string) => `${EXPLORER_URL}/address/${a.toLowerCase()}`;
export const explorerTokenUrl = (a: string) => `${EXPLORER_URL}/token/${a.toLowerCase()}`;
export const explorerTxUrl = (h: string) => `${EXPLORER_URL}/tx/${h.toLowerCase()}`;

export class UnsupportedChainError extends Error {
  readonly code = 'unsupported_chain';
  constructor(readonly chainId: unknown) {
    super(`HEY supports Robinhood Chain (4663) only; chain ${String(chainId)} is not supported.`);
  }
}
/** Accepts the integer 4663 only. Strings, 4663.0, "04663", other chains → UnsupportedChainError. */
export function assertChainId(value: unknown): asserts value is typeof CHAIN_ID {
  if (value !== CHAIN_ID) throw new UnsupportedChainError(value);
}
