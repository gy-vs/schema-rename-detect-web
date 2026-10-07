/**
 * 审阅决定跨版本沿用。
 *
 * 场景：先审了 v7->v8，之后又出了 v9；现在打开 v7->v9。
 * - 字段在后续版本里没再动过：决定直接沿用（source=carried, status=active）。
 * - 字段在 v9 里又被改过（类型/enum/format/required/...），或承接链断了
 *   （字段被删、去向不明）：该候选回到待确认（status=reset），
 *     并在 resetReason 里写明是哪一跳、为什么失效。
 *
 * 每条“已保存的决定”独立沿相邻版本接力：
 * 同路径 -> 这一跳已确认的改名 -> 这一跳的最佳候选（未审阅的跳也能追路径）。
 * 直接保存在目标版本对上的决定永远优先。
 */
import {
  EffectiveDecision,
  FieldRecord,
  PairAnalysis,
  Proposal,
  ReviewDecision,
  fieldSignature,
} from './types';

export interface AdjacentStep {
  fromVersion: number;
  toVersion: number;
  analysis: PairAnalysis;
  /** 这一跳上已经保存的审阅决定（可能为空） */
  stored: ReviewDecision[];
}

interface TraceResult {
  startPath: string;
  endPath: string;
  decision: 'confirmed' | 'rejected';
  origin: {fromVersion: number; toVersion: number};
  reset: boolean;
  resetReason?: string;
}

export function effectiveDecisions(
  steps: AdjacentStep[],
  targetFromVersion: number,
  targetToVersion: number,
  targetStored: ReviewDecision[],
): EffectiveDecision[] {
  const result: EffectiveDecision[] = [];
  const directKeys = new Set(targetStored.map(d => key(d.oldPath, d.newPath)));
  for (const decision of targetStored) {
    result.push({...decision, source: 'stored', status: 'active'});
  }

  const relevant = steps.filter(
    step =>
      step.fromVersion >= targetFromVersion &&
      step.toVersion <= targetToVersion &&
      !(step.fromVersion === targetFromVersion && step.toVersion === targetToVersion),
  );

  // 去重种子：同一个 oldPath 在相邻跳上可能有多条决定，按 (版本跳, oldPath) 收集后逐条追
  const seenSeeds = new Set<string>();
  const carried: TraceResult[] = [];
  for (const step of relevant) {
    for (const decision of step.stored) {
      // 拒绝意味着“旧字段到此为止”，没有跨版本的字段映射可以沿用
      if (decision.decision === 'rejected') continue;
      const seedKey = `${step.fromVersion}:${key(decision.oldPath, decision.newPath)}`;
      if (seenSeeds.has(seedKey)) continue;
      seenSeeds.add(seedKey);
      const trace = traceDecision(decision, step, relevant);
      if (trace) carried.push(trace);
    }
  }

  // 同一起点可能追出多条：保留“未 reset”的；都 reset 保留 reset 原因最强的一条
  const byStart = new Map<string, TraceResult[]>();
  for (const trace of carried) {
    const list = byStart.get(trace.startPath) ?? [];
    list.push(trace);
    byStart.set(trace.startPath, list);
  }

  for (const list of byStart.values()) {
    const activeOne = list.find(t => !t.reset);
    const chosen = activeOne ?? list[0];
    if (directKeys.has(key(chosen.startPath, chosen.endPath))) continue;
    result.push({
      oldPath: chosen.startPath,
      newPath: chosen.endPath,
      decision: chosen.decision,
      source: 'carried',
      carriedFrom: chosen.origin,
      status: chosen.reset ? 'reset' : 'active',
      resetReason: chosen.resetReason,
    });
  }

  return result;
}

function traceDecision(
  seed: ReviewDecision,
  seedStep: AdjacentStep,
  steps: AdjacentStep[],
): TraceResult | undefined {
  const base: TraceResult = {
    startPath: seed.oldPath,
    endPath: seed.newPath,
    decision: seed.decision,
    origin: {fromVersion: seedStep.fromVersion, toVersion: seedStep.toVersion},
    reset: false,
  };

  // 种子跳直接建立 oldPath -> newPath 的映射（审阅人当时确认/拒绝的就是这条边）。
  // 继续追种子跳之后的相邻跳（同一起点可能有多条种子决定时，各自从自己的 seedStep 出发）。
  let current = seed.newPath;
  const remaining = steps.filter(step => step.fromVersion >= seedStep.toVersion);
  for (const step of remaining) {
    const move = traceAcrossStep(current, step);
    current = move.path;
    if (move.reset) {
      base.reset = true;
      base.resetReason = move.reason;
      base.endPath = current;
      return base;
    }
  }

  base.endPath = current;
  return base;
}

interface StepMove {
  path: string;
  reset: boolean;
  reason?: string;
}

function traceAcrossStep(currentPath: string, step: AdjacentStep): StepMove {
  const oldFields = step.analysis.oldFields;
  const newFields = step.analysis.newFields;
  const before = oldFields.find(f => f.path === currentPath);
  if (!before) {
    return {path: currentPath, reset: true, reason: `字段在 v${step.fromVersion} 中已不存在，承接链断裂`};
  }

  const decisionsByPair = new Map(step.stored.map(d => [key(d.oldPath, d.newPath), d.decision]));
  const proposalsByOld = indexByOld(step.analysis);

  // 同路径优先；其次本跳已确认的改名；最后最佳候选
  if (newFields.some(f => f.path === currentPath)) {
    return checkDestination(currentPath, currentPath, before, step, false);
  }
  const explicitConfirmed = (proposalsByOld.get(currentPath) ?? []).find(
    p => decisionsByPair.get(key(p.oldPath, p.newPath)) === 'confirmed',
  );
  const candidates = proposalsByOld.get(currentPath) ?? [];
  const via = explicitConfirmed ?? candidates[0];
  if (!via) {
    return {path: currentPath, reset: true, reason: `v${step.toVersion} 中找不到承接 ${currentPath} 的字段，承接链断裂`};
  }
  // 本跳审阅人已确认的改名/挪位：他看见并接受了定义变化；未审阅跳的定义变化要重置
  return checkDestination(currentPath, via.newPath, before, step, Boolean(explicitConfirmed));
}

function checkDestination(
  oldPath: string,
  newPath: string,
  before: FieldRecord,
  step: AdjacentStep,
  moveAcknowledged: boolean,
): StepMove {
  void oldPath;
  const after = step.analysis.newFields.find(f => f.path === newPath);
  if (!after) {
    return {path: newPath, reset: true, reason: `承接路径 ${newPath} 在 v${step.toVersion} 中不存在`};
  }
  const moved = newPath !== before.path;
  const signatureChanged = fieldSignature(before) !== fieldSignature(after);

  // 未在本跳审阅确认过的移动：只要定义也变了就重置（审阅人没在新版本上见过它）。
  // 即使移动的起点来自更早一次已确认的改名，也不代表这次变化被认可过。
  if (moved && signatureChanged && !moveAcknowledged) {
    return {
      path: newPath,
      reset: true,
      reason: `字段在 v${step.toVersion} 改名/移动到 ${newPath}，且类型/enum/format/required 等定义有变化`,
    };
  }
  if (!moved && signatureChanged) {
    return {
      path: newPath,
      reset: true,
      reason: `字段在 v${step.toVersion} 定义发生变化（类型/enum/format/required 等）`,
    };
  }
  return {path: newPath, reset: false};
}

function indexByOld(analysis: PairAnalysis): Map<string, Proposal[]> {
  const map = new Map<string, Proposal[]>();
  for (const proposal of analysis.proposals) {
    const list = map.get(proposal.oldPath) ?? [];
    list.push(proposal);
    map.set(proposal.oldPath, list);
  }
  for (const list of map.values()) list.sort((a, b) => b.score - a.score);
  return map;
}

function key(oldPath: string, newPath: string): string {
  return `${oldPath}=>${newPath}`;
}
