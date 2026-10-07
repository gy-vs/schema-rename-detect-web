/**
 * 领域核心：JSON Schema 演进分析。
 * 全部为纯函数，不依赖 node API，服务端和前端可以共用。
 */

export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type RawSchema = boolean | {[key: string]: unknown};

export type TypeTransitionKind =
  | 'same'
  | 'widened' // integer -> number 这类放宽
  | 'narrowed' // number -> integer，或无类型 -> 有类型
  | 'changed' // string -> integer 这种不兼容变化
  | 'untyped'; // 两边都没写 type

export type NodeKind = 'object' | 'array' | 'scalar';

/** 打平后的字段记录，路径与对象属性书写顺序无关（统一排序输出）。 */
export interface FieldRecord {
  /** 规范路径，例如 $.shipping.address.postcode、$.items[].sku */
  path: string;
  name: string;
  parentPath: string;
  depth: number;
  types: string[];
  nodeKind: NodeKind;
  format?: string;
  pattern?: string;
  /** enum / const 的稳定序列化值，排序后 */
  enumValues: string[];
  required: boolean;
  examples: unknown[];
  /** examples 的预分类结果，打分时直接用 */
  exampleClasses: ValueClass[];
  /** 同一父对象下的兄弟字段名（不含自己），排序 */
  siblingNames: string[];
  childNames: string[];
  /** oneOf/anyOf 合并而来时的变体数量 */
  variantCount?: number;
  /** 停在循环 $ref 上的终态节点，例如 category.children 指回 category */
  cycleRef?: string;
  externalRef?: string;
  brokenRef?: string;
  /** 归一化后的名称分词 */
  nameTokens: string[];
  nameKey: string;
}

export interface ValueClass {
  kind: 'null' | 'boolean' | 'integer' | 'number' | 'string' | 'array' | 'object';
  pattern?: string;
  lengthBucket?: number;
  magnitudeBucket?: number;
  integerLike?: boolean;
  keys?: string[];
  elements?: ValueClass[];
}

export interface FeatureScore {
  key: string;
  label: string;
  /** 权重（满分 100） */
  weight: number;
  /** 0..1 的原始相似度 */
  score: number;
  /** weight * score，四舍五入 */
  contribution: number;
  /** 可追溯的人类可读依据 */
  detail: string;
}

export interface AlternativeEdge {
  oldPath: string;
  oldName: string;
  newPath: string;
  newName: string;
  score: number;
  /** 与入选分数的差 */
  gap: number;
}

export type AssignmentNote =
  | {kind: 'unique'; text: string}
  | {kind: 'contested'; text: string; counterfactual: string};

export interface Proposal {
  oldPath: string;
  newPath: string;
  oldName: string;
  newName: string;
  score: number;
  features: FeatureScore[];
  typeTransition: TypeTransitionKind;
  /** 旧字段侧的备选新字段（含入选的那个） */
  runnerUps: AlternativeEdge[];
  /** 也想要这个新字段的其它旧字段 */
  competitors: AlternativeEdge[];
  assignmentNote: AssignmentNote;
}

export interface SamePathChange {
  path: string;
  name: string;
  typeTransition: TypeTransitionKind;
  changes: {
    code:
      | 'type'
      | 'format-added'
      | 'format-removed'
      | 'format-changed'
      | 'pattern-added'
      | 'pattern-changed'
      | 'pattern-removed'
      | 'enum-values-removed'
      | 'enum-values-added'
      | 'became-required'
      | 'became-optional';
    severity: 'blocker' | 'warning' | 'info';
    detail: string;
  }[];
}

export interface PairAnalysis {
  oldFields: FieldRecord[];
  newFields: FieldRecord[];
  proposals: Proposal[];
  unmatchedOld: FieldRecord[];
  unmatchedNew: FieldRecord[];
  samePathChanges: SamePathChange[];
  stats: {elapsedMs: number};
}

export type DecisionValue = 'confirmed' | 'rejected';

export interface ReviewDecision {
  oldPath: string;
  newPath: string;
  decision: DecisionValue;
}

export interface EffectiveDecision extends ReviewDecision {
  /** stored：审阅人在这对版本上直接保存；carried：从相邻版本的审阅沿用 */
  source: 'stored' | 'carried';
  carriedFrom?: {fromVersion: number; toVersion: number};
  /** active：当前有效；reset：沿用链路上字段又被改过，回到待确认 */
  status: 'active' | 'reset';
  resetReason?: string;
}

export type IssueSeverity = 'blocker' | 'warning' | 'info' | 'pending';

export interface CompatIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  oldPath?: string;
  newPath?: string;
}

export type Verdict = 'compatible' | 'incompatible' | 'undetermined';

export interface CompatibilityReport {
  verdict: Verdict;
  blockers: CompatIssue[];
  warnings: CompatIssue[];
  infos: CompatIssue[];
  pending: CompatIssue[];
  summary: {
    fieldsOld: number;
    fieldsNew: number;
    samePath: number;
    confirmedRenames: number;
    rejectedMoves: number;
    pendingProposals: number;
    removed: number;
    added: number;
  };
}

export class SchemaParseError extends Error {
  constructor(
    message: string,
    readonly index?: number,
  ) {
    super(message);
    this.name = 'SchemaParseError';
  }
}

/** 字段在“是否动过”判断里使用的稳定签名 */
export function fieldSignature(f: FieldRecord): string {
  return stableStringify({
    types: f.types,
    format: f.format ?? null,
    pattern: f.pattern ?? null,
    enumValues: f.enumValues,
    required: f.required,
    nodeKind: f.nodeKind,
    cycleRef: f.cycleRef ?? null,
  });
}

// ---- 小工具：规范 JSON（排序键），用于枚举比较、签名、稳定输出 ----
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value === undefined ? null : value;
}
