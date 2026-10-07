/**
 * examples 样例分类：没有 examples 的字段也会被当成中性候选，
 * 有 examples 时按“是不是一类东西”给出 0..1 相似度。
 */
import {ValueClass} from './types';

const STRING_PATTERNS: Array<{name: string; re: RegExp}> = [
  {name: 'email', re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/},
  {name: 'uuid', re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i},
  {name: 'date', re: /^\d{4}-\d{2}-\d{2}$/},
  {name: 'datetime', re: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/},
  {name: 'phone', re: /^[+()\-\s0-9]{7,20}$/},
  {name: 'url', re: /^https?:\/\//},
];

function lengthBucket(length: number): number {
  if (length <= 8) return 0;
  if (length <= 16) return 1;
  if (length <= 32) return 2;
  if (length <= 64) return 3;
  return 4;
}

function magnitudeBucket(value: number): number {
  const abs = Math.abs(value);
  if (abs < 10) return 0;
  if (abs < 100) return 1;
  if (abs < 1000) return 2;
  if (abs < 1_000_000) return 3;
  return 4;
}

export function classify(value: unknown): ValueClass {
  if (value === null) return {kind: 'null'};
  const type = Array.isArray(value) ? 'array' : typeof value;
  if (type === 'boolean') return {kind: 'boolean'};
  if (type === 'number') {
    return {
      kind: Number.isInteger(value as number) ? 'integer' : 'number',
      magnitudeBucket: magnitudeBucket(value as number),
      integerLike: Number.isInteger(value as number),
    };
  }
  if (type === 'string') {
    const s = value as string;
    let pattern = 'text';
    for (const candidate of STRING_PATTERNS) {
      if (candidate.re.test(s)) {
        pattern = candidate.name;
        break;
      }
    }
    return {kind: 'string', pattern, lengthBucket: lengthBucket(s.length)};
  }
  if (type === 'array') {
    return {kind: 'array', elements: (value as unknown[]).slice(0, 5).map(classify)};
  }
  return {
    kind: 'object',
    keys: Object.keys(value as Record<string, unknown>).sort(),
  };
}

/** 两类样例是否“一类东西” */
export function classSimilarity(a: ValueClass, b: ValueClass): number {
  if (a.kind === 'null' || b.kind === 'null') return a.kind === b.kind ? 1 : 0;
  // integer / number：数值类互通，数量级桶相邻给部分分
  if ((a.kind === 'integer' || a.kind === 'number') && (b.kind === 'integer' || b.kind === 'number')) {
    if (a.magnitudeBucket === b.magnitudeBucket) return 1;
    if (Math.abs((a.magnitudeBucket ?? 0) - (b.magnitudeBucket ?? 0)) === 1) return 0.6;
    return 0.25;
  }
  if (a.kind !== b.kind) return 0;
  if (a.kind === 'boolean') return 1;
  if (a.kind === 'string') {
    if (a.pattern !== b.pattern) {
      // 都是普通文本：长度桶相邻给部分分
      if (a.pattern === 'text' && b.pattern === 'text') {
        return a.lengthBucket === b.lengthBucket ? 0.7 : 0.4;
      }
      return 0.1; // uuid vs email 这种，基本不是一类
    }
    return a.pattern === 'text'
      ? a.lengthBucket === b.lengthBucket
        ? 0.85
        : 0.55
      : 1; // 同一种格式（email/date/...）
  }
  if (a.kind === 'object') {
    const ka = new Set(a.keys ?? []);
    const kb = new Set(b.keys ?? []);
    if (ka.size === 0 || kb.size === 0) return 0.5;
    let common = 0;
    for (const key of ka) if (kb.has(key)) common += 1;
    return common / (ka.size + kb.size - common);
  }
  // array：按元素两两的最大相似度取平均
  const ea = a.elements ?? [];
  const eb = b.elements ?? [];
  if (ea.length === 0 || eb.length === 0) return 0.5;
  let total = 0;
  for (const x of ea) {
    let best = 0;
    for (const y of eb) best = Math.max(best, classSimilarity(x, y));
    total += best;
  }
  return total / ea.length;
}

/** 两组 examples 之间的相似度：每个旧样例找最像的新样例，再平均 */
export function exampleSetsSimilarity(a: unknown[], b: unknown[]): number | null {
  if (a.length === 0 && b.length === 0) return null;
  const ca = a.map(classify);
  const cb = b.map(classify);
  if (ca.length === 0 || cb.length === 0) return 0.5; // 一边有一边没有：中性偏怀疑
  let total = 0;
  for (const x of ca) {
    let best = 0;
    for (const y of cb) best = Math.max(best, classSimilarity(x, y));
    total += best;
  }
  return total / ca.length;
}
