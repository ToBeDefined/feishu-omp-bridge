import { describe, expect, it } from 'vitest';
import { chooseSigningIdentity, parseSigningIdentities } from './macos-supervisor';

// 全部为虚构示例：仓库里绝不出现任何真实证书名 / 邮箱 / 团队 ID。
const SAMPLE = `  1) 1111111111111111111111111111111111111111 "Apple Development: dev-one@example.com (AAAAAAA111)"
  2) 2222222222222222222222222222222222222222 "Apple Development: dev-two@example.org (BBBBBBB222)"
  3) 3333333333333333333333333333333333333333 "Apple Distribution: Example Distribution Ltd (CCCCCCC333)"
  4) 4444444444444444444444444444444444444444 "Developer ID Application: Example Corp (DDDDDDD444)"
  5) 5555555555555555555555555555555555555555 "Mac Developer: legacy@example.net (EEEEEEE555)"
     7 valid identities found
`;

describe('parseSigningIdentities', () => {
  it('prefers longer-lived identities so the signature — and the Local Network grant — stays valid', () => {
    expect(parseSigningIdentities(SAMPLE)).toEqual([
      'Developer ID Application: Example Corp (DDDDDDD444)',
      'Apple Development: dev-one@example.com (AAAAAAA111)',
      'Apple Development: dev-two@example.org (BBBBBBB222)',
      'Mac Developer: legacy@example.net (EEEEEEE555)',
    ]);
  });

  it('keeps keychain order within the same identity class so the choice is stable', () => {
    const swapped = SAMPLE.replace(
      '  1) 1111111111111111111111111111111111111111 "Apple Development: dev-one@example.com (AAAAAAA111)"',
      '  1) 1111111111111111111111111111111111111111 "Apple Development: third@example.com (FFFFFFF666)"',
    );
    expect(parseSigningIdentities(swapped)[1]).toBe('Apple Development: third@example.com (FFFFFFF666)');
  });

  it('ignores non-codesigning lines and empty keychains', () => {
    expect(parseSigningIdentities('     0 valid identities found\n')).toEqual([]);
    expect(parseSigningIdentities('')).toEqual([]);
  });
});

describe('chooseSigningIdentity', () => {
  // 用元组（as const）而非解析结果，避免 noUncheckedIndexedAccess 下的 undefined。
  const keychain = [
    'Developer ID Application: Example Corp (DDDDDDD444)',
    'Apple Development: dev-one@example.com (AAAAAAA111)',
    'Apple Development: dev-two@example.org (BBBBBBB222)',
    'Mac Developer: legacy@example.net (EEEEEEE555)',
  ] as const;
  const pinned = keychain[2];

  it('honours FOB_MACOS_SIGN_IDENTITY over everything else', () => {
    expect(chooseSigningIdentity({ envValue: pinned, cached: keychain[1], keychain: [...keychain] })).toEqual({
      identity: pinned,
      source: 'env',
    });
  });

  it('keeps the pinned identity even when the keychain order changes', () => {
    const reordered = [keychain[2], keychain[0], keychain[1], keychain[3]];
    expect(chooseSigningIdentity({ cached: pinned, keychain: reordered })).toEqual({
      identity: pinned,
      source: 'cache',
    });
  });

  it('falls back to the best keychain identity only when the pinned cert is gone', () => {
    expect(chooseSigningIdentity({ cached: pinned, keychain: [keychain[0], keychain[3]] })).toEqual({
      identity: keychain[0],
      source: 'keychain',
    });
  });

  it('treats ad-hoc sentinels as an explicit opt-out of a stable identity', () => {
    expect(chooseSigningIdentity({ envValue: '-', cached: pinned, keychain: [...keychain] })).toEqual({ source: 'env' });
    expect(chooseSigningIdentity({ cached: 'ad-hoc', keychain: [...keychain] })).toEqual({ source: 'cache' });
  });

  it('reports no identity when the keychain has none', () => {
    expect(chooseSigningIdentity({ keychain: [] })).toEqual({ source: 'none' });
  });
});
