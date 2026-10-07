import type {FieldNode, RunnerUp, ScoreFeature} from './types.js';
import {aliasGroupOf, aliasRelated, levenshtein, nameSimilarity, tokenize} from './names.js';
import {
  constSimilarity,
  depthSimilarity,
  enumSimilarity,
  examplesSimilarity,
  formatSimilarity,
  requiredSimilarity,
  siblingsSimilarityPrecomputed,
  siblingTokensOf,
  typesCompatible,
} from './features.js';

/** 入选门槛：低于总分的边不进指派，字段直接按新增/删除处理 */
export const SCORE_GATE = 0.45;

const WEIGHTS = {
  name: 0.28,
  type: 0.2,
  required: 0.04,
  enum: 0.1,
  format: 0.07,
  examples: 0.1,
  siblings: 0.1,
  depth: 0.06,
  const: 0.05,
} as const;

export interface Edge {
  oldPath: string;
  newPath: string;
  score: number;
  features: ScoreFeature[];
}

function feature(
  key: string,
  label: string,
  raw: number | null,
  weight: number,
  detail: string,
): ScoreFeature {
  return {key, label, raw, weight, contribution: raw === null ? 0 : raw * weight, detail};
}

/** 计算一对字段的全部评分维度；未提供的维度弃权，其权重按比例摊给在场维度。 */
export function scoreEdge(oldNode: FieldNode, newNode: FieldNode): Edge {
  return scoreEdgeWith(
    oldNode,
    newNode,
    siblingTokensOf(oldNode.siblings),
    siblingTokensOf(newNode.siblings),
  );
}

/** scoreEdge 的热点版本：兄弟字段 token 集合由调用方预算后传入。 */
function scoreEdgeWith(
  oldNode: FieldNode,
  newNode: FieldNode,
  oldSiblings: Set<string>,
  newSiblings: Set<string>,
): Edge {
  const name = nameSimilarity(oldNode.name, newNode.name);
  const type = typesCompatible(oldNode.types, newNode.types);
  const req = requiredSimilarity(oldNode.required, newNode.required);
  const en = enumSimilarity(oldNode.enumValues, newNode.enumValues);
  const fmt = formatSimilarity(oldNode.format, newNode.format);
  const ex = examplesSimilarity(oldNode.examples, newNode.examples);
  const sib = siblingsSimilarityPrecomputed(oldNode, newNode, oldSiblings, newSiblings);
  const dep = depthSimilarity(oldNode, newNode);
  const con = constSimilarity(oldNode.constValue, newNode.constValue);
  const features: ScoreFeature[] = [
    feature('name', '字段名', name.score, WEIGHTS.name, name.detail),
    feature(
      'type',
      '类型',
      type.ok ? (type.detail.includes('放宽') ? 0.9 : 1) : 0.1,
      WEIGHTS.type,
      type.detail,
    ),
    feature('required', 'required', req.score, WEIGHTS.required, req.detail),
    feature('enum', 'enum', en.score, WEIGHTS.enum, en.detail),
    feature('format', 'format', fmt.score, WEIGHTS.format, fmt.detail),
    feature('examples', 'examples 样例', ex.score, WEIGHTS.examples, ex.detail),
    feature('siblings', '兄弟字段', sib.score, WEIGHTS.siblings, sib.detail),
    feature('depth', '树中深度', dep.score, WEIGHTS.depth, dep.detail),
    feature('const', 'const', con.score, WEIGHTS.const, con.detail),
  ];
  const activeWeight = features
    .filter((f) => f.raw !== null)
    .reduce((sum, f) => sum + f.weight, 0);
  const rawSum = features.reduce((sum, f) => sum + f.contribution, 0);
  const score = activeWeight === 0 ? 0 : Number((rawSum / activeWeight).toFixed(4));
  return {oldPath: oldNode.path, newPath: newNode.path, score, features};
}

/**
 * O(n³) 匈牙利（Kuhn-Munkres）最小指派，输入为方阵（调用方负责补虚拟行列）。
 * 返回长度 n 的数组：p[r] = 指派到的列。
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const INF = Number.MAX_SAFE_INTEGER;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    const a = (r: number, c: number): number => cost[r][c];
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = a(i0 - 1, j - 1) - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const result = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    result[p[j] - 1] = j - 1;
  }
  return result;
}

const DUMMY_COST = Math.round((1 - SCORE_GATE) * 1000) + 5;

export interface MatchOutput {
  edges: Map<string, Edge>;
  pairs: {oldPath: string; newPath: string; edge: Edge}[];
  unmatchedOld: string[];
  unmatchedNew: string[];
  /** 被容器改名/移动覆盖的后代路径，不再单独列为候选或增删 */
  foldedOld: Set<string>;
  foldedNew: Set<string>;
}

function isUnder(childPath: string, parentPath: string): boolean {
  return childPath.startsWith(parentPath + '.') || childPath.startsWith(parentPath + '[');
}

const FOLD_LEAF_RATIO = 0.6;
const KEY_SEP = '⟂';
const edgeKey = (o: string, n: string) => `${o}${KEY_SEP}${n}`;

interface CheapInfo {
  lower: string;
  tokens: string[];
  tokenSet: Set<string>;
  head: string;
}

/**
 * 对两侧独有字段做一对一指派。
 * 指派阶段只用廉价的名称特征（节点级分词预算一次，避免 400+ 字段时的 O(n²) 昂贵打分）；
 * 完整特征（兄弟、examples 等）只对最终入选的少量边及每个入选边的次优备选补算。
 * - 数组项节点（path[]，名字固定为 []）不参与改名匹配；
 * - 容器配对且大部分叶子后代跟随到同一新容器时，整棵子树折叠；
 * - 一切选择按分数、路径排序确定，properties 书写顺序无影响。
 */
export function matchFields(oldNodes: FieldNode[], newNodes: FieldNode[]): MatchOutput {
  const poolOld = oldNodes.filter((n) => !n.isArrayItem);
  const poolNew = newNodes.filter((n) => !n.isArrayItem);
  const oldByPath = new Map(poolOld.map((n) => [n.path, n]));
  const newByPath = new Map(poolNew.map((n) => [n.path, n]));

  const oldOnly = poolOld.filter((n) => !newByPath.has(n.path));
  const newOnly = poolNew.filter((n) => !oldByPath.has(n.path));

  const cheapInfo = new Map<FieldNode, CheapInfo>();
  const infoOf = (node: FieldNode): CheapInfo => {
    const hit = cheapInfo.get(node);
    if (hit) return hit;
    const lower = node.name.toLowerCase();
    const tokens = tokenize(node.name);
    const head =
      lower
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^a-z0-9]+/)
        .filter(Boolean)[0] ?? '';
    const info: CheapInfo = {lower, tokens, tokenSet: new Set(tokens), head};
    cheapInfo.set(node, info);
    return info;
  };

  // 完整特征边打分；兄弟 token 集合在节点上预算一次，供 O(n²) 打分复用。
  const siblingTokens = new Map<FieldNode, Set<string>>();
  const siblingTokenSet = (node: FieldNode): Set<string> => {
    const hit = siblingTokens.get(node);
    if (hit) return hit;
    const set = siblingTokensOf(node.siblings);
    siblingTokens.set(node, set);
    return set;
  };

  /**
   * 指派用廉价名称分：
   * 1) 别名命中给近乎确定的 0.98（name/fullName、nickname/displayName 这类
   *    词面分不开、语义上确定的配对，依据来自可审计的别名词表）；
   * 2) 数字标记完全对齐（field_23_old ↔ field_23_new）给 0.9——大批量改名里最强信号；
   * 3) 去掉判别力差的公共词干后，剩余核心词干的 Jaccard / 编辑距离 / 包含。
   */
  const cheapNameScore = (o: FieldNode, n: FieldNode): number => {
    const io = infoOf(o);
    const ine = infoOf(n);
    if (io.lower === ine.lower) return 1;
    if (aliasRelated(o.name, n.name)) return 0.98;
    const digitsO = io.tokens.filter((t) => /^[0-9]+$/.test(t));
    const digitsN = ine.tokens.filter((t) => /^[0-9]+$/.test(t));
    if (
      digitsO.length > 0 &&
      digitsO.length === digitsN.length &&
      digitsO.every((d, i) => d === digitsN[i])
    ) {
      return 0.9;
    }
    const coreO = io.tokens.filter((t) => !commonTokens.has(t) && !/^[0-9]+$/.test(t));
    const coreN = ine.tokens.filter((t) => !commonTokens.has(t) && !/^[0-9]+$/.test(t));
    const so = new Set(coreO);
    let inter = 0;
    for (const t of coreN) if (so.has(t)) inter++;
    const union = coreO.length + coreN.length - inter;
    const coreJac = union === 0 ? 0 : inter / union;
    const lev =
      1 - levenshtein(io.lower, ine.lower) / Math.max(io.lower.length, ine.lower.length);
    const contained =
      (coreO.length > 0 && coreO.every((t) => coreN.includes(t))) ||
      (coreN.length > 0 && coreN.every((t) => coreO.includes(t)));
    // 共享开头词干（a_name ↔ aTitle 的 a，zip_code ↔ zipcode 的 zip）
    const headShared = coreO[0] && coreN[0] && coreO[0] === coreN[0] ? 0.25 : 0;
    return Math.min(1, Math.max(coreJac, lev) + headShared + (contained ? 0.3 : 0));
  };

  // ---- 稀疏候选产生 ----
  // 公共词干（出现在超过 15% 新字段名里，如 field/item）判别力差，不参与倒排连接；
  // 这类字段靠数字标记索引、3 字母前缀、全名包含/别名来配对。
  const tokenFrequency = new Map<string, number>();
  newOnly.forEach((n) => {
    for (const t of new Set(infoOf(n).tokens)) {
      tokenFrequency.set(t, (tokenFrequency.get(t) ?? 0) + 1);
    }
  });
  const commonTokens = new Set<string>();
  for (const [t, count] of tokenFrequency) {
    // 短词干（1-2 字母）即便高频也保留判别力（a_name ↔ aTitle 共享的 a）
    if (t.length >= 3 && count > Math.max(20, newOnly.length * 0.15)) commonTokens.add(t);
  }

  const byToken = new Map<string, number[]>();
  const byPrefix = new Map<string, number[]>();
  const byDigit = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  const byNamePrefix = new Map<string, number[]>();
  const byShortToken = new Map<string, number[]>();
  const addIndex = (map: Map<string, number[]>, key: string, idx: number) => {
    const arr = map.get(key);
    if (arr) arr.push(idx);
    else map.set(key, [idx]);
  };
  newOnly.forEach((n, ni) => {
    const info = infoOf(n);
    for (const t of info.tokens) {
      if (/^[0-9]+$/.test(t)) {
        addIndex(byDigit, t, ni);
      } else if (!commonTokens.has(t)) {
        addIndex(byToken, t, ni);
        if (t.length >= 2) {
          for (let len = 2; len <= t.length; len++) addIndex(byPrefix, t.slice(0, len), ni);
        }
      }
    }
    addIndex(byName, info.lower, ni);
    if (info.lower.length >= 2) addIndex(byNamePrefix, info.lower.slice(0, 2), ni);
    for (const t of info.tokens) {
      if (t.length === 1) addIndex(byShortToken, t, ni);
    }
  });

  // 新侧按别名词组建索引，旧字段只查自己所在组，避免 O(n²) 的别名词表扫描
  const newByAliasGroup = new Map<string, number[]>();
  newOnly.forEach((n, ni) => {
    const info = infoOf(n);
    const groups = new Set<number>();
    const gExact = aliasGroupOf(n.name);
    if (gExact !== undefined) groups.add(gExact);
    for (const t of info.tokenSet) {
      const g = aliasGroupOf(t);
      if (g !== undefined) groups.add(g);
    }
    groups.forEach((g) => {
      const arr = newByAliasGroup.get(String(g));
      if (arr) arr.push(ni);
      else newByAliasGroup.set(String(g), [ni]);
    });
  });

  /** 新侧中与旧字段名称互相包含，或别名同组的列（索引查询，不是全扫）。 */
  const aliasOrContainingCols = (o: FieldNode): number[] => {
    const info = infoOf(o);
    const cols = new Set<number>();
    const exact = byName.get(info.lower);
    exact?.forEach((ni) => cols.add(ni));
    const ownGroups = new Set<number>();
    const g0 = aliasGroupOf(o.name);
    if (g0 !== undefined) ownGroups.add(g0);
    for (const t of info.tokenSet) {
      const g = aliasGroupOf(t);
      if (g !== undefined) ownGroups.add(g);
    }
    ownGroups.forEach((g) => newByAliasGroup.get(String(g))?.forEach((ni) => cols.add(ni)));
    // 名称包含：用新侧全名做子串匹配（倒排难以表达包含；仅全名级、长度通常很短）
    for (const [name, indices] of byName) {
      if (name !== info.lower && (name.includes(info.lower) || info.lower.includes(name))) {
        indices.forEach((ni) => cols.add(ni));
      }
    }
    return [...cols];
  };

  const candidateCols = new Map<number, Set<number>>();
  const addCandidate = (oi: number, ni: number) => {
    let set = candidateCols.get(oi);
    if (!set) {
      set = new Set();
      candidateCols.set(oi, set);
    }
    set.add(ni);
  };
  oldOnly.forEach((o, oi) => {
    const consider = (ni: number) => {
      if (typesCompatible(o.types, newOnly[ni].types).ok) addCandidate(oi, ni);
    };
    const info = infoOf(o);
    let discriminativeHits = 0;
    for (const t of info.tokenSet) {
      if (/^[0-9]+$/.test(t)) {
        const before = candidateCols.get(oi)?.size ?? 0;
        byDigit.get(t)?.forEach(consider); // 数字标记对齐
        if ((candidateCols.get(oi)?.size ?? 0) > before) discriminativeHits++;
      } else if (!commonTokens.has(t)) {
        const before = candidateCols.get(oi)?.size ?? 0;
        byToken.get(t)?.forEach(consider);
        if (t.length >= 2) byPrefix.get(t.slice(0, 2))?.forEach(consider);
        if ((candidateCols.get(oi)?.size ?? 0) > before) discriminativeHits++;
      }
    }
    // 短词干（1 字符，如 a_name 的 a）单独建索引
    const shortToken = info.tokens.find((t) => t.length === 1 && !commonTokens.has(t));
    if (shortToken) byShortToken.get(shortToken)?.forEach(consider);
    const beforeFallback = candidateCols.get(oi)?.size ?? 0;
    aliasOrContainingCols(o).forEach(consider);
    const gotAliasHit = (candidateCols.get(oi)?.size ?? 0) > beforeFallback;
    // 兜底：判别词干、数字、短词干、别名/包含都没命中时，用全名 2 字母前缀
    if (discriminativeHits === 0 && !gotAliasHit && !shortToken && info.lower.length >= 2) {
      byNamePrefix.get(info.lower.slice(0, 2))?.forEach(consider);
    }
  });

  // 两阶段打分，保证正确性也保证性能：
  // 阶段1：稀疏候选上算廉价名称分，每侧只保留 top-K（K 足够大，不会误杀正确配对），
  //        公共词干/数字对齐保证大批量改名时每侧候选数仍然稀疏；
  // 阶段2：仅对保留下来的边算完整特征（兄弟/examples 等），指派以完整分为准，
  //        这样一对一全局最优与面板上看到的分数完全一致、可追溯。
  const TOP_K = 30;
  const cheapEdgeScore = new Map<string, number>();
  const bestByOld = new Map<number, {ni: number; s: number}[]>();
  const bestByNew = new Map<number, {ni: number; oi: number; s: number}[]>();
  for (const [oiStr, cols] of candidateCols) {
    const oi = Number(oiStr);
    for (const ni of cols) {
      const s = cheapNameScore(oldOnly[oi], newOnly[ni]);
      if (s < SCORE_GATE) continue;
      cheapEdgeScore.set(`${oi}${KEY_SEP}${ni}`, s);
      const bo = bestByOld.get(oi) ?? [];
      bo.push({ni, s});
      bestByOld.set(oi, bo);
      const bn = bestByNew.get(ni) ?? [];
      bn.push({oi, ni, s});
      bestByNew.set(ni, bn);
    }
  }
  const keptEdges = new Set<string>();
  for (const [oi, arr] of bestByOld) {
    arr
      .sort((a, b) => b.s - a.s)
      .slice(0, TOP_K)
      .forEach(({ni}) => keptEdges.add(`${oi}${KEY_SEP}${ni}`));
  }
  for (const [, arr] of bestByNew) {
    arr
      .sort((a, b) => b.s - a.s)
      .slice(0, TOP_K)
      .forEach(({oi, ni}) => keptEdges.add(`${oi}${KEY_SEP}${ni}`));
  }

  // 阶段2：完整特征边
  const edges = new Map<string, Edge>();
  for (const key of keptEdges) {
    const [oiStr, niStr] = key.split(KEY_SEP);
    const oi = Number(oiStr);
    const ni = Number(niStr);
    const edge = scoreEdgeWith(
      oldOnly[oi],
      newOnly[ni],
      siblingTokenSet(oldOnly[oi]),
      siblingTokenSet(newOnly[ni]),
    );
    if (edge.score >= SCORE_GATE) edges.set(edgeKey(oldOnly[oi].path, newOnly[ni].path), edge);
  }

  const size = Math.max(oldOnly.length, newOnly.length);
  const FORBIDDEN = DUMMY_COST + 50;
  const indexOfOld = new Map(oldOnly.map((n, i) => [n.path, i]));
  const matrix: number[][] = Array.from({length: size}, (_, r) =>
    Array.from({length: size}, (_, c) => {
      if (r >= oldOnly.length && c >= newOnly.length) return FORBIDDEN;
      if (r >= oldOnly.length || c >= newOnly.length) return DUMMY_COST;
      const e = edges.get(edgeKey(oldOnly[r].path, newOnly[c].path));
      return e ? Math.round((1 - e.score) * 1000) : FORBIDDEN;
    }),
  );
  const assigned = hungarian(matrix);

  const pairs: MatchOutput['pairs'] = [];
  const matchedOld = new Set<string>();
  const matchedNew = new Set<string>();
  assigned.forEach((colIdx, rowIdx) => {
    if (rowIdx >= oldOnly.length || colIdx >= newOnly.length) return;
    const edge = edges.get(edgeKey(oldOnly[rowIdx].path, newOnly[colIdx].path));
    if (!edge) return;
    pairs.push({oldPath: edge.oldPath, newPath: edge.newPath, edge});
    matchedOld.add(edge.oldPath);
    matchedNew.add(edge.newPath);
  });

  // 给落选备选补算：若入选旧字段的次优边在阶段1被 top-K 剪掉，这里补回来（每边最多 3 条）
  for (const pair of pairs) {
    const oi = indexOfOld.get(pair.oldPath)!;
    const alts: {ni: number; s: number}[] = [];
    for (const [oiStr, cols] of candidateCols) {
      if (Number(oiStr) !== oi) continue;
      for (const ni of cols) {
        if (newOnly[ni].path === pair.newPath) continue;
        const s = cheapEdgeScore.get(`${oi}${KEY_SEP}${ni}`);
        if (s !== undefined) alts.push({ni, s});
      }
    }
    alts
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .forEach(({ni}) => {
        const key = edgeKey(oldOnly[oi].path, newOnly[ni].path);
        if (!edges.has(key)) {
          const edge = scoreEdgeWith(
            oldOnly[oi],
            newOnly[ni],
            siblingTokenSet(oldOnly[oi]),
            siblingTokenSet(newOnly[ni]),
          );
          edges.set(key, edge);
        }
      });
  }

  // 容器改名折叠
  const foldedOld = new Set<string>();
  const foldedNew = new Set<string>();
  const keptPairs: typeof pairs = [];
  for (const pair of pairs) {
    const o = oldByPath.get(pair.oldPath)!;
    const isContainer = o.types.some((t) => t === 'object' || t === 'array');
    if (isContainer) {
      const oldLeaves = poolOld.filter(
        (node) =>
          isUnder(node.path, o.path) &&
          !node.types.some((t) => t === 'object' || t === 'array'),
      );
      if (oldLeaves.length > 0) {
        let followed = 0;
        for (const leaf of oldLeaves) {
          const p = pairs.find((pp) => pp.oldPath === leaf.path);
          if (p && isUnder(p.newPath, pair.newPath)) followed++;
        }
        if (followed / oldLeaves.length >= FOLD_LEAF_RATIO) {
          for (const nn of poolOld) if (isUnder(nn.path, o.path)) foldedOld.add(nn.path);
          for (const nn of poolNew)
            if (isUnder(nn.path, pair.newPath)) foldedNew.add(nn.path);
        }
      }
    }
    keptPairs.push(pair);
  }
  const finalPairs = keptPairs.filter(
    (p) => !foldedOld.has(p.oldPath) && !foldedNew.has(p.newPath),
  );

  // 落选备选从已完整打分的边里直接取（scoreEdge 只对过门的边算过，数量可控）
  return {
    edges,
    pairs: finalPairs,
    unmatchedOld: oldOnly
      .map((n) => n.path)
      .filter((p) => !matchedOld.has(p) && !foldedOld.has(p))
      .sort(),
    unmatchedNew: newOnly
      .map((n) => n.path)
      .filter((p) => !matchedNew.has(p) && !foldedNew.has(p))
      .sort(),
    foldedOld,
    foldedNew,
  };
}

/** 给入选候选挑落选备选：同一旧字段的次优新字段（注明是否被别的旧字段占走）。 */
export function runnerUpsFor(
  oldPath: string,
  newPath: string,
  score: number,
  edges: Map<string, Edge>,
  pairs: MatchOutput['pairs'],
  limit = 2,
): RunnerUp[] {
  const occupiedBy = new Map<string, string>();
  for (const p of pairs) occupiedBy.set(p.newPath, p.oldPath);
  const alts: Edge[] = [];
  for (const e of edges.values()) {
    if (e.oldPath !== oldPath || e.newPath === newPath) continue;
    alts.push(e);
  }
  alts.sort((a, b) => b.score - a.score || (a.newPath < b.newPath ? -1 : 1));
  return alts.slice(0, limit).map((e) => {
    const occupant = occupiedBy.get(e.newPath);
    return {
      oldPath: e.oldPath,
      newPath: e.newPath,
      score: e.score,
      gap: Number((score - e.score).toFixed(4)),
      reason:
        occupant && occupant !== oldPath
          ? `总分低 ${(score - e.score).toFixed(3)}，且该新字段已与 ${occupant} 配对（一对一）`
          : `总分低 ${(score - e.score).toFixed(3)}，未入选`,
    };
  });
}
