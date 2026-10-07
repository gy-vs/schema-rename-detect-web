import type {FieldNode, JsonValue} from './types.js';

/**
 * 旧类型 -> 新类型是否“读得出”。
 * integer -> number 兼容；string -> integer 不兼容。
 * 多类型（type 数组）要求旧侧每个类型在新侧都有兼容落点。
 */
export function typesCompatible(oldTypes: string[], newTypes: string[]): {
  ok: boolean;
  detail: string;
} {
  if (oldTypes.length === 0 || newTypes.length === 0) {
    return {
      ok: true,
      detail:
        oldTypes.length === 0 && newTypes.length === 0
          ? '两侧均未声明 type，按兼容处理'
          : '一侧未声明 type，无法判冲突，按兼容处理',
    };
  }
  const single = (from: string, to: string): boolean => {
    if (from === to) return true;
    if (from === 'integer' && to === 'number') return true;
    return false;
  };
  for (const o of oldTypes) {
    const hit = newTypes.some((n) => single(o, n));
    if (!hit) {
      return {
        ok: false,
        detail: `类型 ${o} 在新类型 [${newTypes.join(', ')}] 中没有兼容落点`,
      };
    }
  }
  const widened = oldTypes.some((o, i) => newTypes[i] !== o);
  return {
    ok: true,
    detail: widened
      ? `类型 [${oldTypes.join(', ')}] -> [${newTypes.join(', ')}] 属于放宽（如 integer→number）`
      : `类型一致 [${oldTypes.join(', ')}]`,
  };
}

export function requiredSimilarity(a: boolean, b: boolean): {
  score: number;
  detail: string;
} {
  if (a === b) return {score: 1, detail: `required 前后一致（${a}）`};
  return {score: 0.4, detail: `required 不一致：${a} -> ${b}`};
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function enumSimilarity(
  oldEnum: JsonValue[] | undefined,
  newEnum: JsonValue[] | undefined,
): {score: number | null; detail: string} {
  if (oldEnum === undefined && newEnum === undefined) {
    return {score: null, detail: '两侧均无 enum'};
  }
  if (oldEnum === undefined || newEnum === undefined) {
    return {score: 0.3, detail: '仅一侧声明了 enum'};
  }
  const key = (v: JsonValue) => JSON.stringify(v);
  const oldSet = new Set(oldEnum.map(key));
  const newSet = new Set(newEnum.map(key));
  let inter = 0;
  for (const v of oldSet) if (newSet.has(v)) inter++;
  const union = new Set([...oldSet, ...newSet]).size;
  const score = union === 0 ? 1 : inter / union;
  const dropped = [...oldSet].filter((v) => !newSet.has(v));
  return {
    score,
    detail:
      `enum 交集 ${inter}/${union}` +
      (dropped.length ? `，新侧移除了 ${dropped.length} 个取值` : ''),
  };
}

export function formatSimilarity(
  oldFormat: string | undefined,
  newFormat: string | undefined,
): {score: number | null; detail: string} {
  if (!oldFormat && !newFormat) return {score: null, detail: '两侧均无 format'};
  if (oldFormat === newFormat) return {score: 1, detail: `format 一致（${oldFormat}）`};
  return {
    score: 0.2,
    detail: `format 不一致：${oldFormat ?? '∅'} -> ${newFormat ?? '∅'}`,
  };
}

/** examples 是否“一类东西”：归一化后比较 JSON 类型；双方都没写 examples 时弃权。 */
export function examplesSimilarity(
  oldExamples: JsonValue[],
  newExamples: JsonValue[],
): {score: number | null; detail: string} {
  if (oldExamples.length === 0 && newExamples.length === 0) {
    return {score: null, detail: '两侧均无 examples，该维度弃权'};
  }
  if (oldExamples.length === 0 || newExamples.length === 0) {
    return {score: null, detail: '仅一侧有 examples，该维度弃权（不惩罚）'};
  }
  const kind = (v: JsonValue): string =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  const oldKinds = new Set(oldExamples.map(kind));
  let match = 0;
  for (const ex of newExamples) {
    if (oldKinds.has(kind(ex))) match++;
  }
  const score = match / newExamples.length;
  return {
    score,
    detail: `样例归一化类型 ${[...oldKinds].join('/')} vs ${newExamples
      .map(kind)
      .join('/')}，命中 ${match}/${newExamples.length}`,
  };
}

/**
 * 兄弟字段相似度：同组兄弟字段名集合的 Jaccard（先分词）。
 * shipping 与 address 这种位置搬迁，兄弟集合往往大面积重合。
 * 在 400+ 字段的 O(n²) 打分里它是热点，token 集合由调用方预算后传入。
 */
export function siblingTokensOf(names: string[]): Set<string> {
  const s = new Set<string>();
  for (const n of names) {
    const t = n
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/);
    t.filter(Boolean).forEach((x) => s.add(x));
  }
  return s;
}

export function siblingsSimilarityPrecomputed(
  oldNode: FieldNode,
  newNode: FieldNode,
  a: Set<string>,
  b: Set<string>,
): {score: number; detail: string} {
  if (a.size === 0 && b.size === 0) {
    return {score: 0.5, detail: '两侧均无兄弟字段，给中性分 0.5'};
  }
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = new Set([...a, ...b]).size;
  const score = union === 0 ? 0.5 : inter / union;
  return {
    score,
    detail:
      `兄弟字段词干集合交集 ${inter}/${union}` +
      (score > 0
        ? `（旧侧兄弟：${oldNode.siblings.slice(0, 6).join(', ')}${
            oldNode.siblings.length > 6 ? '…' : ''
          }；新侧：${newNode.siblings.slice(0, 6).join(', ')}${
            newNode.siblings.length > 6 ? '…' : ''
          }）`
        : ''),
  };
}

export function siblingsSimilarity(oldNode: FieldNode, newNode: FieldNode): {
  score: number;
  detail: string;
} {
  return siblingsSimilarityPrecomputed(
    oldNode,
    newNode,
    siblingTokensOf(oldNode.siblings),
    siblingTokensOf(newNode.siblings),
  );
}

/** 树里的位置：深度接近 + 父路径结构相似。兄弟单独成项，这里只看深度。 */
export function depthSimilarity(oldNode: FieldNode, newNode: FieldNode): {
  score: number;
  detail: string;
} {
  const diff = Math.abs(oldNode.depth - newNode.depth);
  const score = diff === 0 ? 1 : diff === 1 ? 0.6 : 0.2;
  return {
    score,
    detail:
      diff === 0
        ? `字段深度一致（${oldNode.depth}）`
        : `字段深度相差 ${diff}（${oldNode.depth} -> ${newNode.depth}）`,
  };
}

export function constSimilarity(
  oldConst: JsonValue | undefined,
  newConst: JsonValue | undefined,
): {score: number | null; detail: string} {
  if (oldConst === undefined && newConst === undefined) {
    return {score: null, detail: '两侧均无 const'};
  }
  if (jsonEqual(oldConst, newConst)) return {score: 1, detail: 'const 一致'};
  return {score: 0.1, detail: `const 不一致：${JSON.stringify(oldConst)} -> ${JSON.stringify(newConst)}`};
}
