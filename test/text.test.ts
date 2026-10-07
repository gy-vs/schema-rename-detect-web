import {describe, expect, it} from 'vitest';
import {
  commonSubstringSimilarity,
  jaccard,
  levenshteinSimilarity,
  nameSimilarity,
  tokenize,
  tokenSetSimilarity,
} from '../src/core/text';

describe('tokenize', () => {
  it('拆分 camelCase / snake / kebab', () => {
    expect(tokenize('customer_name')).toEqual(['customer', 'name']);
    expect(tokenize('buyerName')).toEqual(['buyer', 'name']);
    expect(tokenize('postal-code')).toEqual(['postal', 'code']);
    expect(tokenize('HTTPServerPort')).toEqual(['http', 'server', 'port']);
  });
});

describe('nameSimilarity 事故场景', () => {
  const score = (a: string, b: string) => nameSimilarity(a, tokenize(a), b, tokenize(b)).score;

  it('customer_name vs buyerName 有共享词根 name', () => {
    const value = score('customer_name', 'buyerName');
    expect(value).toBeGreaterThan(0.3);
  });

  it('name 与 fullName 的相似度高于 name 与 displayName', () => {
    const fullName = score('name', 'fullName');
    const displayName = score('name', 'displayName');
    expect(fullName).toBeGreaterThan(displayName);
  });

  it('nickname 与 displayName 的相似度不低于 nickname 与 fullName（接近时由全局一对一分配定胜负）', () => {
    const displayName = score('nickname', 'displayName');
    const fullName = score('nickname', 'fullName');
    expect(displayName).toBeGreaterThanOrEqual(fullName - 0.02);
  });

  it('zip vs postcode 仍能拿到候选级分数（公共词根弱，但兄弟/位置会救）', () => {
    const value = score('zip', 'postcode');
    expect(value).toBeGreaterThan(0);
  });

  it('完全不相关的名称分数很低', () => {
    expect(score('orderId', 'street')).toBeLessThan(0.2);
  });
});

describe('基础字符串指标', () => {
  it('levenshtein 归一化', () => {
    expect(levenshteinSimilarity('abc', 'abc')).toBe(1);
    expect(levenshteinSimilarity('full', 'fullname')).toBeCloseTo(4 / 8, 5);
  });
  it('公共词根', () => {
    expect(commonSubstringSimilarity('full', 'fullname')).toBe(1);
    expect(commonSubstringSimilarity('abc', 'xyz')).toBe(0);
  });
  it('jaccard', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
    expect(jaccard([], [])).toBe(0.5);
  });
  it('tokenSetSimilarity', () => {
    expect(tokenSetSimilarity(['name'], ['full', 'name'])).toBeCloseTo(0.5);
  });
});
