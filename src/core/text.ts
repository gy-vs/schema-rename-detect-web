/**
 * 名称相似度：分词集合 + 编辑距离 + 最长公共子串，三个子信号都可追溯。
 */

/** camelCase / PascalCase / kebab / snake / 字母数字边界 统一拆词 */
export function tokenize(name: string): string[] {
  const withSpaces = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/[_.\-]+/g, ' ');
  return withSpaces
    .split(/\s+/)
    .map(token => token.toLowerCase())
    .filter(Boolean);
}

export function tokenSetSimilarity(aTokens: string[], bTokens: string[]): number {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  // Jaccard
  let union = a.size + b.size - common;
  return union === 0 ? 0 : common / union;
}

/** 归一化 Levenshtein 相似度 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 最长公共子串长度 / 较短串长度，专门奖励共享词根（full/fullName 这类） */
export function commonSubstringSimilarity(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  if (shorter === 0) return 0;
  let best = 0;
  // 滚动行 DP，记录以 (i,j) 结尾的公共串长度
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best / shorter;
}

export interface NameSimilarity {
  score: number;
  tokenSet: number;
  levenshtein: number;
  commonSubstring: number;
  tokenContainment: number;
  suffix: number;
}

/** 词尾重合：共享较长的结尾（fullName/displayName 都以 name 结尾）。 */
export function commonSuffixSimilarity(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  if (shorter === 0) return 0;
  let count = 0;
  for (let i = 0; i < shorter; i++) {
    if (a[a.length - 1 - i] === b[b.length - 1 - i]) count += 1;
    else break;
  }
  return count / shorter;
}

/**
 * 名称总分（0..1）：
 * - 分词集合 0.3（Jaccard）
 * - 词包含 0.1：一方的词被另一方完整包含（name vs fullName 这类“加前缀/后缀”扩展）
 * - 词尾后缀 0.25（fullName/displayName 都以 name 结尾，nickname/displayName 共享 name 尾）
 * - 最长公共子串 0.15（任意位置共享词根）
 * - 编辑距离 0.2
 */
export function nameSimilarity(aName: string, aTokens: string[], bName: string, bTokens: string[]): NameSimilarity {
  const a = aName.toLowerCase();
  const b = bName.toLowerCase();
  const tokenSet = round3(tokenSetSimilarity(aTokens, bTokens));
  const containment = round3(tokenContainment(aTokens, bTokens));
  const lev = round3(levenshteinSimilarity(a, b));
  const sub = round3(commonSubstringSimilarity(a, b));
  const suffix = round3(commonSuffixSimilarity(a, b));
  const score = round3(0.3 * tokenSet + 0.1 * containment + 0.25 * suffix + 0.15 * sub + 0.2 * lev);
  return {score, tokenSet, levenshtein: lev, commonSubstring: sub, tokenContainment: containment, suffix};
}

/** 较短一方的词是否被较长一方完整包含（name ⊆ {full,name}）；两边等长退化为 Jaccard */
function tokenContainment(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === b.size) return tokenSetSimilarity(aTokens, bTokens);
  const small = a.size < b.size ? a : b;
  const large = a.size < b.size ? b : a;
  let covered = 0;
  for (const token of small) if (large.has(token)) covered += 1;
  return covered / small.size;
}

/** 集合 Jaccard（兄弟字段、enum 值等） */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0.5; // 都没有 -> 中性
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  for (const value of setA) if (setB.has(value)) common += 1;
  const union = setA.size + setB.size - common;
  return union === 0 ? 0 : common / union;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
