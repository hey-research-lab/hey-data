import { describe, expect, it } from 'vitest';
import {
  CHANGE_RECORD,
  FORBIDDEN_FIELD,
  ForbiddenFieldError,
  INCLUDED_CHANGE_TYPES,
  LISTING_INPUT,
  OUTPUT_SPECS,
  PROJECT_RECORD,
  SchemaDriftError,
  assertConforms,
  pick,
  specPaths,
} from '../src/allowlist.js';
import { UnsupportedChainError } from '../src/chain.js';

const MARKET_AND_OTHER_FORBIDDEN_KEYS = [
  'marketCap',
  'marketCapUsd',
  'fdv',
  'priceChange24hPct',
  'priceUsd',
  'liquidity',
  'liquidityUsd',
  'volume24h',
  'trades24h',
  'valuationWithheld',
  'venue',
  'launchStage',
  'tokenMarket',
  'holders',
  'holderCount',
  'distribution',
  'usage',
  'callers',
  'onchainActivity',
  'marketIntegrity',
  'rank',
  'rank7d',
  'radar',
  'buildMomentum',
  'discoveryGap',
  'underTheRadar',
  'stillBuilding',
  'stillBuildingState',
  'walletCount',
  'marketCurrent',
  'marketHistory',
];

describe('allowlists', () => {
  it('names no forbidden field in any output file, at any depth', () => {
    for (const [file, spec] of Object.entries(OUTPUT_SPECS)) {
      const bad = specPaths(spec).filter((path) =>
        path.split(/\.|\[\]/).some((key) => key !== '' && FORBIDDEN_FIELD.test(key)),
      );
      expect(bad, file).toEqual([]);
    }
  });

  it('recognises every market, holder, usage, integrity and Radar field name as forbidden', () => {
    for (const key of MARKET_AND_OTHER_FORBIDDEN_KEYS)
      expect(FORBIDDEN_FIELD.test(key), key).toBe(true);
  });

  it('keeps no market-domain, integrity, usage or decoded-call change type', () => {
    for (const type of INCLUDED_CHANGE_TYPES) {
      expect(type.startsWith('market')).toBe(false);
      expect(type).not.toMatch(/usage|method_|launch_stage/);
    }
  });

  it('copies only named keys, never passing an object through', () => {
    const source = JSON.parse(
      '{"slug":"a","name":"A","marketCap":{"usd":1},"__proto__":{"polluted":true},"constructor":1,"token":{"chainId":4663,"contractAddress":"0xABCDEF0000000000000000000000000000000001","extra":1}}',
    ) as unknown;
    const record = pick(source, LISTING_INPUT);
    expect(record).toEqual({
      slug: 'a',
      name: 'A',
      token: { chainId: 4663, contractAddress: '0xabcdef0000000000000000000000000000000001' },
    });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('leaves an absent field absent and refuses a null the spec does not allow', () => {
    expect(pick({ slug: 'a' }, LISTING_INPUT)).toEqual({ slug: 'a' });
    expect(() => pick({ slug: 'a', lastShippedAt: null }, LISTING_INPUT)).toThrow(SchemaDriftError);
    expect(() => pick({ slug: 'a', hasBuilderSource: 'yes' }, LISTING_INPUT)).toThrow(
      SchemaDriftError,
    );
    expect(pick({ id: 'x', occurredAt: null }, CHANGE_RECORD)).toEqual({
      id: 'x',
      occurredAt: null,
    });
  });

  it('rejects any chain but Robinhood Chain 4663 with unsupported_chain', () => {
    const other = {
      slug: 'a',
      token: { chainId: 1, contractAddress: '0x0000000000000000000000000000000000000001' },
    };
    expect(() => pick(other, LISTING_INPUT)).toThrow(UnsupportedChainError);
    try {
      pick({ slug: 'a', token: { chainId: '4663' } }, LISTING_INPUT);
    } catch (error) {
      expect((error as UnsupportedChainError).code).toBe('unsupported_chain');
    }
  });

  it('strips bidirectional and zero-width characters from external text only', () => {
    expect(pick({ name: 'ab\u202Ec\u200Bd\nx' }, LISTING_INPUT)).toEqual({ name: 'abcd\nx' });
  });

  it('fails the write gate on a key outside the spec or a forbidden name', () => {
    expect(() => assertConforms({ slug: 'a', marketCap: 1 }, PROJECT_RECORD)).toThrow(
      ForbiddenFieldError,
    );
    expect(() => assertConforms({ slug: 'a', somethingNew: 1 }, PROJECT_RECORD)).toThrow(
      ForbiddenFieldError,
    );
    expect(() =>
      assertConforms({ coverage: { marketCurrent: { state: 'MEASURED' } } }, PROJECT_RECORD),
    ).toThrow(ForbiddenFieldError);
    expect(() =>
      assertConforms({ slug: 'a', token: { chainId: 4663 } }, PROJECT_RECORD),
    ).not.toThrow();
  });
});
