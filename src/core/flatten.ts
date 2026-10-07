/**
 * 把 JSON Schema 打平成字段记录列表。
 *
 * 关键约定：
 * - 只解析本地 #/$defs、definitions 下的 $ref；外部 ref 记成 externalRef，不猜结构。
 * - 找不到的 ref 记成 brokenRef，仍然产出字段（审阅人需要看见它）。
 * - ref 在同一条祖先链上第二次出现时停止下钻，记为 cycleRef 终态节点；
 *   category.children -> category 这种循环给出确定结果，不会无限递归。
 * - allOf 内联合并；oneOf/anyOf 按变体合并（类型取并集，属性合并）。
 * - 输出按规范路径排序，properties 的书写顺序不影响结果。
 *
 * ref 栈的语义是“从根到当前节点这一条链上经过的 ref 集合”，
 * 每个子节点从父栈复制自己的栈，兄弟之间绝不共享子树跟到的 ref。
 */
import {FieldRecord, NodeKind, RawSchema, SchemaParseError} from './types';
import {classify} from './values';
import {tokenize} from './text';

export interface ParseResult {
  root: Record<string, unknown>;
}

/** 解析并做最基本的形状校验；不做 JSON Schema 元校验（草案允许的写法很多）。 */
export function parseSchemaText(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const index = (error as {at?: number}).at;
    throw new SchemaParseError(
      `JSON 解析失败：${(error as Error).message}`,
      typeof index === 'number' ? index : undefined,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SchemaParseError('Schema 根节点必须是 JSON 对象');
  }
  return {root: value as Record<string, unknown>};
}

interface FlatNode {
  types: string[];
  format?: string;
  pattern?: string;
  enumValues: string[];
  examples: unknown[];
  childProperties: Map<string, RawSchema>;
  requiredNames: Set<string>;
  itemSchemas: RawSchema[];
  variantCount: number;
  cycleRef?: string;
  externalRef?: string;
  brokenRef?: string;
}

function blankNode(): FlatNode {
  return {
    types: [],
    enumValues: [],
    examples: [],
    childProperties: new Map(),
    requiredNames: new Set(),
    itemSchemas: [],
    variantCount: 0,
  };
}

function asSchema(value: unknown): RawSchema | undefined {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function lookupRef(root: Record<string, unknown>, ref: string): RawSchema | undefined {
  if (!ref.startsWith('#')) return undefined;
  let current: unknown = root;
  const parts = ref
    .slice(1)
    .split('/')
    .filter(part => part.length > 0);
  for (const rawPart of parts) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return asSchema(current);
}

function normalizeTypes(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function uniquePush<T>(target: T[], values: T[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function collectExamples(target: unknown[], s: Record<string, unknown>): void {
  if (Array.isArray(s.examples)) target.push(...(s.examples as unknown[]));
  if ('example' in s) target.push(s.example);
}

/** 循环终态节点只抄标量元数据，绝不碰 properties/items/$ref/allOf（那些会重新引入循环）。 */
function copyScalarMeta(acc: FlatNode, s: Record<string, unknown>): void {
  uniquePush(acc.types, normalizeTypes(s.type));
  if (typeof s.format === 'string' && !acc.format) acc.format = s.format;
  if (typeof s.pattern === 'string' && !acc.pattern) acc.pattern = s.pattern;
  if (Array.isArray(s.enum)) {
    for (const value of s.enum as unknown[]) {
      const serialized = JSON.stringify(value);
      if (!acc.enumValues.includes(serialized)) acc.enumValues.push(serialized);
    }
  }
  collectExamples(acc.examples, s);
}

function mergeNode(acc: FlatNode, part: FlatNode): void {
  uniquePush(acc.types, part.types);
  if (!acc.format && part.format) acc.format = part.format;
  if (!acc.pattern && part.pattern) acc.pattern = part.pattern;
  uniquePush(acc.enumValues, part.enumValues);
  for (const [name, child] of part.childProperties) {
    if (!acc.childProperties.has(name)) acc.childProperties.set(name, child);
  }
  for (const name of part.requiredNames) acc.requiredNames.add(name);
  acc.itemSchemas.push(...part.itemSchemas);
  acc.variantCount += part.variantCount;
  if (part.examples.length > 0) acc.examples.push(...part.examples);
  if (!acc.cycleRef && part.cycleRef) acc.cycleRef = part.cycleRef;
  if (!acc.externalRef && part.externalRef) acc.externalRef = part.externalRef;
  if (!acc.brokenRef && part.brokenRef) acc.brokenRef = part.brokenRef;
}

/**
 * 物化一个节点：把 $ref/allOf/oneOf/anyOf 展开到本层。
 * 不递归下钻属性——属性/数组项交给树遍历，用各自精确的 ref 栈处理。
 *
 * 本节点上的 $ref（含 allOf/oneOf 链上传递跟到的 ref）会在 followedRefs 里回传，
 * 供树遍历把它们压进“每个子节点各自的”栈。
 * cycleRef/externalRef/brokenRef 表示本节点必须停在终态、不再下钻。
 */
function materialize(
  schema: RawSchema,
  root: Record<string, unknown>,
  stack: ReadonlySet<string>,
  followedRefs: Set<string>,
): FlatNode {
  const acc = blankNode();
  mergeLevel(acc, schema, root, stack, followedRefs, true);
  if (acc.enumValues.length > 1) acc.enumValues.sort();
  return acc;
}

function mergeLevel(
  acc: FlatNode,
  schema: RawSchema,
  root: Record<string, unknown>,
  stack: ReadonlySet<string>,
  followedRefs: Set<string>,
  /** allOf/直接 $ref 的内联属性视为在本节点同一位置；oneOf/anyOf 变体也一样（结构合并） */
  _inline: boolean,
): void {
  if (schema === false || schema === true) return;
  const s = schema as Record<string, unknown>;

  const ownRef = typeof s.$ref === 'string' ? (s.$ref as string) : undefined;
  if (ownRef) {
    if (!ownRef.startsWith('#')) {
      acc.externalRef = ownRef;
    } else if (stack.has(ownRef)) {
      // 祖先链上已经经过这个 ref：本节点是循环终态。
      // 保留目标的标量元数据（type/enum/format/...），但不展开它的子结构。
      acc.cycleRef = ownRef;
      const target = lookupRef(root, ownRef);
      if (target !== undefined && target !== true && target !== false) {
        copyScalarMeta(acc, target);
      }
    } else {
      const target = lookupRef(root, ownRef);
      if (target === undefined) {
        acc.brokenRef = ownRef;
      } else {
        followedRefs.add(ownRef);
        const nextStack = new Set(stack);
        nextStack.add(ownRef);
        mergeLevel(acc, target, root, nextStack, followedRefs, true);
      }
    }
  }

  uniquePush(acc.types, normalizeTypes(s.type));
  if (typeof s.format === 'string' && !acc.format) acc.format = s.format as string;
  if (typeof s.pattern === 'string' && !acc.pattern) acc.pattern = s.pattern as string;

  if (Array.isArray(s.enum)) {
    for (const value of s.enum as unknown[]) {
      const serialized = JSON.stringify(value);
      if (!acc.enumValues.includes(serialized)) acc.enumValues.push(serialized);
    }
  }
  if ('const' in s) {
    const serialized = JSON.stringify(s.const);
    if (!acc.enumValues.includes(serialized)) acc.enumValues.push(serialized);
  }

  collectExamples(acc.examples, s);

  if (s.properties && typeof s.properties === 'object') {
    for (const [name, childRaw] of Object.entries(s.properties as Record<string, unknown>)) {
      const child = asSchema(childRaw);
      if (child !== undefined) acc.childProperties.set(name, child);
    }
  }
  if (Array.isArray(s.required)) {
    for (const name of s.required as unknown[]) {
      if (typeof name === 'string') acc.requiredNames.add(name);
    }
  }
  if (s.items !== undefined) {
    if (Array.isArray(s.items)) {
      for (const itemRaw of s.items) {
        const item = asSchema(itemRaw);
        if (item !== undefined) acc.itemSchemas.push(item);
      }
    } else {
      const item = asSchema(s.items);
      if (item !== undefined) acc.itemSchemas.push(item);
    }
  }
  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    const extra = asSchema(s.additionalProperties);
    if (extra !== undefined) acc.itemSchemas.push(extra);
  }

  if (Array.isArray(s.allOf)) {
    for (const partRaw of s.allOf) {
      const part = asSchema(partRaw);
      if (part !== undefined) mergeLevel(acc, part, root, stack, followedRefs, true);
    }
  }

  const variants: unknown[] = [];
  if (Array.isArray(s.anyOf)) variants.push(...s.anyOf);
  if (Array.isArray(s.oneOf)) variants.push(...s.oneOf);
  for (const variantRaw of variants) {
    const variant = asSchema(variantRaw);
    if (variant === undefined) continue;
    acc.variantCount += 1;
    const part = blankNode();
    const partRefs = new Set<string>();
    mergeLevel(part, variant, root, stack, partRefs, true);
    mergeNode(acc, part);
    for (const ref of partRefs) followedRefs.add(ref);
  }
}

function nodeKindOf(types: string[], hasChildren: boolean, hasItems: boolean): NodeKind {
  if (types.includes('object') || hasChildren) return 'object';
  if (types.includes('array') || hasItems) return 'array';
  return 'scalar';
}

interface EntryMeta {
  path: string;
  name: string;
  parentPath: string;
  depth: number;
  required: boolean;
}

export function flattenSchema(root: Record<string, unknown>): FieldRecord[] {
  const fields: FieldRecord[] = [];

  /** 输出一个已经物化好的 FlatNode 及其子树。 */
  const emitNode = (node: FlatNode, nodeMeta: EntryMeta, nodeStack: ReadonlySet<string>): void => {
    const childNames = [...node.childProperties.keys()].sort();
    const record: FieldRecord = {
      path: nodeMeta.path,
      name: nodeMeta.name,
      parentPath: nodeMeta.parentPath,
      depth: nodeMeta.depth,
      types: node.types.slice().sort(),
      nodeKind: nodeKindOf(node.types, node.childProperties.size > 0, node.itemSchemas.length > 0),
      format: node.format,
      pattern: node.pattern,
      enumValues: node.enumValues,
      required: nodeMeta.required,
      examples: dedupeExamples(node.examples),
      exampleClasses: [],
      siblingNames: [],
      childNames,
      variantCount: node.variantCount > 0 ? node.variantCount : undefined,
      cycleRef: node.cycleRef,
      externalRef: node.externalRef,
      brokenRef: node.brokenRef,
      nameTokens: tokenize(nodeMeta.name),
      nameKey: nodeMeta.name.toLowerCase(),
    };
    record.exampleClasses = record.examples.map(classify);
    fields.push(record);

    if (node.cycleRef || node.externalRef || node.brokenRef) return;

    const childStackBase = new Set(nodeStack);
    for (const [name, childSchema] of [...node.childProperties.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    )) {
      const followed = new Set<string>();
      const childNode = materialize(childSchema, root, childStackBase, followed);
      const nextStack = new Set(childStackBase);
      for (const ref of followed) nextStack.add(ref);
      emitNode(
        childNode,
        {
          path: `${nodeMeta.path}.${name}`,
          name,
          parentPath: nodeMeta.path,
          depth: nodeMeta.depth + 1,
          required: node.requiredNames.has(name),
        },
        nextStack,
      );
    }
    if (node.itemSchemas.length > 0) {
      const merged = blankNode();
      const itemRefs = new Set<string>();
      for (const itemSchema of node.itemSchemas) {
        mergeNode(merged, materialize(itemSchema, root, childStackBase, itemRefs));
      }
      const itemStack = new Set(childStackBase);
      for (const ref of itemRefs) itemStack.add(ref);
      emitNode(
        merged,
        {
          path: `${nodeMeta.path}[]`,
          name: '[]',
          parentPath: nodeMeta.path,
          depth: nodeMeta.depth + 1,
          required: true,
        },
        itemStack,
      );
    }
  };

  const rootFollowed = new Set<string>();
  emitNode(
    materialize(root, root, new Set<string>(), rootFollowed),
    {path: '$', name: '$', parentPath: '', depth: 0, required: true},
    new Set<string>(),
  );

  // sibling 回填
  const byParent = new Map<string, FieldRecord[]>();
  for (const field of fields) {
    if (field.parentPath === '') continue;
    const group = byParent.get(field.parentPath) ?? [];
    group.push(field);
    byParent.set(field.parentPath, group);
  }
  for (const group of byParent.values()) {
    const names = group.map(f => f.name).sort();
    for (const field of group) {
      field.siblingNames = names.filter(n => n !== field.name);
    }
  }

  fields.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return fields;
}

function dedupeExamples(examples: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const example of examples) {
    const key = JSON.stringify(example);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(example);
    }
  }
  return out.slice(0, 10);
}

export function loadAndFlatten(text: string): FieldRecord[] {
  const {root} = parseSchemaText(text);
  return flattenSchema(root);
}
