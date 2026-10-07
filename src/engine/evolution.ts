import type {
  Candidate,
  CandidateStatus,
  CompatibilityReport,
  FieldChange,
  FieldNode,
  Finding,
  JsonSchema,
  UnpairedField,
} from './types.js';
import {flattenSchema, subtreeFingerprint} from './parse.js';
import {matchFields, runnerUpsFor, type MatchOutput} from './matcher.js';
import {compareSamePath} from './changes.js';
import {typesCompatible} from './features.js';

export type StoredDecision = 'confirmed' | 'rejected';
export type DecisionMap = Map<string, StoredDecision>;

export interface ReviewState {
  /** candidateId -> confirmed/rejected */
  decisions: Record<string, StoredDecision>;
}

export interface HopData {
  oldNodes: FieldNode[];
  newNodes: FieldNode[];
  match: MatchOutput;
  pairByOld: Map<string, {oldPath: string; newPath: string}>;
  pairByNew: Map<string, {oldPath: string; newPath: string}>;
  fpOld: Map<string, string>;
  fpNew: Map<string, string>;
}

const hopCache = new WeakMap<object, Map<string, HopData>>();

/** 同一会话内相邻版本对的匹配结果做缓存，跨版本沿用时不重复计算。 */
export function getHopData(
  versions: {content: JsonSchema}[],
  fromRevision: number,
  toRevision: number,
): HopData {
  const cacheOwner = versions as unknown as object;
  let cache = hopCache.get(cacheOwner);
  if (!cache) {
    cache = new Map();
    hopCache.set(cacheOwner, cache);
  }
  const key = `${fromRevision}:${toRevision}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const oldNodes = flattenSchema(versions[fromRevision - 1].content);
  const newNodes = flattenSchema(versions[toRevision - 1].content);
  const match = matchFields(oldNodes, newNodes);
  const pairByOld = new Map(match.pairs.map((p) => [p.oldPath, p]));
  const pairByNew = new Map(match.pairs.map((p) => [p.newPath, p]));
  const data: HopData = {
    oldNodes,
    newNodes,
    match,
    pairByOld,
    pairByNew,
    fpOld: new Map(oldNodes.map((n) => [n.path, subtreeFingerprint(n, oldNodes)])),
    fpNew: new Map(newNodes.map((n) => [n.path, subtreeFingerprint(n, newNodes)])),
  };
  cache.set(key, data);
  return data;
}

export function candidateId(oldPath: string, newPath: string): string {
  const material = `${oldPath}->${newPath}`;
  let h = 5381;
  for (let i = 0; i < material.length; i++) {
    h = ((h << 5) + h + material.charCodeAt(i)) | 0;
  }
  return `c${(h >>> 0).toString(36)}`;
}

interface ResolvedDecision {
  status: CandidateStatus;
  inherited: boolean;
  inheritedFrom: string | null;
}

/**
 * 把 from->to 的一个候选沿相邻版本对追踪下去。
 *
 * 向前（confirmed）：字段在某一跳的起点要么有一条被确认的改名配对，要么路径未变。
 * 内容是否“在这一跳没动过”用相邻 hop 之间的子树指纹判断；改名那一跳天然不参与内容比较。
 * 向后（rejected）：对称地从终点倒推。
 * 任一跳里字段被动过（指纹变化 / 配对消失 / 结论缺失），结论回到 pending。
 */
export function resolveDecision(
  versions: {content: JsonSchema}[],
  directReviews: Map<number, DecisionMap>,
  fromRevision: number,
  toRevision: number,
  oldPath: string,
  newPath: string,
): ResolvedDecision {
  if (toRevision === fromRevision + 1) {
    const id = candidateId(oldPath, newPath);
    const explicit = directReviews.get(toRevision)?.get(id);
    if (explicit) return {status: explicit, inherited: false, inheritedFrom: null};
    return {status: 'pending', inherited: false, inheritedFrom: null};
  }

  // 从 from->from+1 起的相邻版本对
  const hops: HopData[] = [];
  for (let rev = fromRevision + 1; rev <= toRevision; rev++) {
    hops.push(getHopData(versions, rev - 1, rev));
  }

  // ---- 已确认链：从第一个 hop 的旧路径出发 ----
  let curPath = oldPath;
  let decisionHopRev = -1; // 最后一次见到 confirmed 结论的 hop
  let prevFp: string | undefined;
  let okForward = true;
  for (let i = 0; i < hops.length; i++) {
    const hopRev = fromRevision + 1 + i;
    const hop = hops[i];
    const startFp = hop.fpOld.get(curPath);

    // 与上一跳终点比指纹（第一跳没有上一跳，改名跳同样不比较）
    if (i > 0 && prevFp !== undefined && startFp !== prevFp) {
      okForward = false;
      break;
    }

    let nextPath: string;
    const pair = hop.pairByOld.get(curPath);
    if (pair) {
      const decision = directReviews
        .get(hopRev)
        ?.get(candidateId(curPath, pair.newPath));
      if (decision !== 'confirmed') {
        okForward = false;
        break;
      }
      decisionHopRev = hopRev;
      nextPath = pair.newPath;
      prevFp = undefined; // 改名跳结束后，下一跳起点的指纹从新路径重新取
    } else if (hop.fpNew.has(curPath)) {
      // 这一跳路径没变（同名字段），不是改名决策，不写 decisionHopRev
      nextPath = curPath;
      prevFp = hop.fpNew.get(curPath);
    } else {
      okForward = false;
      break;
    }
    curPath = nextPath;
  }
  if (okForward && curPath === newPath && decisionHopRev > 0) {
    return {
      status: 'confirmed',
      inherited: decisionHopRev !== toRevision,
      inheritedFrom:
        decisionHopRev !== toRevision ? `${fromRevision}->${decisionHopRev}` : null,
    };
  }

  // ---- 已拒绝链：从最后一个 hop 的新路径倒推 ----
  let curNew = newPath;
  let rejectHopRev = -1;
  let prevFpBack: string | undefined;
  let okBackward = true;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hopRev = fromRevision + 1 + i;
    const hop = hops[i];
    const endFp = hop.fpNew.get(curNew);
    if (i < hops.length - 1 && prevFpBack !== undefined && endFp !== prevFpBack) {
      okBackward = false;
      break;
    }
    const pair = hop.pairByNew.get(curNew);
    let prevPath: string;
    if (pair) {
      const decision = directReviews
        .get(hopRev)
        ?.get(candidateId(pair.oldPath, curNew));
      if (decision !== 'rejected') {
        okBackward = false;
        break;
      }
      rejectHopRev = hopRev;
      prevPath = pair.oldPath;
      prevFpBack = undefined;
    } else if (hop.fpOld.has(curNew)) {
      prevPath = curNew;
      prevFpBack = hop.fpOld.get(curNew);
    } else {
      okBackward = false;
      break;
    }
    curNew = prevPath;
  }
  if (okBackward && curNew === oldPath && rejectHopRev > 0) {
    return {
      status: 'rejected',
      inherited: rejectHopRev !== toRevision,
      inheritedFrom:
        rejectHopRev !== toRevision
          ? `${rejectHopRev - 1}->${rejectHopRev}`
          : null,
    };
  }

  return {status: 'pending', inherited: false, inheritedFrom: null};
}

function parentPath(path: string): string {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(0, i);
}

function isLeaf(node: FieldNode): boolean {
  return !node.types.some((t) => t === 'object' || t === 'array');
}

export interface EvolutionInput {
  familyId: string;
  fromRevision: number;
  toRevision: number;
  versions: {revision: number; content: JsonSchema}[];
  /** 目标版本对自身的审阅记录（可能是 PUT 更新中的临时覆盖） */
  directDecisions: DecisionMap;
  /** 其他相邻版本对的审阅记录：key 为该 hop 的“新版本号” */
  allReviews: Map<number, DecisionMap>;
}

/** 两个版本完整差异分析的入口，纯函数。 */
export function analyzeEvolution(input: EvolutionInput): {
  samePathChanges: FieldChange[];
  candidates: Candidate[];
  unpaired: UnpairedField[];
  report: CompatibilityReport;
} {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const {versions, fromRevision, toRevision} = input;
  const adjacent = toRevision === fromRevision + 1;
  // 只有相邻区间的直接审阅才属于 hop 链；非相邻区间自身的结论单独优先判断，
  // 不能污染最后一跳的链上审阅。
  const reviewMap = new Map(input.allReviews);
  if (adjacent) reviewMap.set(toRevision, input.directDecisions);

  const direct = getHopData(versions, fromRevision, toRevision);
  const oldMap = new Map(direct.oldNodes.map((n) => [n.path, n]));
  const newMap = new Map(direct.newNodes.map((n) => [n.path, n]));

  // 同路径变化
  const samePathChanges: FieldChange[] = [];
  const confirmedChanges = new Map<string, FieldChange[]>();
  for (const [path, oldNode] of oldMap) {
    const newNode = newMap.get(path);
    if (newNode) samePathChanges.push(...compareSamePath(oldNode, newNode));
  }

  // 组装候选
  const candidates: Candidate[] = [];
  for (const p of direct.match.pairs) {
    const oldNode = oldMap.get(p.oldPath)!;
    const newNode = newMap.get(p.newPath)!;
    const cid = candidateId(p.oldPath, p.newPath);
    let resolved: ResolvedDecision;
    if (adjacent) {
      resolved = {
        status: (input.directDecisions.get(cid) ?? 'pending') as CandidateStatus,
        inherited: false,
        inheritedFrom: null,
      };
    } else {
      // 非相邻区间：该区间自身的显式结论优先；没有再沿相邻跳沿用
      const explicit = input.directDecisions.get(cid);
      resolved = explicit
        ? {status: explicit, inherited: false, inheritedFrom: null}
        : resolveDecision(
            versions,
            reviewMap,
            fromRevision,
            toRevision,
            p.oldPath,
            p.newPath,
          );
    }
    const pairChanges = compareSamePath(oldNode, newNode);
    if (resolved.status === 'confirmed' && pairChanges.length) {
      confirmedChanges.set(p.newPath, pairChanges);
    }
    candidates.push({
      id: candidateId(p.oldPath, p.newPath),
      oldPath: p.oldPath,
      newPath: p.newPath,
      score: p.edge.score,
      moved: parentPath(p.oldPath) !== parentPath(p.newPath),
      features: p.edge.features,
      runnerUps: runnerUpsFor(p.oldPath, p.newPath, p.edge.score, direct.match.edges, direct.match.pairs),
      status: resolved.status,
      inherited: resolved.inherited,
      inheritedFrom: resolved.inheritedFrom,
      note: pairChanges.length
        ? pairChanges.map((c) => `⚠ ${c.message}`).join('；')
        : undefined,
    });
  }
  candidates.sort((a, b) => b.score - a.score || (a.oldPath < b.oldPath ? -1 : 1));

  const confirmed = candidates.filter((c) => c.status === 'confirmed');
  const rejected = candidates.filter((c) => c.status === 'rejected');
  const pending = candidates.filter((c) => c.status === 'pending');

  // 未配对字段（折叠掉的后代不报）
  const unpaired: UnpairedField[] = [];
  for (const path of direct.match.unmatchedOld) {
    const node = oldMap.get(path)!;
    unpaired.push({
      path,
      kinds: node.types,
      required: node.required,
      role: 'removed',
    });
  }
  for (const path of direct.match.unmatchedNew) {
    const node = newMap.get(path)!;
    unpaired.push({path, kinds: node.types, required: node.required, role: 'added'});
  }

  // 结论
  const findings: Finding[] = [];
  const renamedAway: string[] = [];
  const removedPaths = new Set(direct.match.unmatchedOld);
  const addedPaths = new Set(direct.match.unmatchedNew);

  for (const c of confirmed) renamedAway.push(c.oldPath);
  for (const c of rejected) {
    removedPaths.add(c.oldPath);
    addedPaths.add(c.newPath);
    findings.push({
      severity: 'error',
      code: 'candidate_rejected',
      path: `${c.oldPath} / ${c.newPath}`,
      message: `配对被拒绝：旧字段 ${c.oldPath} 视为删除、新字段 ${c.newPath} 视为新增`,
    });
  }
  for (const c of pending) {
    findings.push({
      severity: 'warning',
      code: 'review_pending',
      path: `${c.oldPath} / ${c.newPath}`,
      message: `候选 ${c.oldPath} → ${c.newPath}（得分 ${c.score.toFixed(2)}）尚未审阅，无法下最终结论`,
    });
  }

  for (const path of [...removedPaths].sort()) {
    const node = oldMap.get(path);
    if (node && isLeaf(node)) {
      findings.push({
        severity: 'error',
        code: 'field_removed',
        path,
        message: `字段 ${path} 在新版本中删除且未确认改名：旧数据该列无法被读取`,
      });
    }
  }
  for (const path of [...addedPaths].sort()) {
    const node = newMap.get(path);
    if (node && node.required && isLeaf(node)) {
      findings.push({
        severity: 'error',
        code: 'required_field_added',
        path,
        message: `新增 required 字段 ${path}：旧数据没有这个字段，写入新 schema 前必须补值`,
      });
    } else if (node && isLeaf(node)) {
      findings.push({
        severity: 'info',
        code: 'field_removed',
        path,
        message: `新增可选字段 ${path}，旧数据不受影响`,
      });
    }
  }

  // 同路径 error + 已确认配对上的类型/enum 变化 error
  for (const change of samePathChanges) {
    if (change.severity === 'error') {
      findings.push({
        severity: 'error',
        code:
          change.kind === 'type'
            ? 'type_incompatible'
            : change.kind === 'enum'
              ? 'enum_narrowed'
              : change.kind === 'format'
                ? 'format_changed'
                : change.kind === 'const'
                  ? 'const_changed'
                  : 'required_tightened',
        path: change.path,
        message: change.message,
      });
    }
  }
  for (const [path, changes] of confirmedChanges) {
    for (const change of changes) {
      if (change.severity === 'error') {
        findings.push({
          severity: 'error',
          code:
            change.kind === 'type'
              ? 'type_incompatible'
              : change.kind === 'enum'
                ? 'enum_narrowed'
                : change.kind === 'const'
                  ? 'const_changed'
                  : 'required_tightened',
          path,
          message: `改名字段 ${path}：${change.message}`,
        });
      }
    }
  }

  // 循环引用：给确定结论并在报告中留痕
  for (const node of direct.oldNodes) {
    if (node.recursiveBackRef) {
      findings.push({
        severity: 'info',
        code: 'recursive_structure',
        path: node.path,
        message: `旧 schema 在 ${node.path} 处存在循环 $ref（${node.recursiveBackRef}），按引用截断后的确定结构比对`,
      });
    }
  }
  for (const node of direct.newNodes) {
    if (node.recursiveBackRef) {
      findings.push({
        severity: 'info',
        code: 'recursive_structure',
        path: node.path,
        message: `新 schema 在 ${node.path} 处存在循环 $ref（${node.recursiveBackRef}），按引用截断后的确定结构比对`,
      });
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const verdict =
    errors > 0
      ? 'incompatible'
      : pending.length > 0
        ? 'undetermined'
        : 'compatible';

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const report: CompatibilityReport = {
    verdict,
    findings,
    renamedAway,
    stats: {
      shared: direct.oldNodes.filter((n) => newMap.has(n.path)).length,
      candidatesTotal: candidates.length,
      candidatesConfirmed: confirmed.length,
      candidatesRejected: rejected.length,
      candidatesPending: pending.length,
      errors,
      warnings,
    },
    timingMs: Number((t1 - t0).toFixed(2)),
  };

  return {samePathChanges, candidates, unpaired, report};
}

export {typesCompatible};
