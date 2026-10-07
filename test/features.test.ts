import {describe, expect, it} from 'vitest';
import {nameSimilarity, tokenize} from '../src/engine/names';
import {
  typesCompatible,
  enumSimilarity,
  examplesSimilarity,
} from '../src/engine/features';

describe('nameSimilarity', () => {
  it('别名同组得高分，跨组不得高分', () => {
    expect(nameSimilarity('name', 'fullName').score).toBeGreaterThan(0.8);
    expect(nameSimilarity('nickname', 'displayName').score).toBeGreaterThan(0.7);
    expect(nameSimilarity('zip', 'postcode').score).toBeGreaterThan(0.8);
    expect(nameSimilarity('customer', 'buyer').score).toBeGreaterThan(0.8);
  });

  it('tokenize 正确拆驼峰和复合词', () => {
    expect(tokenize('fullName')).toEqual(['full', 'name']);
    expect(tokenize('displayName')).toEqual(['display', 'name']);
    expect(tokenize('nickname')).toEqual(['nick', 'name']);
    expect(tokenize('postal_code')).toEqual(['postal', 'code']);
    expect(tokenize('shippingAddress2')).toEqual(['shipping', 'address', '2']);
  });

  it('完全无关的名称得分很低', () => {
    expect(nameSimilarity('zip', 'color').score).toBeLessThan(0.3);
  });
});

describe('typesCompatible', () => {
  it('integer 到 number 兼容，反向不兼容', () => {
    expect(typesCompatible(['integer'], ['number']).ok).toBe(true);
    expect(typesCompatible(['number'], ['integer']).ok).toBe(false);
  });
  it('string 到 integer 不兼容', () => {
    expect(typesCompatible(['string'], ['integer']).ok).toBe(false);
  });
  it('同类型兼容', () => {
    expect(typesCompatible(['string'], ['string']).ok).toBe(true);
  });
});

describe('enumSimilarity', () => {
  it('收窄到部分取值得低分', () => {
    expect(enumSimilarity(['a', 'b', 'c'], ['a']).score).toBeCloseTo(1 / 3);
  });
  it('超集放宽得部分分', () => {
    expect(enumSimilarity(['a'], ['a', 'b']).score).toBeCloseTo(0.5);
  });
  it('两侧都没有 enum 时弃权', () => {
    expect(enumSimilarity(undefined, undefined).score).toBeNull();
  });
});

describe('examplesSimilarity', () => {
  it('样例是同一类东西时高分', () => {
    expect(examplesSimilarity(['100000'], ['200000']).score).toBe(1);
  });
  it('字符串和数字不是一类', () => {
    expect(examplesSimilarity(['abc'], [123]).score).toBe(0);
  });
  it('没写 examples 的字段弃权（不惩罚）', () => {
    expect(examplesSimilarity([], []).score).toBeNull();
  });
});
