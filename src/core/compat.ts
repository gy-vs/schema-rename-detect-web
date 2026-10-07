/**
 * 新版本能否安全替换旧版本的最终判断。
 *
 * 规则（每条都要能在输出里追到来源）：
 * - 同路径变化：类型收窄/跨类型、format 改了、enum 移除取值、可选变必填 -> 阻断。
 * - 确认是改名/挪位置的字段：旧数据按新名字读得出来，不算删除；
 *   但配对上若仍有类型收窄、format 变化、enum 移除，这些阻断照旧报。
 * - 被拒绝的配对：旧字段按“删除”、新字段按“新增”处理；新增字段如果必填 -> 阻断。
 * - 还没审的候选：报 pending，最终结论是 undetermined，不替人拍板。
 * - 没人配对、也没被拒绝的旧字段：删除；必填旧字段删除仍是阻断
 *   （旧数据里的键读不出来，写入侧通常也不再接受），非必填删除是 warning。
 */
import {
  CompatIssue,
  CompatibilityReport,
  EffectiveDecision,
  PairAnalysis,
  Proposal,
  Verdict,
} from './types';
import {typeChangeIsBlocker} from './types-compat';

export interface CompatInput {
  analysis: PairAnalysis;
  /** 对这对版本生效的审阅决定（含沿用/重置状态） */
  decisions: EffectiveDecision[];
}

export function buildCompatibility({analysis, decisions}: CompatInput): CompatibilityReport {
  const blockers: CompatIssue[] = [];
  const warnings: CompatIssue[] = [];
  const infos: CompatIssue[] = [];
  const pending: CompatIssue[] = [];

  const active = new Map<string, EffectiveDecision>();
  for (const decision of decisions) {
    if (decision.status === 'active') active.set(key(decision.oldPath, decision.newPath), decision);
  }

  // 1) 同路径变化
  for (const change of analysis.samePathChanges) {
    for (const item of change.changes) {
      const issue: CompatIssue = {
        severity: item.severity === 'info' ? 'info' : item.severity === 'warning' ? 'warning' : 'blocker',
        code: `same-path/${item.code}`,
        message: `${change.path}：${item.detail}`,
        oldPath: change.path,
        newPath: change.path,
      };
      pushIssue(blockers, warnings, infos, issue);
    }
  }

  const proposalByOld = new Map(analysis.proposals.map(p => [p.oldPath, p]));
  const proposalByNew = new Map(analysis.proposals.map(p => [p.newPath, p]));
  const confirmedOld = new Set<string>();
  const confirmedNew = new Set<string>();
  const rejectedOld = new Set<string>();
  const rejectedNew = new Set<string>();
  const resetPairs = new Set<string>();

  for (const decision of decisions) {
    if (decision.status === 'reset') {
      resetPairs.add(key(decision.oldPath, decision.newPath));
    }
  }

  // 2) 逐条候选：确认 / 拒绝 / 待确认 / 沿用后重置
  for (const proposal of analysis.proposals) {
    const decision = active.get(key(proposal.oldPath, proposal.newPath));
    if (decision?.decision === 'confirmed') {
      confirmedOld.add(proposal.oldPath);
      confirmedNew.add(proposal.newPath);
      infos.push({
        severity: 'info',
        code: 'renamed/confirmed',
        message: renameMessage(proposal, decision),
        oldPath: proposal.oldPath,
        newPath: proposal.newPath,
      });
      // 即使确认改名，类型/enum/format 的阻断仍要报
      collectProposalBlockers(proposal, blockers, warnings);
    } else if (decision?.decision === 'rejected') {
      rejectedOld.add(proposal.oldPath);
      rejectedNew.add(proposal.newPath);
      blockers.push({
        severity: 'blocker',
        code: 'pair/rejected',
        message: `${proposal.oldPath} 与 ${proposal.newPath} 的改名/移动被审阅拒绝：按“删除旧字段 + 新增字段”处理，旧数据 ${proposal.oldName} 无法按新结构读出。`,
        oldPath: proposal.oldPath,
        newPath: proposal.newPath,
      });
    } else {
      pending.push({
        severity: 'pending',
        code: resetPairs.has(key(proposal.oldPath, proposal.newPath)) ? 'review/reset' : 'review/pending',
        message:
          (resetPairs.has(key(proposal.oldPath, proposal.newPath))
            ? `沿用的决定已失效（${proposal.oldPath} -> ${proposal.newPath} 之后又被改过），`
            : `候选改名尚未审阅（${proposal.oldName} 与 ${proposal.newName} 匹配度 ${proposal.score} 分），`) +
          '确认前无法判定旧数据能否按新名字读出。',
        oldPath: proposal.oldPath,
        newPath: proposal.newPath,
      });
    }
  }

  // 3) 未配对的旧字段 = 删除（被拒绝的旧字段也在这里收口，避免重复计数）
  for (const field of analysis.unmatchedOld) {
    const severity = field.required ? 'blocker' : 'warning';
    blockers.push({
      severity,
      code: 'field/removed',
      message: `${field.path} 在新版本中删除${field.required ? '（旧数据里的必填字段）' : ''}，没有任何候选新字段承接。`,
      oldPath: field.path,
    });
  }
  // 被拒绝的旧字段：删除语义（上面 pair/rejected 已报阻断，这里补一条可读删除项）
  for (const oldPath of rejectedOld) {
    if (confirmedOld.has(oldPath) || analysis.unmatchedOld.some(f => f.path === oldPath)) continue;
    warnings.push({
      severity: 'warning',
      code: 'field/removed-rejected',
      message: `${oldPath} 因改名被拒绝，按删除处理。`,
      oldPath,
    });
  }

  // 4) 未配对的新字段 = 新增；必填新增阻断
  for (const field of analysis.unmatchedNew) {
    if (field.required) {
      blockers.push({
        severity: 'blocker',
        code: 'field/added-required',
        message: `${field.path} 是新增的必填字段，旧数据没有这个键，无法直接写入新版本。`,
        newPath: field.path,
      });
    } else {
      infos.push({
        severity: 'info',
        code: 'field/added',
        message: `${field.path} 为新增可选字段。`,
        newPath: field.path,
      });
    }
  }
  for (const newPath of rejectedNew) {
    if (confirmedNew.has(newPath) || analysis.unmatchedNew.some(f => f.path === newPath)) continue;
    const field = analysis.newFields.find(f => f.path === newPath);
    const message = `${newPath} 因改名被拒绝，按新增字段处理${field?.required ? '（必填，旧数据无法直接写入）' : '（可选）'}。`;
    blockers.push({
      severity: field?.required ? 'blocker' : 'warning',
      code: 'field/added-rejected',
      message,
      newPath,
    });
  }

  void proposalByOld;
  void proposalByNew;

  let verdict: Verdict;
  if (blockers.length > 0) verdict = 'incompatible';
  else if (pending.length > 0) verdict = 'undetermined';
  else verdict = 'compatible';

  return {
    verdict,
    blockers,
    warnings,
    infos,
    pending,
    summary: {
      fieldsOld: analysis.oldFields.length - 1, // 去掉根 $
      fieldsNew: analysis.newFields.length - 1,
      samePath: samePathCount(analysis),
      confirmedRenames: confirmedOld.size,
      rejectedMoves: rejectedOld.size,
      pendingProposals: pending.length,
      removed: analysis.unmatchedOld.length + rejectedOld.size,
      added: analysis.unmatchedNew.length + rejectedNew.size,
    },
  };
}

function samePathCount(analysis: PairAnalysis): number {
  const oldPaths = new Set(analysis.oldFields.map(f => f.path));
  return analysis.newFields.filter(f => f.path !== '$' && oldPaths.has(f.path)).length;
}

function collectProposalBlockers(proposal: Proposal, blockers: CompatIssue[], warnings: CompatIssue[]): void {
  if (typeChangeIsBlocker(proposal.typeTransition)) {
    blockers.push({
      severity: 'blocker',
      code: 'rename/type-incompatible',
      message: `${proposal.oldPath} -> ${proposal.newPath} 虽被确认为改名，但类型变化不兼容（${proposal.typeTransition}），旧值不能安全读作新值。`,
      oldPath: proposal.oldPath,
      newPath: proposal.newPath,
    });
  }
  for (const feature of proposal.features) {
    if (feature.key === 'format' && feature.score === 0) {
      blockers.push({
        severity: 'blocker',
        code: 'rename/format-changed',
        message: `${proposal.oldPath} -> ${proposal.newPath}：${feature.detail}，确认改名也不能消除格式不兼容。`,
        oldPath: proposal.oldPath,
        newPath: proposal.newPath,
      });
    }
    if (feature.key === 'enum' && feature.detail.includes('移除')) {
      blockers.push({
        severity: 'blocker',
        code: 'rename/enum-values-removed',
        message: `${proposal.oldPath} -> ${proposal.newPath}：${feature.detail}，旧数据的枚举值在新版本里非法。`,
        oldPath: proposal.oldPath,
        newPath: proposal.newPath,
      });
    }
    if (feature.key === 'required' && feature.score === 0) {
      warnings.push({
        severity: 'warning',
        code: 'rename/required-changed',
        message: `${proposal.oldPath} -> ${proposal.newPath}：required 不一致（${feature.detail}）。`,
        oldPath: proposal.oldPath,
        newPath: proposal.newPath,
      });
    }
  }
}

function renameMessage(proposal: Proposal, decision: EffectiveDecision): string {
  const suffix =
    decision.source === 'carried' && decision.carriedFrom
      ? `（决定从 v${decision.carriedFrom.fromVersion}->v${decision.carriedFrom.toVersion} 沿用）`
      : '';
  return `已确认改名/移动：${proposal.oldPath} -> ${proposal.newPath}，旧数据按新名字读取，不计为删除。${suffix}`;
}

function pushIssue(
  blockers: CompatIssue[],
  warnings: CompatIssue[],
  infos: CompatIssue[],
  issue: CompatIssue,
): void {
  if (issue.severity === 'blocker') blockers.push(issue);
  else if (issue.severity === 'warning') warnings.push(issue);
  else infos.push(issue);
}

function key(oldPath: string, newPath: string): string {
  return `${oldPath}=>${newPath}`;
}
