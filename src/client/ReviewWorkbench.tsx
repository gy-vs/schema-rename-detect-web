import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Check,
  X,
  ShieldCheck,
  ShieldAlert,
  HelpCircle,
  ArrowRight,
  GitBranch,
  RefreshCw,
  CornerDownRight,
} from 'lucide-react';
import {api, type FamilyDetail, type FamilySummary} from './api';
import type {Candidate, EvolutionResult, Finding} from '../engine/types.js';

type LocalDecision = 'confirmed' | 'rejected' | undefined;

const verdictMeta = {
  compatible: {label: '可以安全替换', cls: 'ok', Icon: ShieldCheck},
  incompatible: {label: '不能安全替换', cls: 'bad', Icon: ShieldAlert},
  undetermined: {label: '结论待定（还有候选没审）', cls: 'warn', Icon: HelpCircle},
} as const;

export function ReviewWorkbench({
  families,
  selectedId,
  author,
  refreshTick,
}: {
  families: FamilySummary[];
  selectedId: string | null;
  author: string;
  refreshTick: number;
}) {
  const [family, setFamily] = useState<FamilyDetail | null>(null);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(2);
  const [data, setData] = useState<EvolutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, LocalDecision>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'confirmed' | 'rejected'>('all');
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setFamily(null);
      return;
    }
    api.getFamily(selectedId).then((f) => {
      setFamily(f);
      const latest = f.versions.at(-1)?.revision ?? 1;
      setFrom(Math.max(1, latest - 1));
      setTo(latest);
    });
  }, [selectedId, refreshTick]);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setError(null);
    try {
      const result = await api.evolution(selectedId, from, to);
      setData(result);
      const stored: Record<string, LocalDecision> = {};
      for (const c of result.candidates) {
        // 继承来的结论在界面上可覆盖；直接结论作为本地基线
        if (!c.inherited) stored[c.id] = c.status === 'pending' ? undefined : c.status;
      }
      setLocal(stored);
    } catch (err) {
      setError((err as Error).message);
      setData(null);
    }
  }, [selectedId, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  // 轻轮询：别人改了同一对版本时提示
  useEffect(() => {
    if (!selectedId || !data) return;
    pollRef.current = window.setInterval(async () => {
      try {
        const fresh = await api.evolution(selectedId, from, to);
        if (fresh.review.revision !== data.review.revision) {
          setData(fresh);
          setBanner({
            kind: 'error',
            text: `审阅状态刚被别人更新（${fresh.review.updatedBy ?? '他人'} @ ${fresh.review.updatedAt ?? ''}），已为你加载最新结论，请在此基础上继续。`,
          });
        }
      } catch {
        /* 轮询失败忽略 */
      }
    }, 5000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [selectedId, from, to, data]);

  const effectiveDecision = useCallback(
    (c: Candidate): LocalDecision => {
      if (c.id in local) return local[c.id];
      return c.status === 'pending' ? undefined : c.status;
    },
    [local],
  );

  const candidatesView = useMemo(() => {
    if (!data) return [];
    const withStatus = data.candidates.map((c) => ({c, dec: effectiveDecision(c)}));
    if (filter === 'all') return withStatus;
    return withStatus.filter(({c, dec}) => {
      const status = dec ?? 'pending';
      return filter === status;
    });
  }, [data, filter, effectiveDecision]);

  function decide(c: Candidate, value: LocalDecision) {
    setLocal((prev) => ({...prev, [c.id]: value}));
    setBanner(null);
  }

  // 本地修改即时重算结论（走服务端 analysis：把未保存的决定作为参数预览不现实，
  // 所以这里只做简单统计提示；正式结论以保存后刷新为准）
  const pendingCount = useMemo(
    () => (data ? data.candidates.filter((c) => !effectiveDecision(c)).length : 0),
    [data, effectiveDecision],
  );

  async function submit() {
    if (!data || !selectedId) return;
    setSaving(true);
    setBanner(null);
    const decisions: Record<string, 'confirmed' | 'rejected'> = {};
    for (const c of data.candidates) {
      const d = effectiveDecision(c);
      if (d) decisions[c.id] = d;
    }
    try {
      await api.putReview(selectedId, from, to, {
        decisions,
        baseRevision: data.review.revision,
        author: author || undefined,
      });
      await load();
      setBanner({kind: 'ok', text: '审阅结果已保存，结论已按新决定重算。'});
    } catch (err) {
      const e = err as Error & {status?: number; body?: {currentRevision?: number}};
      if (e.status === 409) {
        setBanner({
          kind: 'error',
          text: `${e.message} 你手里的审阅状态已过期，页面会刷新到他人版本（当前 revision ${e.body?.currentRevision}），请重做未提交的决定。`,
        });
        await load();
      } else {
        setBanner({kind: 'error', text: e.message});
      }
    } finally {
      setSaving(false);
    }
  }

  if (!selectedId || !family) return <p className="muted pad">先在“Schema 编辑”里选一份 schema。</p>;
  const revisions = family.versions.map((v) => v.revision);
  const meta = data ? verdictMeta[data.report.verdict] : null;

  return (
    <div className="review-layout">
      <div className="review-controls pane">
        <div className="pane-head">
          <h2>
            <GitBranch size={16} /> 版本对比
          </h2>
          <button className="ghost" onClick={() => void load()} title="重新拉取">
            <RefreshCw size={14} /> 刷新
          </button>
        </div>
        <div className="range-row">
          <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {revisions.map((r) => (
              <option key={r} value={r}>
                第 {r} 版（旧）
              </option>
            ))}
          </select>
          <ArrowRight size={15} />
          <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
            {revisions
              .filter((r) => r > from)
              .map((r) => (
                <option key={r} value={r}>
                  第 {r} 版（新）
                </option>
              ))}
          </select>
        </div>
        {error && <div className="banner error">{error}</div>}
        {banner && (
          <div className={`banner ${banner.kind}`}>
            {banner.kind === 'ok' ? <Check size={14} /> : <HelpCircle size={14} />}
            {banner.text}
          </div>
        )}

        {data && meta && (
          <>
            <div className={`verdict ${meta.cls}`}>
              <meta.Icon size={26} />
              <div>
                <strong>{meta.label}</strong>
                <small>
                  第 {data.fromRevision} 版 → 第 {data.toRevision} 版 · 引擎耗时{' '}
                  {data.report.timingMs} ms
                </small>
              </div>
            </div>
            <div className="stats">
              <span>同路径 {data.report.stats.shared}</span>
              <span>候选 {data.report.stats.candidatesTotal}</span>
              <span className="ok-text">已确认 {data.report.stats.candidatesConfirmed}</span>
              <span className="bad-text">已拒绝 {data.report.stats.candidatesRejected}</span>
              <span className="warn-text">待审 {data.report.stats.candidatesPending}</span>
            </div>
            <div className="review-meta muted">
              审阅状态 revision {data.review.revision}
              {data.review.updatedBy ? ` · ${data.review.updatedBy}` : ''}
              {data.review.updatedAt ? ` · ${data.review.updatedAt}` : ''}
            </div>

            <div className="filter-row">
              {(['all', 'pending', 'confirmed', 'rejected'] as const).map((f) => (
                <button
                  key={f}
                  className={filter === f ? 'chip active' : 'chip'}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? '全部' : f === 'pending' ? '待确认' : f === 'confirmed' ? '已确认' : '已拒绝'}
                </button>
              ))}
              <span className="spacer" />
              <button className="primary" onClick={submit} disabled={saving}>
                提交审阅{pendingCount > 0 ? `（还有 ${pendingCount} 条未决）` : ''}
              </button>
            </div>
          </>
        )}
      </div>

      {data && (
        <div className="review-body">
          <section className="pane candidates-pane">
            <h3>改名 / 挪位置候选（一对一指派）</h3>
            {candidatesView.length === 0 && <p className="muted">没有符合筛选的候选。</p>}
            {candidatesView.map(({c, dec}) => (
              <CandidateRow
                key={c.id}
                c={c}
                decision={dec}
                expanded={expanded === c.id}
                onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
                onDecide={(v) => decide(c, v)}
              />
            ))}

            <h3>同路径字段变化</h3>
            {data.samePathChanges.length === 0 && <p className="muted">同路径字段无变化。</p>}
            <table className="change-table">
              <tbody>
                {data.samePathChanges.map((ch, i) => (
                  <tr key={i}>
                    <td>
                      <span className={`sev ${ch.severity}`}>{ch.severity}</span>
                    </td>
                    <td className="mono">{ch.path}</td>
                    <td>{ch.kind}</td>
                    <td>{ch.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>直接新增 / 删除</h3>
            {data.unpaired.length === 0 && <p className="muted">没有无法配对的字段。</p>}
            <ul className="unpaired-list">
              {data.unpaired.map((u) => (
                <li key={u.role + u.path}>
                  <span className={`tag ${u.role === 'removed' ? 'bad' : 'new'}`}>
                    {u.role === 'removed' ? '删除' : '新增'}
                  </span>
                  <span className="mono">{u.path}</span>
                  <small className="muted">
                    {u.kinds.join('|') || 'untyped'}
                    {u.required ? ' · required' : ''}
                  </small>
                </li>
              ))}
            </ul>
          </section>

          <aside className="pane findings-pane">
            <h3>判定依据（随审阅状态实时变化）</h3>
            <FindingsList findings={data.report.findings} renamedAway={data.report.renamedAway} />
          </aside>
        </div>
      )}
    </div>
  );
}

function CandidateRow({
  c,
  decision,
  expanded,
  onToggle,
  onDecide,
}: {
  c: Candidate;
  decision: LocalDecision;
  expanded: boolean;
  onToggle: () => void;
  onDecide: (v: LocalDecision) => void;
}) {
  return (
    <div className={`candidate ${decision ?? 'pending'}`}>
      <div className="candidate-head" onClick={onToggle}>
        <div className="paths">
          <span className="mono old">{c.oldPath}</span>
          <ArrowRight size={13} />
          <span className="mono new">{c.newPath}</span>
          {c.moved && (
            <span className="tag moved">
              <CornerDownRight size={11} /> 挪了位置
            </span>
          )}
          {c.inherited && <span className="tag inherit">沿用 {c.inheritedFrom}</span>}
        </div>
        <div className="score">
          <div className="score-num">{c.score.toFixed(3)}</div>
          <div className="score-bar">
            <div style={{width: `${Math.round(c.score * 100)}%`}} />
          </div>
        </div>
        <div className="decide-buttons" onClick={(e) => e.stopPropagation()}>
          <button
            className={decision === 'confirmed' ? 'confirm active' : 'confirm'}
            title="确认：旧数据按新名字读出，不算删除"
            onClick={() => onDecide(decision === 'confirmed' ? undefined : 'confirmed')}
          >
            <Check size={14} /> 确认
          </button>
          <button
            className={decision === 'rejected' ? 'reject active' : 'reject'}
            title="拒绝：按删除一个 + 新增一个处理"
            onClick={() => onDecide(decision === 'rejected' ? undefined : 'rejected')}
          >
            <X size={14} /> 拒绝
          </button>
        </div>
      </div>
      {c.note && <div className="candidate-note">{c.note}</div>}
      {expanded && (
        <div className="evidence">
          <table>
            <thead>
              <tr>
                <th>维度</th>
                <th>原始分</th>
                <th>权重</th>
                <th>贡献</th>
                <th>依据</th>
              </tr>
            </thead>
            <tbody>
              {c.features.map((f) => (
                <tr key={f.key}>
                  <td>{f.label}</td>
                  <td>{f.raw === null ? <span className="muted">弃权</span> : f.raw.toFixed(2)}</td>
                  <td>{f.weight}</td>
                  <td>{f.contribution.toFixed(3)}</td>
                  <td className="detail">{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.runnerUps.length > 0 && (
            <div className="runnerups">
              <strong>为什么不是这些备选：</strong>
              <ul>
                {c.runnerUps.map((r) => (
                  <li key={r.newPath}>
                    <span className="mono">{r.oldPath}</span> → <span className="mono">{r.newPath}</span>{' '}
                    <em>{r.score.toFixed(3)}</em> — {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="muted small">候选 id：{c.id}</div>
        </div>
      )}
    </div>
  );
}

function FindingsList({findings, renamedAway}: {findings: Finding[]; renamedAway: string[]}) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const infos = findings.filter((f) => f.severity === 'info');
  return (
    <div>
      {renamedAway.length > 0 && (
        <div className="renamed-box">
          <strong>确认改名消除的“删除”：</strong>
          <ul>
            {renamedAway.map((p) => (
              <li key={p} className="mono">
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
      {errors.map((f, i) => (
        <div key={'e' + i} className="finding bad">
          <ShieldAlert size={14} /> <span className="mono">{f.path}</span>
          <p>{f.message}</p>
        </div>
      ))}
      {warnings.map((f, i) => (
        <div key={'w' + i} className="finding warn">
          <HelpCircle size={14} /> <span className="mono">{f.path}</span>
          <p>{f.message}</p>
        </div>
      ))}
      {infos.map((f, i) => (
        <div key={'i' + i} className="finding info">
          <span className="mono">{f.path}</span>
          <p>{f.message}</p>
        </div>
      ))}
      {findings.length === 0 && <p className="muted">没有发现问题。</p>}
    </div>
  );
}
