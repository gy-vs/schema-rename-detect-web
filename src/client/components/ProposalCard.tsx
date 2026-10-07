import {Proposal} from '../../core/types';
import {ArrowRight, ChevronDown, ChevronUp, Scale} from 'lucide-react';
import {useState} from 'react';
import {DecisionState} from './review-types';

interface Props {
  proposal: Proposal;
  decision: DecisionState;
  onDecide: (decision: 'confirmed' | 'rejected' | undefined) => void;
}

export function ProposalCard({proposal, decision, onDecide}: Props) {
  const [open, setOpen] = useState(false);
  const topRunner = proposal.runnerUps.find(edge => edge.newPath !== proposal.newPath);

  return (
    <div className={`proposal proposal-${decision ?? 'pending'}`}>
      <div className="proposal-head" onClick={() => setOpen(value => !value)}>
        <button className="disclosure" aria-label="展开依据">
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        <div className="proposal-paths">
          <code className="path-old">{proposal.oldPath}</code>
          <ArrowRight size={14} />
          <code className="path-new">{proposal.newPath}</code>
        </div>
        <span className={`score score-${scoreBand(proposal.score)}`}>{proposal.score} 分</span>
      </div>

      <div className="proposal-actions">
        <button
          className={decision === 'confirmed' ? 'chosen confirm' : ''}
          onClick={() => onDecide(decision === 'confirmed' ? undefined : 'confirmed')}
        >
          ✓ 确认改名/挪位
        </button>
        <button
          className={decision === 'rejected' ? 'chosen reject' : ''}
          onClick={() => onDecide(decision === 'rejected' ? undefined : 'rejected')}
        >
          ✗ 拒绝（按删除+新增）
        </button>
        {decision === 'carried' && <span className="badge carried">沿用决定</span>}
        {decision === 'reset' && <span className="badge reset">沿用失效·待确认</span>}
        {decision === undefined && <span className="badge pending-badge">待确认</span>}
        {topRunner && topRunner.gap <= 12 && (
          <span className="badge close-call" title={`次选 ${topRunner.newName} 只差 ${topRunner.gap} 分`}>
            <Scale size={12} /> 次选 {topRunner.newName} 差 {topRunner.gap} 分
          </span>
        )}
      </div>

      {proposal.assignmentNote.kind === 'contested' && (
        <p className="assignment-note contested">
          <strong>为什么是它：</strong>
          {proposal.assignmentNote.text}
          <br />
          {proposal.assignmentNote.counterfactual}
        </p>
      )}
      {proposal.assignmentNote.kind === 'unique' && (
        <p className="assignment-note">{proposal.assignmentNote.text}</p>
      )}

      {open && (
        <div className="evidence">
          <table>
            <thead>
              <tr>
                <th>依据</th>
                <th className="num">权重</th>
                <th className="num">得分</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {proposal.features.map(feature => (
                <tr key={feature.key}>
                  <td>{feature.label}</td>
                  <td className="num">{feature.weight}</td>
                  <td className="num">
                    {feature.contribution}
                    <small> / {feature.weight}</small>
                  </td>
                  <td>{feature.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {proposal.runnerUps.filter(edge => edge.newPath !== proposal.newPath).length > 0 && (
            <div className="alt-block">
              <h4>旧字段的备选新字段（为什么落选）</h4>
              <ul>
                {proposal.runnerUps
                  .filter(edge => edge.newPath !== proposal.newPath)
                  .map(edge => (
                    <li key={edge.newPath}>
                      <code>{edge.newPath}</code> — {edge.score} 分
                      <span className={edge.gap <= 12 ? 'gap-close' : 'gap-wide'}>
                        （差 {edge.gap} 分{edge.gap <= 12 ? '，接近但全局一对一分配后落选' : ''}）
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {proposal.competitors.length > 0 && (
            <div className="alt-block">
              <h4>也想匹配到这个新字段的旧字段</h4>
              <ul>
                {proposal.competitors.map(edge => (
                  <li key={edge.oldPath}>
                    <code>{edge.oldPath}</code> — {edge.score} 分
                    <span className={edge.gap <= 12 ? 'gap-close' : 'gap-wide'}>
                      （差 {edge.gap} 分）
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function scoreBand(score: number): 'high' | 'mid' | 'low' {
  if (score >= 65) return 'high';
  if (score >= 45) return 'mid';
  return 'low';
}
