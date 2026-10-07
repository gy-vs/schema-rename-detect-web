// 引擎共享类型：结构在前后端一致，UI 直接渲染引擎返回的数据结构。

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {[key: string]: JsonValue};

export type JsonSchema = JsonValue;

export type Decision = 'confirmed' | 'rejected';

/** 展开 $ref、归一化键顺序后，schema 树上的一个字段节点。 */
export interface FieldNode {
  /** 从根对象开始的字段路径，数组项用 [] 占位，例如 shipping.postcode / items[].sku */
  path: string;
  /** 路径最后一段的字段名（数组项为 '[]'） */
  name: string;
  /** 字段在父级 properties 中的位置，仅用于展示，不参与匹配 */
  depth: number;
  types: string[];
  format?: string;
  required: boolean;
  enumValues?: JsonValue[];
  constValue?: JsonValue;
  examples: JsonValue[];
  /** 展开后兄弟字段名集合，用于“兄弟像不像”特征；与书写顺序无关 */
  siblings: string[];
  /** 数组项节点；对象嵌套通过路径表达 */
  isArrayItem: boolean;
  /** 展开经过的 $ref（含循环引用截断点），用于排查 */
  refs: string[];
  /** 命中循环引用时，循环指向的字段路径 */
  recursiveBackRef?: string;
}

export type ChangeKind =
  | 'type'
  | 'required'
  | 'enum'
  | 'format'
  | 'const'
  | 'added'
  | 'removed';

export type Severity = 'error' | 'warning' | 'info';

/** 同路径字段的逐项比对结论（与审阅无关，永远展示）。 */
export interface FieldChange {
  path: string;
  kind: ChangeKind;
  severity: Severity;
  message: string;
  oldValue?: JsonValue;
  newValue?: JsonValue;
}

/** 候选评分里的一个可解释维度。 */
export interface ScoreFeature {
  key: string;
  label: string;
  /** 该维度原始得分 0..1，未提供（如双方都没有 examples）时为 null */
  raw: number | null;
  weight: number;
  /** 实际计入总分 = raw * weight；raw 为 null 时为 0 */
  contribution: number;
  detail: string;
}

/** 落选备选，说明它为什么比入选方案差。 */
export interface RunnerUp {
  oldPath: string;
  newPath: string;
  score: number;
  gap: number;
  reason: string;
}

export type CandidateStatus = 'confirmed' | 'rejected' | 'pending';

/** 一个“可能改名 / 挪位置”的字段配对候选。 */
export interface Candidate {
  id: string;
  oldPath: string;
  newPath: string;
  score: number;
  /** 位置是否变化：父路径不同即为 moved */
  moved: boolean;
  features: ScoreFeature[];
  runnerUps: RunnerUp[];
  /** 该候选当前的审阅结论（含继承而来的结论） */
  status: CandidateStatus;
  /** 结论是否由相邻版本对的审阅记录沿用而来 */
  inherited: boolean;
  /** 沿用自哪一对版本，例如 7->8；直接审的为 null */
  inheritedFrom: string | null;
  note?: string;
}

/** 无法配对、被直接判定为新增 / 删除的字段。 */
export interface UnpairedField {
  path: string;
  kinds: string[];
  required: boolean;
  role: 'added' | 'removed';
}

export type Verdict = 'compatible' | 'incompatible' | 'undetermined';

/** 一条不兼容 / 待确认依据。 */
export interface Finding {
  severity: Severity;
  code:
    | 'field_removed'
    | 'required_field_added'
    | 'type_incompatible'
    | 'enum_narrowed'
    | 'format_changed'
    | 'const_changed'
    | 'required_tightened'
    | 'candidate_rejected'
    | 'review_pending'
    | 'recursive_structure';
  path: string;
  message: string;
}

export interface CompatibilityReport {
  verdict: Verdict;
  findings: Finding[];
  /** 被确认改名/移动而消除的删除，单独列出供排查 */
  renamedAway: string[];
  stats: {
    shared: number;
    candidatesTotal: number;
    candidatesConfirmed: number;
    candidatesRejected: number;
    candidatesPending: number;
    errors: number;
    warnings: number;
  };
  timingMs: number;
}

/** GET /api/families/:id/evolutions/:from-:to 的完整载荷。 */
export interface EvolutionResult {
  familyId: string;
  fromRevision: number;
  toRevision: number;
  samePathChanges: FieldChange[];
  candidates: Candidate[];
  unpaired: UnpairedField[];
  report: CompatibilityReport;
  review: {
    revision: number;
    updatedAt: string | null;
    updatedBy: string | null;
  };
}
