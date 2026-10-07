/**
 * 跨版本字段匹配。
 *
 * 候选依据（每一条都在 features 里给出原始分和说明）：
 * 名称分词/词根、类型兼容、required 一致性、enum 集合、format、
 * 在树里的深度与位置、兄弟字段像不像、examples 是不是一类东西。
 * 没有 examples 的字段拿中性分，仍可以出候选。
 *
 * 一个新字段最多归一个旧字段：用匈牙利算法做全局一对一最优分配。
 * 分配之外保留 runnerUps（旧字段的备选新字段）和 competitors（抢同一个新字段的旧字段），
 * 对分数接近、最终落选的配对给出反事实解释（如果硬配，全局总分会差多少）。
 */
import {
  AlternativeEdge,
  AssignmentNote,
  FeatureScore,
  FieldRecord,
  PairAnalysis,
  Proposal,
  SamePathChange,
} from './types';
import {jaccard, nameSimilarity, round3, tokenize} from './text';
import {exampleSetsSimilarity} from './values';
import {typeTransition, typeChangeIsBlocker} from './types-compat';

const WEIGHTS = {
  name: 38,
  sibling: 18,
  type: 14,
  structure: 10,
  required: 6,
  enum: 6,
  format: 4,
  examples: 4,
} as const;

/** 低于此分的边不进入一对一分配，但仍可能作为“备选”出现 */
const CANDIDATE_THRESHOLD = 35;
/** 备选差距在此范围内才详细解释为什么落选 */
const CLOSE_GAP = 10;
/** 每个旧字段最多做完整打分的候选数（先按便宜信号排序截断） */
const MAX_FULL_SCORE_PER_OLD = 8;
/** 倒排没召回到时的兜底候选数（短名/无分词字段） */
const FALLBACK_PER_FIELD = 6;
/** 小版本对直接全量打分，保证小 schema 结果精确 */
const EXHAUSTIVE_LIMIT = 2500;

interface Edge {
  oldIndex: number;
  newIndex: number;
  score: number;
  features: FeatureScore[];
}

/** 轻量名称信号：只算一次，建索引复用，避免在大笛卡尔积上跑编辑距离 */
function lightNameScore(oldField: FieldRecord, newField: FieldRecord): number {
  const nameResult = nameSimilarity(oldField.name, oldField.nameTokens, newField.name, newField.nameTokens);
  return nameResult.score;
}

function feature(key: string, label: string, weight: number, score: number, detail: string): FeatureScore {
  return {
    key,
    label,
    weight,
    score: round3(score),
    contribution: Math.round(weight * score),
    detail,
  };
}

/**
 * 语料级词频权重：某个兄弟/祖先词在多少个字段的环境里出现。
 * 小组里的兄弟词（address 组的 street/city）很稀有、判别力强；
 * 大组里人人共享的词（24 个字段互为兄弟的 fieldN）判别力弱，
 * 不能把同组里毫不相干的字段抬成候选。
 */
export interface CorpusIdf {
  df: Map<string, number>;
  docCount: number;
}

export function buildCorpusIdf(...fieldGroups: FieldRecord[][]): CorpusIdf {
  const df = new Map<string, number>();
  // 以“字段环境”为文档：兄弟词集合 ∪ 祖先词集合
  const all = new Set<FieldRecord>();
  for (const fields of fieldGroups) for (const field of fields) all.add(field);
  for (const field of all) {
    const words = new Set<string>([...siblingTokensOf(field), ...ancestorTokens(field)]);
    for (const word of words) df.set(word, (df.get(word) ?? 0) + 1);
  }
  return {df, docCount: all.size};
}

function idfWeight(word: string, corpus: CorpusIdf): number {
  const freq = corpus.df.get(word) ?? 0;
  if (freq === 0) return 1;
  return Math.log((corpus.docCount + 1) / (freq + 1)) + 1;
}

/** IDF 加权的词集合重合度（替代朴素 jaccard，给稀有环境词更高判别力） */
function weightedOverlap(aTokens: string[], bTokens: string[], corpus: CorpusIdf): number {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 0.5;
  if (a.size === 0 || b.size === 0) return 0;
  let commonWeight = 0;
  let smallerTotalWeight = 0;
  const small = a.size <= b.size ? a : b;
  for (const token of small) {
    const weight = idfWeight(token, corpus);
    smallerTotalWeight += weight;
    if (a.has(token) && b.has(token)) commonWeight += weight;
  }
  return smallerTotalWeight === 0 ? 0 : commonWeight / smallerTotalWeight;
}

function scoreEdge(oldField: FieldRecord, newField: FieldRecord, corpus: CorpusIdf): Edge {
  const features: FeatureScore[] = [];

  // 1) 名称
  const nameResult = nameSimilarity(oldField.name, oldField.nameTokens, newField.name, newField.nameTokens);
  features.push(
    feature(
      'name',
      '名称相似度',
      WEIGHTS.name,
      nameResult.score,
      `分词 ${formatTokens(oldField.nameTokens)} vs ${formatTokens(newField.nameTokens)}；` +
        `词集合 ${(nameResult.tokenSet * 100).toFixed(0)}%，` +
        `词包含 ${(nameResult.tokenContainment * 100).toFixed(0)}%，` +
        `词尾重合 ${(nameResult.suffix * 100).toFixed(0)}%，` +
        `公共子串 ${(nameResult.commonSubstring * 100).toFixed(0)}%，` +
        `编辑距离 ${(nameResult.levenshtein * 100).toFixed(0)}%`,
    ),
  );

  // 2) 类型
  const transition = typeTransition(oldField.types, newField.types);
  let typeScore = 0.5;
  let typeDetail = '';
  switch (transition) {
    case 'same':
      typeScore = oldField.types.length === 0 ? 0.5 : 1;
      typeDetail =
        oldField.types.length === 0 ? '两边都未声明类型，给中性分' : `类型一致：${oldField.types.join('|')}`;
      break;
    case 'widened':
      typeScore = 0.85;
      typeDetail = `${oldField.types.join('|')} -> ${newField.types.join('|')} 是放宽，兼容`;
      break;
    case 'narrowed':
      typeScore = 0.1;
      typeDetail = `${oldField.types.join('|')} -> ${newField.types.join('|')} 是收窄，旧数据可能放不下`;
      break;
    case 'changed':
      typeScore = 0;
      typeDetail = `${oldField.types.join('|')} -> ${newField.types.join('|')} 跨类型变化，不兼容`;
      break;
    case 'untyped':
      typeScore = 0.5;
      typeDetail = '两边都未声明类型，给中性分';
      break;
  }
  features.push(feature('type', '类型兼容性', WEIGHTS.type, typeScore, typeDetail));

  // 3) required 一致性
  const requiredScore = oldField.required === newField.required ? 1 : 0;
  features.push(
    feature(
      'required',
      'required 一致性',
      WEIGHTS.required,
      requiredScore,
      `旧 ${oldField.required ? '必填' : '可选'}，新 ${newField.required ? '必填' : '可选'}`,
    ),
  );

  // 4) enum 集合
  let enumScore = 0.5;
  let enumDetail = '';
  if (oldField.enumValues.length === 0 && newField.enumValues.length === 0) {
    enumScore = 0.5;
    enumDetail = '两边都没有 enum，中性';
  } else if (oldField.enumValues.length === 0 || newField.enumValues.length === 0) {
    enumScore = 0.3;
    enumDetail = '仅一侧声明了 enum，约束不对称';
  } else {
    enumScore = jaccard(oldField.enumValues, newField.enumValues);
    const removed = oldField.enumValues.filter(v => !newField.enumValues.includes(v));
    const added = newField.enumValues.filter(v => !oldField.enumValues.includes(v));
    enumDetail =
      `enum 重合 ${(enumScore * 100).toFixed(0)}%` +
      (removed.length ? `；新版移除 ${removed.length} 个取值` : '') +
      (added.length ? `；新增 ${added.length} 个取值` : '');
    enumScore = round3(enumScore);
  }
  features.push(feature('enum', 'enum 取值', WEIGHTS.enum, enumScore, enumDetail));

  // 5) format
  let formatScore = 0.5;
  let formatDetail = '';
  if (!oldField.format && !newField.format) {
    formatScore = 0.5;
    formatDetail = '两边都没有 format，中性';
  } else if (oldField.format === newField.format) {
    formatScore = 1;
    formatDetail = `format 一致：${oldField.format}`;
  } else {
    formatScore = 0;
    formatDetail = `format 不一致：${oldField.format ?? '无'} -> ${newField.format ?? '无'}`;
  }
  features.push(feature('format', 'format', WEIGHTS.format, formatScore, formatDetail));

  // 6) 树里的位置：深度 + 祖先链分词（IDF 加权：小组里稀有的路径词更有判别力）
  const depthPenalty = Math.min(Math.abs(oldField.depth - newField.depth), 4) / 4;
  const oldAncestors = ancestorTokens(oldField);
  const newAncestors = ancestorTokens(newField);
  const ancestorScore = weightedOverlap(oldAncestors, newAncestors, corpus);
  const structureScore = round3(0.6 * ancestorScore + 0.4 * (1 - depthPenalty));
  features.push(
    feature(
      'structure',
      '树中位置',
      WEIGHTS.structure,
      structureScore,
      `深度 ${oldField.depth} vs ${newField.depth}；祖先词 ${formatTokens([...oldAncestors])} vs ` +
        `${formatTokens([...newAncestors])}（重合 ${(ancestorScore * 100).toFixed(0)}%）`,
    ),
  );

  // 7) 兄弟字段像不像（zip 从 address 挪到 shipping 时的强信号）
  let siblingScore = 0.5;
  let siblingDetail = '';
  if (oldField.siblingNames.length === 0 && newField.siblingNames.length === 0) {
    siblingScore = 0.5;
    siblingDetail = '两边都没有兄弟字段，中性';
  } else {
    const oldSiblingTokens = siblingTokensOf(oldField);
    const newSiblingTokens = siblingTokensOf(newField);
    siblingScore = weightedOverlap(oldSiblingTokens, newSiblingTokens, corpus);
    siblingDetail =
      `兄弟字段分词重合 ${(siblingScore * 100).toFixed(0)}%` +
      `（旧兄弟 ${oldField.siblingNames.slice(0, 6).join(', ') || '无'}；` +
      `新兄弟 ${newField.siblingNames.slice(0, 6).join(', ') || '无'}）`;
  }
  features.push(feature('sibling', '兄弟字段相似度', WEIGHTS.sibling, round3(siblingScore), siblingDetail));

  // 8) examples（没有就中性，不惩罚到出不了候选）
  const exampleScoreRaw = exampleSetsSimilarity(oldField.examples, newField.examples);
  const exampleScore = exampleScoreRaw === null ? 0.5 : exampleScoreRaw;
  const exampleDetail =
    exampleScoreRaw === null
      ? '两边都没有 examples，中性（不影响出候选）'
      : oldField.examples.length === 0 || newField.examples.length === 0
        ? '仅一侧有 examples，给中性 0.5'
        : `样例分类相似度 ${(exampleScoreRaw * 100).toFixed(0)}%（按类型/格式/数量级/对象键判断）`;
  features.push(feature('examples', 'examples 样例', WEIGHTS.examples, round3(exampleScore), exampleDetail));

  const score = features.reduce((sum, f) => sum + f.contribution, 0);
  return {oldIndex: -1, newIndex: -1, score, features};
}

function tokenSet(names: string[]): string[] {
  const tokens = new Set<string>();
  for (const name of names) {
    for (const token of tokenize(name)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

// 热路径缓存：兄弟词、祖先词在打分/倒排里被反复使用
const siblingTokenCache = new WeakMap<FieldRecord, string[]>();
const ancestorTokenCache = new WeakMap<FieldRecord, string[]>();

function siblingTokensOf(field: FieldRecord): string[] {
  let cached = siblingTokenCache.get(field);
  if (!cached) {
    cached = tokenSet(field.siblingNames);
    siblingTokenCache.set(field, cached);
  }
  return cached;
}

function ancestorTokens(field: FieldRecord): string[] {
  let cached = ancestorTokenCache.get(field);
  if (!cached) {
    // 去掉根 $、数组标记和当前字段名，路径段统一按名称规则分词
    const segments = field.path
      .split('.')
      .slice(1, -1)
      .filter(segment => segment !== '[]');
    cached = segments.flatMap(segment => tokenize(segment));
    ancestorTokenCache.set(field, cached);
  }
  return cached;
}

function formatTokens(tokens: string[]): string {
  return tokens.length ? `[${tokens.join(', ')}]` : '[]';
}

/**
 * 匈牙利算法（最小权匹配），O(n^3)，使用 TypedArray 保证 400+ 字段时的性能。
 * 方阵，缺失边用 dummyCost 表示“宁可不配”。
 * 返回每一行选择的列，-1 表示该行选择 dummy。
 */
export function hungarian(costMatrix: number[][], dummyCost: number): number[] {
  const n = costMatrix.length;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  const minv = new Float64Array(n + 1);
  const used = new Uint8Array(n + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    let i0 = 0;
    let delta = 0;
    let j1 = 0;
    do {
      used[j0] = 1;
      i0 = p[j0];
      const row = costMatrix[i0 - 1];
      delta = Infinity;
      j1 = 0;
      const ui = u[i0];
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = row[j - 1] - ui - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
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

  const assignment = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    assignment[p[j] - 1] = j - 1;
  }
  // 落到 dummy 列的标记为 -1
  for (let row = 0; row < n; row++) {
    const col = assignment[row];
    if (col < 0 || costMatrix[row][col] >= dummyCost) assignment[row] = -1;
  }
  return assignment;
}

function edgeKey(oldIndex: number, newIndex: number, edge: Edge): Edge {
  return {...edge, oldIndex, newIndex};
}

/**
 * 候选对预筛（大规模关键路径，复杂度近似线性）：
 * 1. 名称词、兄弟词、祖先词分别建带 IDF 的倒排索引。
 *    "value"/"id" 这类几乎处处出现的词 IDF 很低，不会让每个字段召回全部字段。
 * 2. 每个旧字段按“共享词 IDF 之和 + 位置邻近”的极便宜信号排序，
 *    只对前若干名跑轻量名字分，再截断到 MAX_FULL_SCORE_PER_OLD 做完整打分。
 * 小笛卡尔积直接全量，保证小 schema 结果精确。
 */
function selectCandidatePairs(
  movedOld: FieldRecord[],
  movedNew: FieldRecord[],
  corpus: CorpusIdf,
): Array<[number, number]> {
  const total = movedOld.length * movedNew.length;
  if (total === 0) return [];

  if (total <= EXHAUSTIVE_LIMIT) {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < movedOld.length; i++) {
      for (let j = 0; j < movedNew.length; j++) pairs.push([i, j]);
    }
    return pairs;
  }

  // IDF：在多少个新字段里出现过 -> 权重。高频通用词权重被压得很低。
  const docCount = movedNew.length;
  const buildIdfIndex = (tokensOf: (f: FieldRecord) => string[]) => {
    const postings = new Map<string, number[]>();
    const df = new Map<string, number>();
    movedNew.forEach((field, j) => {
      for (const token of new Set(tokensOf(field))) {
        const list = postings.get(token) ?? [];
        list.push(j);
        postings.set(token, list);
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    });
    const idf = new Map<string, number>();
    for (const [token, freq] of df) {
      // 通用词（在极多字段里出现）IDF 接近 1，稀有词更高
      idf.set(token, Math.log((docCount + 1) / (freq + 1)) + 1);
    }
    return {postings, idf};
  };

  // IDF 低于此值的词不参与召回（"value"/"id" 这类通用词），只在完整打分里体现
  const MIN_RECALL_IDF = 1.4;

  const nameIndex = buildIdfIndex(f => f.nameTokens);
  const siblingIndex = buildIdfIndex(f => siblingTokensOf(f));
  const ancestorIndex = buildIdfIndex(f => ancestorTokens(f));

  const result: Array<[number, number]> = [];
  for (let i = 0; i < movedOld.length; i++) {
    // 倒排召回候选（只收 IDF 够高的词的 postings）
    const candidate = new Map<number, number>(); // newIndex -> 累计 IDF 权重
    const addFromIndex = (
      index: {postings: Map<string, number[]>; idf: Map<string, number>},
      tokens: string[],
      multiplier: number,
    ) => {
      for (const token of new Set(tokens)) {
        const weight = index.idf.get(token) ?? 0;
        if (weight < MIN_RECALL_IDF) continue;
        for (const j of index.postings.get(token) ?? []) {
          candidate.set(j, (candidate.get(j) ?? 0) + weight * multiplier);
        }
      }
    };
    addFromIndex(nameIndex, movedOld[i].nameTokens, 1);
    addFromIndex(siblingIndex, siblingTokensOf(movedOld[i]), 0.5);
    addFromIndex(ancestorIndex, ancestorTokens(movedOld[i]), 0.7);

    let ranked = [...candidate.entries()].map(([j]) => j);

    // 没有高 IDF 词召回（短名/通用名字段）：在轻量名字分上过阈值的小集合里兜底
    if (ranked.length === 0) {
      ranked = movedNew
        .map((newField, j) => ({j, light: lightNameScore(movedOld[i], newField)}))
        .filter(entry => entry.light > 0.4)
        .sort((a, b) => b.light - a.light)
        .slice(0, FALLBACK_PER_FIELD)
        .map(entry => entry.j);
    }

    // 按累计 IDF 权重排序（postings 命中越多、词越稀有越靠前）
    ranked.sort((a, b) => (candidate.get(b) ?? 0) - (candidate.get(a) ?? 0));
    const window = ranked.slice(0, MAX_FULL_SCORE_PER_OLD * 3);
    const oldSiblings = siblingTokensOf(movedOld[i]);
    const oldAncestors = ancestorTokens(movedOld[i]);
    const scored = window
      .map(j => {
        const namePart = lightNameScore(movedOld[i], movedNew[j]);
        const siblingPart = 0.2 * weightedOverlap(oldSiblings, siblingTokensOf(movedNew[j]), corpus);
        const ancestorPart = 0.15 * weightedOverlap(oldAncestors, ancestorTokens(movedNew[j]), corpus);
        return {j, rank: namePart + siblingPart + ancestorPart};
      })
      .sort((a, b) => b.rank - a.rank);
    for (const {j} of scored.slice(0, MAX_FULL_SCORE_PER_OLD)) result.push([i, j]);
  }
  return result;
}

function toAlternative(
  edge: Edge,
  oldFields: FieldRecord[],
  newFields: FieldRecord[],
  chosenScore: number,
): AlternativeEdge {
  return {
    oldPath: oldFields[edge.oldIndex].path,
    oldName: oldFields[edge.oldIndex].name,
    newPath: newFields[edge.newIndex].path,
    newName: newFields[edge.newIndex].name,
    score: edge.score,
    gap: round3(Math.max(0, chosenScore - edge.score)),
  };
}

export function compareFieldSets(
  oldFields: FieldRecord[],
  newFields: FieldRecord[],
  startTimestamp = performance.now(),
): PairAnalysis {
  // 同路径字段直接对齐，其余进入改名/移动候选池
  const oldByPath = new Map(oldFields.map(f => [f.path, f]));
  const newByPath = new Map(newFields.map(f => [f.path, f]));
  const samePathOld = new Set<FieldRecord>();
  const samePathNew = new Set<FieldRecord>();
  const samePathChanges: SamePathChange[] = [];

  for (const oldField of oldFields) {
    const newField = newByPath.get(oldField.path);
    if (!newField || oldField.path === '$') continue;
    samePathOld.add(oldField);
    samePathNew.add(newField);

    const changes: SamePathChange['changes'] = [];
    const transition = typeTransition(oldField.types, newField.types);
    if (transition !== 'same' && transition !== 'untyped') {
      changes.push({
        code: 'type',
        severity: typeChangeIsBlocker(transition) ? 'blocker' : 'warning',
        detail: `${oldField.types.join('|') || '未声明'} -> ${newField.types.join('|') || '未声明'}（${transition}）`,
      });
    }
    if (!oldField.format && newField.format) {
      changes.push({code: 'format-added', severity: 'warning', detail: `新增 format: ${newField.format}`});
    } else if (oldField.format && !newField.format) {
      changes.push({code: 'format-removed', severity: 'info', detail: `移除 format: ${oldField.format}`});
    } else if (oldField.format && newField.format && oldField.format !== newField.format) {
      changes.push({
        code: 'format-changed',
        severity: 'blocker',
        detail: `format ${oldField.format} -> ${newField.format}`,
      });
    }
    if (!oldField.pattern && newField.pattern) {
      changes.push({
        code: 'pattern-added',
        severity: newField.types.includes('string') ? 'blocker' : 'warning',
        detail: `新增 pattern 约束：${newField.pattern}（旧字符串可能不匹配）`,
      });
    } else if (oldField.pattern && newField.pattern && oldField.pattern !== newField.pattern) {
      changes.push({
        code: 'pattern-changed',
        severity: 'blocker',
        detail: `pattern ${oldField.pattern} -> ${newField.pattern}`,
      });
    } else if (oldField.pattern && !newField.pattern) {
      changes.push({code: 'pattern-removed', severity: 'info', detail: '移除 pattern 约束'});
    }
    const removedEnums = oldField.enumValues.filter(v => !newField.enumValues.includes(v));
    const addedEnums = newField.enumValues.filter(v => !oldField.enumValues.includes(v));
    if (oldField.enumValues.length > 0 && removedEnums.length > 0) {
      changes.push({
        code: 'enum-values-removed',
        severity: 'blocker',
        detail: `枚举值被移除（旧数据可能还在用）：${removedEnums.slice(0, 6).join(', ')}`,
      });
    }
    if (addedEnums.length > 0) {
      changes.push({code: 'enum-values-added', severity: 'info', detail: `新增枚举值：${addedEnums.slice(0, 6).join(', ')}`});
    }
    if (!oldField.required && newField.required) {
      changes.push({code: 'became-required', severity: 'blocker', detail: '可选字段变成必填，旧记录可能缺这个键'});
    } else if (oldField.required && !newField.required) {
      changes.push({code: 'became-optional', severity: 'info', detail: '必填变成可选'});
    }
    if (changes.length > 0) {
      samePathChanges.push({path: oldField.path, name: oldField.name, typeTransition: transition, changes});
    }
  }

  const movedOld = oldFields.filter(f => !samePathOld.has(f) && f.path !== '$');
  const movedNew = newFields.filter(f => !samePathNew.has(f) && f.path !== '$');

  // 语料 IDF 先建：预筛排序和完整打分都要用
  const corpus = buildCorpusIdf(movedOld, movedNew);

  // 先用便宜信号挑出值得完整打分的配对：大 schema 时每侧只保留最像的若干个，
  // 完整打分只发生在这个小集合上（450x450 也要在 2 秒内回来）。
  const candidatePairs = selectCandidatePairs(movedOld, movedNew, corpus);

  // 全量边（阈值以上），以及完整边表用于备选解释
  const allEdges: Edge[] = [];
  for (const [i, j] of candidatePairs) {
    const edge = edgeKey(i, j, scoreEdge(movedOld[i], movedNew[j], corpus));
    allEdges.push(edge);
  }
  const eligible = allEdges.filter(e => e.score >= CANDIDATE_THRESHOLD);

  // 构造方阵：真实边（阈值以上）成本 = 100 - score；真实边阈值以下禁止；dummy 边成本 101。
  // dummy 保证“宁缺毋滥”：低分候选不如判成删除+新增。
  // 只让至少有一条合格边的字段进矩阵，其余直接判删除/新增，缩小 O(n^3) 的 n。
  const activeOld = new Set<number>();
  const activeNew = new Set<number>();
  for (const edge of eligible) {
    activeOld.add(edge.oldIndex);
    activeNew.add(edge.newIndex);
  }
  const oldRowMap = new Map<number, number>();
  const newColMap = new Map<number, number>();
  const activeOldList = [...activeOld].sort((a, b) => a - b);
  const activeNewList = [...activeNew].sort((a, b) => a - b);
  activeOldList.forEach((idx, row) => oldRowMap.set(idx, row));
  activeNewList.forEach((idx, col) => newColMap.set(idx, col));

  const rows = activeOldList.length;
  const cols = activeNewList.length;
  const size = Math.max(rows, cols);
  const DUMMY_COST = 101;
  const FORBIDDEN = 1_000_000;
  const cost: number[][] = [];
  const edgeLookup = new Map<string, Edge>();
  for (const edge of eligible) edgeLookup.set(`${edge.oldIndex}:${edge.newIndex}`, edge);
  for (let i = 0; i < size; i++) {
    const row: number[] = new Array(size).fill(DUMMY_COST);
    if (i < rows) {
      const oldIdx = activeOldList[i];
      for (let j = 0; j < cols; j++) {
        const newIdx = activeNewList[j];
        const edge = edgeLookup.get(`${oldIdx}:${newIdx}`);
        if (edge) row[j] = 100 - edge.score;
        else if (i < rows) row[j] = FORBIDDEN;
      }
    }
    cost.push(row);
  }

  const assignmentCompact = size > 0 ? hungarian(cost, DUMMY_COST) : [];

  const proposals: Proposal[] = [];
  const matchedOld = new Set<number>();
  const matchedNew = new Set<number>();
  for (let row = 0; row < rows; row++) {
    const col = assignmentCompact[row];
    if (col < 0 || col >= cols) continue; // 选了 dummy
    const oldIdx = activeOldList[row];
    const newIdx = activeNewList[col];
    const edge = edgeLookup.get(`${oldIdx}:${newIdx}`);
    if (!edge) continue;
    matchedOld.add(oldIdx);
    matchedNew.add(newIdx);
  }
  void oldRowMap;
  void newColMap;

  // 对每条入选边整理 runnerUps / competitors / 反事实解释
  const chosenEdges = [...matchedOld].map(i => {
    const oldRow = oldRowMap.get(i)!;
    const col = assignmentCompact[oldRow];
    const newIdx = activeNewList[col];
    return edgeLookup.get(`${i}:${newIdx}`)!;
  });

  // 预建边索引，避免在 400+ 字段上反复全量扫描
  const edgesByOld = new Map<number, Edge[]>();
  const edgesByNew = new Map<number, Edge[]>();
  for (const edge of allEdges) {
    const a = edgesByOld.get(edge.oldIndex) ?? [];
    a.push(edge);
    edgesByOld.set(edge.oldIndex, a);
    const b = edgesByNew.get(edge.newIndex) ?? [];
    b.push(edge);
    edgesByNew.set(edge.newIndex, b);
  }
  for (const list of edgesByOld.values()) list.sort((a, b) => b.score - a.score);
  for (const list of edgesByNew.values()) list.sort((a, b) => b.score - a.score);

  // 只对“有争议”的入选边做反事实重算（备选接近，或有竞争者且分数接近）
  const contestedSet = new Set<string>();
  for (const edge of chosenEdges) {
    const nearRunner = (edgesByOld.get(edge.oldIndex) ?? [])
      .filter(e => e.newIndex !== edge.newIndex)
      .some(e => edge.score - e.score <= CLOSE_GAP);
    const nearCompetitor = (edgesByNew.get(edge.newIndex) ?? [])
      .filter(e => e.oldIndex !== edge.oldIndex)
      .some(e => edge.score - e.score <= CLOSE_GAP);
    if (nearRunner || nearCompetitor) contestedSet.add(`${edge.oldIndex}:${edge.newIndex}`);
  }

  const counterfactual = new Map<string, {total: number; chosenTotal: number; note: string}>();
  if (chosenEdges.length > 0) {
    const chosenTotal = chosenEdges.reduce((sum, e) => sum + e.score, 0);
    for (const key of contestedSet) {
      const [oi, nj] = key.split(':').map(Number);
      const alt = localReassignment(oi, nj, eligible);
      counterfactual.set(key, {
        total: alt,
        chosenTotal,
        note: counterfactualNote(alt, chosenTotal),
      });
    }
  }

  for (const edge of chosenEdges) {
    const oldField = movedOld[edge.oldIndex];
    const newField = movedNew[edge.newIndex];
    const transition = typeTransition(oldField.types, newField.types);

    const runnerUps = (edgesByOld.get(edge.oldIndex) ?? [])
      .slice(0, 5)
      .map(e => toAlternative(e, movedOld, movedNew, edge.score));

    const competitors = (edgesByNew.get(edge.newIndex) ?? [])
      .filter(e => e.oldIndex !== edge.oldIndex)
      .slice(0, 5)
      .map(e => toAlternative(e, movedOld, movedNew, edge.score));

    let assignmentNote: AssignmentNote;
    const cf = counterfactual.get(`${edge.oldIndex}:${edge.newIndex}`);
    const closeRunner = runnerUps.find(a => a.newPath !== newField.path && a.gap <= CLOSE_GAP);
    const closeCompetitor = competitors.find(a => a.gap <= CLOSE_GAP);
    if (cf && (closeRunner || closeCompetitor)) {
      const reasons: string[] = [];
      if (closeRunner) reasons.push(`次选 ${closeRunner.newName}（${closeRunner.score} 分，差 ${closeRunner.gap}）`);
      if (closeCompetitor)
        reasons.push(`竞争者 ${closeCompetitor.oldName} 也想要 ${newField.name}（${closeCompetitor.score} 分，差 ${closeCompetitor.gap}）`);
      assignmentNote = {
        kind: 'contested',
        text: `全局一对一分配后此边胜出。${reasons.join('；')}。`,
        counterfactual: cf.note,
      };
    } else {
      assignmentNote = {
        kind: 'unique',
        text:
          runnerUps.length <= 1
            ? '没有达到候选阈值的其它配对。'
            : `与次选 ${runnerUps[1]?.newName ?? ''} 相差 ${runnerUps[1]?.gap ?? edge.score} 分，优势明确。`,
      };
    }

    proposals.push({
      oldPath: oldField.path,
      newPath: newField.path,
      oldName: oldField.name,
      newName: newField.name,
      score: edge.score,
      features: edge.features,
      typeTransition: transition,
      runnerUps,
      competitors,
      assignmentNote,
    });
  }

  proposals.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.oldPath < b.oldPath ? -1 : 1));

  const unmatchedOld = movedOld
    .filter((_, i) => !matchedOld.has(i))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const unmatchedNew = movedNew
    .filter((_, j) => !matchedNew.has(j))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  return {
    oldFields,
    newFields,
    proposals,
    unmatchedOld,
    unmatchedNew,
    samePathChanges,
    stats: {elapsedMs: Math.max(0, Math.round(performance.now() - startTimestamp))},
  };
}

/**
 * 反事实：如果把 oldIndex 不让给 newIndex，在“受影响的局部”里重新一对一分配，
 * 返回该局部能达到的总分（不含被禁的那条边）。
 *
 * 局部集合 = 这条边两侧的旧字段、新字段，以及与它们共享过候选边的字段，
 * 并加上这些字段在当前全局分配里的配对方。这样规模通常只有个位数到几十，
 * 即使 400+ 字段也不会在反事实上反复跑 O(n³)。
 */
function localReassignment(
  oldIndex: number,
  forbiddenNew: number,
  eligible: Edge[],
): number {
  // 邻接表（只在合格边构成的图上做 BFS，近似 O(E)）
  const byOld = new Map<number, number[]>();
  const byNew = new Map<number, number[]>();
  eligible.forEach((edge, idx) => {
    const a = byOld.get(edge.oldIndex) ?? [];
    a.push(idx);
    byOld.set(edge.oldIndex, a);
    const b = byNew.get(edge.newIndex) ?? [];
    b.push(idx);
    byNew.set(edge.newIndex, b);
  });

  const oldSet = new Set<number>([oldIndex]);
  const newSet = new Set<number>([forbiddenNew]);
  const oldQueue = [oldIndex];
  const newQueue = [forbiddenNew];
  // BFS：沿候选边把两侧连通的字段收进局部集合
  while (oldQueue.length || newQueue.length) {
    const o = oldQueue.shift();
    if (o !== undefined) {
      for (const idx of byOld.get(o) ?? []) {
        const nj = eligible[idx].newIndex;
        if (!newSet.has(nj)) {
          newSet.add(nj);
          newQueue.push(nj);
        }
      }
    }
    const n = newQueue.shift();
    if (n !== undefined) {
      for (const idx of byNew.get(n) ?? []) {
        const oi = eligible[idx].oldIndex;
        if (!oldSet.has(oi)) {
          oldSet.add(oi);
          oldQueue.push(oi);
        }
      }
    }
  }

  // 防止病态连通把整张图都拖进来：限制局部规模，超了就退化成一跳邻域
  const MAX_LOCAL = 40;
  if (oldSet.size > MAX_LOCAL || newSet.size > MAX_LOCAL) {
    oldSet.clear();
    newSet.clear();
    oldSet.add(oldIndex);
    newSet.add(forbiddenNew);
    for (const edge of eligible) {
      if (edge.oldIndex === oldIndex) newSet.add(edge.newIndex);
      if (edge.newIndex === forbiddenNew) oldSet.add(edge.oldIndex);
    }
  }

  const oldList = [...oldSet].sort((a, b) => a - b);
  const newInLocal = new Set(newSet);

  // 用邻接表只收局部边（O(局部边) 一次过滤），贪心重排（k 通常个位数）：
  // 在局部候选边上轮流挑最高分、保证一对一。这是解释性的约数，
  // 不需要在 400 字段上为每条争议边再跑一次 O(k³)。
  const localEdges: Edge[] = [];
  for (const oi of oldList) {
    for (const idx of byOld.get(oi) ?? []) {
      const edge = eligible[idx];
      if (!newInLocal.has(edge.newIndex)) continue;
      if (edge.oldIndex === oldIndex && edge.newIndex === forbiddenNew) continue;
      localEdges.push(edge);
    }
  }
  localEdges.sort((a, b) => b.score - a.score);
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();
  let total = 0;
  for (const edge of localEdges) {
    if (usedOld.has(edge.oldIndex) || usedNew.has(edge.newIndex)) continue;
    usedOld.add(edge.oldIndex);
    usedNew.add(edge.newIndex);
    total += edge.score;
  }
  return total;
}

function counterfactualNote(alternativeTotal: number, chosenTotal: number): string {
  const diff = round3(chosenTotal - alternativeTotal);
  if (diff <= 0) {
    return '若改成备选，全局匹配总分持平或更高——这条需要人工重点看。';
  }
  return `若把该字段让给备选，其余字段重新一对一分配后的全局总分约 ${alternativeTotal.toFixed(1)}，` +
    `低于当前方案的 ${chosenTotal.toFixed(1)}（合计损失 ${diff.toFixed(1)} 分），所以当前配对胜出。`;
}
