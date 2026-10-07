import type {FieldNode, JsonSchema, JsonValue} from './types.js';

export class SchemaParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = 'SchemaParseError';
  }
}

/** 解析文本为 JSON，并做最低限度的 JSON Schema 结构检查。 */
export function parseSchemaText(text: string): JsonSchema {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const e = err as SyntaxError;
    throw new SchemaParseError(e.message);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaParseError('Schema 根必须是一个 JSON 对象');
  }
  const root = value as Record<string, unknown>;
  if (
    root.type !== undefined &&
    root.type !== 'object' &&
    root.$ref === undefined
  ) {
    throw new SchemaParseError('Schema 根的 type 必须是 object（或使用 $ref）');
  }
  return value as JsonSchema;
}

function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): JsonValue[] | undefined {
  return Array.isArray(v) ? (v as JsonValue[]) : undefined;
}

function typesOf(schema: Record<string, JsonValue>): string[] {
  const t = schema.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  // 没有显式 type 时按结构推断，保持确定结果
  if (isObject(schema.properties)) return ['object'];
  if (isObject(schema.items)) return ['array'];
  return [];
}

function mergeExamples(
  schema: Record<string, JsonValue>,
  acc: JsonValue[],
): JsonValue[] {
  const ex = schema.examples;
  if (Array.isArray(ex)) acc.push(...ex);
  if (schema.example !== undefined) acc.push(schema.example);
  return acc;
}

/** 解析当前节点内的 $ref / allOf，得到用于取字段的有效 schema（浅合并）。 */
function resolveSchema(
  schema: Record<string, JsonValue>,
  root: Record<string, JsonValue>,
  seenRefs: Set<string>,
  refTrail: string[],
): {
  merged: Record<string, JsonValue>;
  seenRefs: Set<string>;
  refTrail: string[];
  recursiveRef?: string;
} {
  const merged: Record<string, JsonValue> = {};
  let recursiveRef: string | undefined;
  const applyOne = (
    s: Record<string, JsonValue>,
    seen: Set<string>,
    trail: string[],
  ): {seen: Set<string>; trail: string[]} => {
    // 每个分支独立持有 seen/trail，兄弟节点的 ref 展开互不污染
    let curSeen = new Set(seen);
    let curTrail = trail.slice();
    if (typeof s.$ref === 'string') {
      const ref = s.$ref;
      if (curSeen.has(ref)) {
        recursiveRef = ref;
        return {seen: curSeen, trail: curTrail};
      }
      const target = resolveRef(ref, root);
      if (target) {
        curSeen.add(ref);
        curTrail.push(ref);
        const r = applyOne(target, curSeen, curTrail);
        curSeen = r.seen;
        curTrail = r.trail;
      }
    }
    for (const [k, v] of Object.entries(s)) {
      if (k === '$ref' || k === 'allOf') continue;
      merged[k] = v;
    }
    if (Array.isArray(s.allOf)) {
      for (const part of s.allOf) {
        if (isObject(part)) {
          const r = applyOne(part as Record<string, JsonValue>, curSeen, curTrail);
          curSeen = r.seen;
          curTrail = r.trail;
        }
      }
    }
    return {seen: curSeen, trail: curTrail};
  };
  const r = applyOne(schema, seenRefs, refTrail);
  return {merged, seenRefs: r.seen, refTrail: r.trail, recursiveRef};
}

/** 仅支持文档内引用：#/defs/Name、#/$defs/Name、# 等。 */
export function resolveRef(
  ref: string,
  root: Record<string, JsonValue>,
): Record<string, JsonValue> | undefined {
  if (!ref.startsWith('#')) return undefined; // 外部引用不跟随
  const fragment = ref.slice(1);
  if (fragment === '' || fragment === '/') return root;
  const parts = fragment
    .replace(/^\//, '')
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = root;
  for (const part of parts) {
    if (!isObject(cur)) return undefined;
    cur = cur[part];
  }
  return isObject(cur) ? (cur as Record<string, JsonValue>) : undefined;
}

function nodeTypesOf(s: Record<string, JsonValue>): string[] {
  return typesOf(s);
}

function flattenObject(
  schema: Record<string, JsonValue>,
  root: Record<string, JsonValue>,
  pathPrefix: string,
  requiredAncestors: boolean,
  seenRefs: Set<string>,
  refTrail: string[],
  out: FieldNode[],
): void {
  const eff = resolveSchema(schema, root, seenRefs, refTrail);
  const s = eff.merged;
  if (!isObject(s.properties)) return;
  const requiredSet = new Set(asArray(s.required) ?? []);
  // 键排序：properties 书写顺序不影响任何结论（只影响展示序号）
  const names = Object.keys(s.properties).sort();
  for (const name of names) {
    const childRaw = s.properties[name];
    if (!isObject(childRaw)) continue;
    const path = pathPrefix ? `${pathPrefix}.${name}` : name;
    // 属性沿当前对象的引用链向下走（兄弟各持副本，互不污染）；
    // 这样 children[]: {$ref Cat} 在 Cat 内部会被确定性地截断为循环。
    const childEff = resolveSchema(childRaw, root, eff.seenRefs, eff.refTrail);
    const child = childEff.merged;
    const types = nodeTypesOf(child);
    const isRequired = requiredSet.has(name);
    const examples = mergeExamples(child, []);
    const siblings = names.filter((n) => n !== name);
    const node: FieldNode = {
      path,
      name,
      depth: pathPrefix === '' ? 0 : pathPrefix.split('.').length,
      types,
      format: typeof child.format === 'string' ? child.format : undefined,
      required: isRequired,
      enumValues: asArray(child.enum),
      constValue: child.const !== undefined ? child.const : undefined,
      examples,
      siblings,
      isArrayItem: false,
      refs: childEff.refTrail,
      recursiveBackRef: childEff.recursiveRef,
    };
    out.push(node);
    if (types.includes('object')) {
      flattenObject(
        child,
        root,
        path,
        requiredAncestors && isRequired,
        childEff.seenRefs,
        childEff.refTrail,
        out,
      );
    }
    if (types.includes('array')) {
      flattenArrayItems(child, root, path, isRequired, childEff, out);
    }
  }
}

function flattenArrayItems(
  schema: Record<string, JsonValue>,
  root: Record<string, JsonValue>,
  parentPath: string,
  parentRequired: boolean,
  parentEff: {seenRefs: Set<string>; refTrail: string[]},
  out: FieldNode[],
): void {
  const items = schema.items;
  const itemSchema = isObject(items) ? items : undefined;
  if (!itemSchema) return;
  // items 沿父数组的引用链继续，所以循环检测链继承下来
  const itemEff = resolveSchema(itemSchema, root, parentEff.seenRefs, parentEff.refTrail);
  const item = itemEff.merged;
  const types = nodeTypesOf(item);
  const itemPath = `${parentPath}[]`;
  const itemNode: FieldNode = {
    path: itemPath,
    name: '[]',
    depth: parentPath.split('.').length,
    types,
    format: typeof item.format === 'string' ? item.format : undefined,
    required: parentRequired,
    enumValues: asArray(item.enum),
    constValue: item.const !== undefined ? item.const : undefined,
    examples: mergeExamples(item, []),
    siblings: [],
    isArrayItem: true,
    refs: itemEff.refTrail,
    recursiveBackRef: itemEff.recursiveRef,
  };
  out.push(itemNode);
  if (types.includes('object')) {
    flattenObject(item, root, itemPath, parentRequired, itemEff.seenRefs, itemEff.refTrail, out);
  }
}

/**
 * 把一份 schema 打平成有序（按路径排序）字段节点列表。
 * 同一字段路径只会出现一次；循环 $ref 在第二次进入时截断，节点上带 recursiveBackRef。
 */
export function flattenSchema(rootSchema: JsonSchema): FieldNode[] {
  const root = rootSchema as Record<string, JsonValue>;
  const out: FieldNode[] = [];
  flattenObject(root, root, '', true, new Set(), [], out);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function stableJson(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  const sort = (v: JsonValue): JsonValue => {
    if (Array.isArray(v)) return v.map(sort);
    if (isObject(v)) {
      const o: Record<string, JsonValue> = {};
      for (const k of Object.keys(v).sort()) o[k] = sort(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * 字段“内容指纹”：与字段名、所在路径、required、声明顺序、examples 均无关，
 * 只取决于类型 / enum / format / const。
 * 审阅跨版本沿用时用它判断字段内容有没有被动过；
 * 纯移动（路径变化）不打断沿用，required 翻转由同路径/配对差异另行上报。
 */
export function fieldFingerprint(node: FieldNode): string {
  const core = [
    node.types.slice().sort().join('|'),
    stableJson(node.enumValues),
    node.format ?? '',
    stableJson(node.constValue),
  ].join('#');
  let h = 0;
  for (let i = 0; i < core.length; i++) {
    h = (h * 31 + core.charCodeAt(i)) | 0;
  }
  return `f${(h >>> 0).toString(36)}`;
}

/**
 * 子树指纹：字段自身指纹 + 所有后代路径（去掉该字段前缀后的相对路径）与内容。
 * 用于判断“字段在新版本里整棵子树是否未变”。
 */
export function subtreeFingerprint(node: FieldNode, all: FieldNode[]): string {
  const prefix = node.path + (node.isArrayItem ? '' : '.');
  const descendants = all
    .filter((n) => n.path !== node.path && n.path.startsWith(prefix))
    .map((n) => `${n.path.slice(prefix.length)}=${fieldFingerprint(n)}`)
    .sort();
  let h = 0;
  const material = fieldFingerprint(node) + '|' + descendants.join('|');
  for (let i = 0; i < material.length; i++) {
    h = (h * 31 + material.charCodeAt(i)) | 0;
  }
  return `s${(h >>> 0).toString(36)}`;
}
