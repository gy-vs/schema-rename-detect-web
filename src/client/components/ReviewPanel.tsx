import {AnalysisResponse} from '../api';
import {EffectiveDecision, ReviewDecision} from '../../core/types';
import {ProposalCard} from './ProposalCard';
import {DecisionState} from './review-types';
import {GitCompare, ShieldAlert, ShieldCheck, ShieldQuestion, Save} from 'lucide-react';

interface Props {
  analysis: AnalysisResponse | null;
  loading: boolean;
  loadError: string | null;
  fromVersion: number;
  toVersion: number;
  maxVersion: number;
  decisionOverrides: Map<string, ReviewDecision['decision']>;
  editorName: string;
  saving: boolean;
  onSelectPair: (from: number, to: number) => void;
  onOverride: (oldPath: string, newPath: string, decision: ReviewDecision['decision'] | undefined) => void;
  onEditorName: (name: string) => void;
  onSave: () => void;
}

export function ReviewPanel(props: Props) {
  const {
    analysis,
    loading,
    loadError,
    fromVersion,
    toVersion,
    maxVersion,
    decisionOverrides,
    onSelectPair,
  } = props;

  const options = Array.from({length: maxVersion}, (_, i) => i + 1);

  return (
    <div className="review-pane">
      <div className="pane-head">
        <h2>
          <GitCompare size={16} /> 审阅工作台
        </h2>
      </div>

      <div className="pair-selector">
        <label>
          旧版
          <select value={fromVersion} onChange={e => onSelectPair(Number(e.target.value), toVersion)}>
            {options.map(v => (
              <option key={v} value={v} disabled={v >= toVersion}>
                v{v}
              </option>
            ))}
          </select>
        </label>
        <span className="arrow">→</span>
        <label>
          新版
          <select value={toVersion} onChange={e => onSelectPair(fromVersion, Number(e.target.value))}>
            {options.map(v => (
              <option key={v} value={v} disabled={v <= fromVersion}>
                v{v}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <p className="muted">分析中…</p>}
      {loadError && <p className="error-text">{loadError}</p>}
      {!analysis && !loading && !loadError && <p className="muted">选择两个版本查看候选改名/挪位。</p>}

      {analysis && (
        <>
          <VerdictBanner analysis={analysis} />
          <IssueLists analysis={analysis} />

          <h3 className="section-title">
            候选改名 / 挪位（{analysis.proposals.length}）
            <small>一个新字段最多归一个旧字段，全局一对一分配</small>
          </h3>
          <div className="proposal-list">
            {analysis.proposals.map(proposal => {
              const key = `${proposal.oldPath}=>${proposal.newPath}`;
              const override = decisionOverrides.get(key);
              return (
                <ProposalCard
                  key={key}
                  proposal={proposal}
                  decision={override ?? deriveState(analysis.effectiveDecisions, proposal.oldPath, proposal.newPath)}
                  onDecide={decision => props.onOverride(proposal.oldPath, proposal.newPath, decision)}
                />
              );
            })}
            {analysis.proposals.length === 0 && <p className="muted">没有达到阈值的候选。</p>}
          </div>

          <Unmatched analysis={analysis} />

          <div className="review-save-bar">
            <input
              className="editor-name"
              value={props.editorName}
              placeholder="你的名字（冲突时告诉对方是谁改的）"
              onChange={e => props.onEditorName(e.target.value)}
            />
            <button className="primary" onClick={props.onSave} disabled={props.saving}>
              <Save size={15} /> {props.saving ? '提交中…' : '保存审阅结果'}
            </button>
            <small className="muted">当前审阅状态 rev {analysis.review.rev}</small>
          </div>
        </>
      )}
    </div>
  );
}

function deriveState(effective: EffectiveDecision[], oldPath: string, newPath: string): DecisionState {
  const hit = effective.find(d => d.oldPath === oldPath && d.newPath === newPath);
  if (!hit) return undefined;
  if (hit.source === 'stored') return hit.decision;
  return hit.status === 'reset' ? 'reset' : 'carried';
}

function VerdictBanner({analysis}: {analysis: AnalysisResponse}) {
  const {verdict} = analysis.compatibility;
  const config = {
    compatible: {icon: ShieldCheck, text: '可以安全替换：所有字段演进都有兼容解释。', cls: 'verdict-ok'},
    incompatible: {icon: ShieldAlert, text: '不能安全替换：存在不兼容变化（见下）。', cls: 'verdict-bad'},
    undetermined: {
      icon: ShieldQuestion,
      text: '暂不能下结论：还有候选改名没审阅，确认或拒绝后结论会自动更新。',
      cls: 'verdict-pending',
    },
  }[verdict];
  const Icon = config.icon;
  return (
    <div className={`verdict ${config.cls}`}>
      <Icon size={18} />
      <div>
        <strong>v{analysis.fromVersion} → v{analysis.toVersion}：{verdict === 'compatible' ? '兼容' : verdict === 'incompatible' ? '不兼容' : '待定'}</strong>
        <p>{config.text}</p>
        <small className="timing">候选与结论计算耗时 {analysis.stats.elapsedMs} ms</small>
      </div>
    </div>
  );
}

function IssueLists({analysis}: {analysis: AnalysisResponse}) {
  const {compatibility} = analysis;
  return (
    <div className="issue-lists">
      {compatibility.blockers.map((issue, i) => (
        <div key={`b${i}`} className="issue blocker">
          <ShieldAlert size={14} /> {issue.message}
        </div>
      ))}
      {compatibility.pending.map((issue, i) => (
        <div key={`p${i}`} className="issue pending">
          <ShieldQuestion size={14} /> {issue.message}
        </div>
      ))}
      {compatibility.warnings.map((issue, i) => (
        <div key={`w${i}`} className="issue warning">
          {issue.message}
        </div>
      ))}
    </div>
  );
}

function Unmatched({analysis}: {analysis: AnalysisResponse}) {
  return (
    <div className="unmatched-grid">
      <div>
        <h3 className="section-title">
          删除（{analysis.unmatchedOld.length}）
          <small>新版没有同名字段，也没有候选承接</small>
        </h3>
        <ul className="path-list">
          {analysis.unmatchedOld.map(field => (
            <li key={field.path}>
              <code>{field.path}</code>
              {field.required && <span className="req">必填</span>}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="section-title">
          新增（{analysis.unmatchedNew.length}）
          <small>没有候选旧字段对应</small>
        </h3>
        <ul className="path-list">
          {analysis.unmatchedNew.map(field => (
            <li key={field.path}>
              <code>{field.path}</code>
              {field.required && <span className="req">必填</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
