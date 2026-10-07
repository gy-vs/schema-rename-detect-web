// 字段名相似度：分词（camelCase / snake_case / kebab / 数字边界）、
// 复合词拆分（nickname -> nick name）、以及一份可审计的短小别名词表。
// 别名词表是工具自带的“可解释规则”，不是第三方匹配库；词表里命中了什么会写进评分明细。

/** 别名词组：组内任意两个词视为同义（0.95）。只放跨业务通用的一小撮，按需扩充。 */
const ALIAS_GROUPS: string[][] = [
  ['name', 'fullname', 'legalname'],
  ['nickname', 'displayname', 'moniker', 'handle'],
  ['zip', 'zipcode', 'postcode', 'postalcode'],
  ['customer', 'buyer', 'client', 'purchaser'],
];

const ALIAS_INDEX = new Map<string, number>();
ALIAS_GROUPS.forEach((group, i) => {
  for (const word of group) ALIAS_INDEX.set(word, i);
});

/** 复合词拆分词干（全小写匹配）。命中的复合词会被拆成多块，参与词面重合计算。 */
const COMPOUND_STEMS = [
  'display', 'full', 'legal', 'post', 'postal', 'zip', 'code',
  'first', 'last', 'given', 'family', 'middle', 'user', 'customer',
  'buyer', 'client', 'nick', 'street', 'house', 'home', 'phone',
  'mail', 'email', 'number', 'price', 'total', 'order', 'item',
  'shipping', 'billing', 'address',
];

/** 驼峰 / 下划线 / 连字符 / 数字边界切词，全小写。 */
export function tokenize(name: string): string[] {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.\s]+/g, ' ')
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-z])/gi, '$1 $2')
    .trim();
  if (!spaced) return [];
  return spaced
    .toLowerCase()
    .split(/\s+/)
    .flatMap(splitCompound)
    .filter(Boolean);
}

/** 贪心最长匹配拆复合词；拆不开时保留原词。确定顺序，结果可复现。 */
function splitCompound(word: string): string[] {
  if (word.length <= 3 || COMPOUND_STEMS.includes(word)) return [word];
  const stems = COMPOUND_STEMS.slice().sort((a, b) => b.length - a.length);
  const parts: string[] = [];
  let rest = word;
  let guard = 0;
  while (rest.length > 0 && guard++ < 8) {
    let matched: string | undefined;
    for (const stem of stems) {
      if (rest.startsWith(stem) && stem.length >= 3) {
        matched = stem;
        break;
      }
    }
    if (!matched) {
      parts.push(rest);
      break;
    }
    parts.push(matched);
    rest = rest.slice(matched.length);
  }
  return parts.length > 1 ? parts : [word];
}

/** 返回名称所属别名词组的下标；不属于任何组返回 undefined。 */
export function aliasGroupOf(name: string): number | undefined {
  return ALIAS_INDEX.get(name.toLowerCase());
}

/** 两个名称是否命中同一别名词组（整体名或任一词干命中即可）。供匹配预筛使用。 */
export function aliasRelated(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  const ga = ALIAS_INDEX.get(la);
  const gb = ALIAS_INDEX.get(lb);
  if (ga !== undefined && ga === gb) return true;
  for (const ta of tokenize(a)) {
    const g1 = ALIAS_INDEX.get(ta);
    if (g1 === undefined) continue;
    for (const tb of tokenize(b)) {
      if (ALIAS_INDEX.get(tb) === g1) return true;
    }
  }
  return false;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / new Set([...sa, ...sb]).size;
}

export interface NameSimilarity {
  score: number;
  detail: string;
  aliasHit?: string;
}

/**
 * 字段名综合相似度：
 * 1) 别名词表命中（组内 0.95）；
 * 2) 否则复合词分词后的 Jaccard；
 * 3) 全词 Levenshtein 比率；
 * 4) 完整包含奖励（postcode 包含 post+code、displayName 含 display 等）。
 */
export function nameSimilarity(a: string, b: string): NameSimilarity {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return {score: 1, detail: `名称完全相同：${a}`};

  const ga = ALIAS_INDEX.get(la);
  const gb = ALIAS_INDEX.get(lb);
  if (ga !== undefined && ga === gb) {
    return {
      score: 0.95,
      detail: `别名词表同组（${ALIAS_GROUPS[ga].join(' / ')}）：${a} ≈ ${b}`,
      aliasHit: ALIAS_GROUPS[ga].join('/'),
    };
  }

  const ta = tokenize(a);
  const tb = tokenize(b);
  const jac = jaccard(ta, tb);
  const lev = 1 - levenshtein(la, lb) / Math.max(la.length, lb.length);
  // 包含奖励：一方较短，且其所有词干都在另一方里（name -> fullName 这类加词改名）
  const setB = new Set(tb);
  const setA = new Set(ta);
  const aInB = ta.length > 0 && ta.every((t) => setB.has(t));
  const bInA = tb.length > 0 && tb.every((t) => setA.has(t));
  const containment = aInB || bInA ? 0.3 : 0;

  const blended = Math.max(jac * 0.6 + lev * 0.4, lev, jac) + containment;
  const score = Math.min(1, Number(blended.toFixed(4)));
  const detail =
    `分词 [${ta.join(' ')}] vs [${tb.join(' ')}]，词干重合 ${jac.toFixed(2)}，` +
    `编辑距离比率 ${lev.toFixed(2)}${containment ? '，包含奖励 +' + containment.toFixed(1) : ''}`;
  return {score, detail};
}
