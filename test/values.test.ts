import {describe, expect, it} from 'vitest';
import {classify, classSimilarity, exampleSetsSimilarity} from '../src/core/values';

describe('examples 分类', () => {
  it('识别字符串格式', () => {
    expect(classify('a@b.com').pattern).toBe('email');
    expect(classify('2026-09-01').pattern).toBe('date');
    expect(classify('100080').pattern).toBe('text');
  });

  it('同类样例相似度高，跨类为 0', () => {
    expect(classSimilarity(classify('a@b.com'), classify('c@d.org'))).toBe(1);
    expect(classSimilarity(classify('a@b.com'), classify('2026-09-01'))).toBeLessThan(0.2);
    expect(classSimilarity(classify(12), classify(15))).toBe(1);
    expect(classSimilarity(classify(12), classify('12'))).toBe(0);
  });

  it('对象按键重合判断', () => {
    const similarity = classSimilarity(
      classify({street: 'x', zip: '1'}),
      classify({street: 'y', city: 'z'}),
    );
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });

  it('exampleSetsSimilarity 两边都没有时返回 null（打分层转中性）', () => {
    expect(exampleSetsSimilarity([], [])).toBeNull();
    expect(exampleSetsSimilarity(['a@b.com'], ['c@d.com'])).toBe(1);
  });
});
