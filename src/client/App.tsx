import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FlaskConical} from 'lucide-react';
import {
  AnalysisResponse,
  ApiError,
  SchemaDetail,
  SchemaSummary,
  VersionDetail,
  api,
} from './api';
import {SchemaList} from './components/SchemaList';
import {EditorPane} from './components/EditorPane';
import {ReviewPanel} from './components/ReviewPanel';
import {ReviewDecision} from '../core/types';
import {parseSchemaText} from '../core/flatten';

interface Notice {
  kind: 'ok' | 'error' | 'info';
  text: string;
}

const STARTER_SCHEMA = JSON.stringify(
  {
    title: 'NewSchema',
    type: 'object',
    required: ['id'],
    properties: {id: {type: 'string'}},
  },
  null,
  2,
);

export default function App() {
  const [schemas, setSchemas] = useState<SchemaSummary[]>([]);
  const [schema, setSchema] = useState<SchemaDetail | null>(null);
  const [versionDetail, setVersionDetail] = useState<VersionDetail | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);

  const [fromVersion, setFromVersion] = useState(1);
  const [toVersion, setToVersion] = useState(1);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Map<string, ReviewDecision['decision']>>(new Map());
  const [editorName, setEditorName] = useState('');
  const [savingReview, setSavingReview] = useState(false);
  const analysisReq = useRef(0);

  const refreshList = useCallback(async () => {
    setSchemas(await api.listSchemas());
  }, []);

  useEffect(() => {
    refreshList().catch(() => undefined);
  }, [refreshList]);

  const selectSchema = useCallback(
    async (id: string) => {
      const detail = await api.getSchema(id);
      setSchema(detail);
      const latest = detail.latestVersion;
      const from = Math.max(1, latest - 1);
      setFromVersion(from);
      setToVersion(latest);
      const version = await api.getVersion(id, latest);
      setVersionDetail(version);
      setDraft(version.content);
      setNotice(null);
      setOverrides(new Map());
    },
    [],
  );

  const loadAnalysis = useCallback(
    async (id: string, from: number, to: number) => {
      if (from >= to) {
        setAnalysis(null);
        setAnalysisError(null);
        return;
      }
      const reqId = ++analysisReq.current;
      setAnalysisLoading(true);
      setAnalysisError(null);
      try {
        const result = await api.getAnalysis(id, from, to);
        if (reqId === analysisReq.current) {
          setAnalysis(result);
          setOverrides(new Map());
        }
      } catch (error) {
        if (reqId === analysisReq.current) {
          setAnalysisError((error as ApiError).message ?? '分析加载失败');
          setAnalysis(null);
        }
      } finally {
        if (reqId === analysisReq.current) setAnalysisLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (schema) void loadAnalysis(schema.id, fromVersion, toVersion);
  }, [schema, fromVersion, toVersion, loadAnalysis]);

  const dirty = Boolean(versionDetail && draft !== versionDetail.content);
  const parseError = useMemo(() => {
    if (!draft) return null;
    try {
      parseSchemaText(draft);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, [draft]);

  async function createSchema(name: string) {
    const created = await api.createSchema(name, STARTER_SCHEMA);
    await refreshList();
    await selectSchema(created.id);
  }

  async function selectVersion(version: number) {
    if (!schema) return;
    const detail = await api.getVersion(schema.id, version);
    setVersionDetail(detail);
    setDraft(detail.content);
    setNotice(null);
  }

  async function saveNewVersion() {
    if (!schema || !versionDetail) return;
    setSaving(true);
    setNotice(null);
    const previousLatest = schema.latestVersion;
    try {
      const updated = await api.addVersion(schema.id, draft, previousLatest);
      const latestVersion = updated.latestVersion;
      const detail = await api.getVersion(schema.id, latestVersion);
      setSchema(updated);
      setVersionDetail(detail);
      setDraft(detail.content);
      await refreshList();
      setFromVersion(previousLatest);
      setToVersion(latestVersion);
      setNotice({kind: 'ok', text: `已保存为 v${latestVersion}。`});
    } catch (error) {
      const apiError = error as ApiError & {payload?: {latest?: {content: string; version: number}}};
      if (apiError.status === 409) {
        const latestVersion = apiError.payload?.latest?.version;
        setNotice({
          kind: 'error',
          text:
            apiError.message ??
            `版本冲突：最新已经是 v${latestVersion}。已为你加载最新内容，请把改动合并后再保存。`,
        });
        if (schema) {
          const refreshed = await api.getSchema(schema.id);
          setSchema(refreshed);
          if (latestVersion) {
            const detail = await api.getVersion(schema.id, latestVersion);
            setVersionDetail(detail);
            // 保留用户草稿在 textarea 之外展示会更复杂；这里明确切到最新版，草稿放进提示
            setDraft(detail.content);
          }
        }
      } else {
        setNotice({kind: 'error', text: apiError.message ?? '保存失败'});
      }
    } finally {
      setSaving(false);
    }
  }

  function setOverride(oldPath: string, newPath: string, decision: ReviewDecision['decision'] | undefined) {
    setOverrides(previous => {
      const next = new Map(previous);
      const key = `${oldPath}=>${newPath}`;
      if (decision === undefined) next.delete(key);
      else next.set(key, decision);
      return next;
    });
  }

  /** 保存时发送的完整决定集：服务端已有决定 + 当前覆盖（覆盖含“拒绝/确认”，重置项也可重新表态） */
  function buildDecisions(): ReviewDecision[] {
    if (!analysis) return [];
    const merged = new Map<string, ReviewDecision>();
    for (const decision of analysis.review.decisions) {
      merged.set(`${decision.oldPath}=>${decision.newPath}`, decision);
    }
    // 沿用生效的决定也作为本对版本的明确决定固化下来（审阅人点了保存即认可沿用）
    for (const effective of analysis.effectiveDecisions) {
      if (effective.status === 'active' && effective.source === 'carried') {
        merged.set(`${effective.oldPath}=>${effective.newPath}`, {
          oldPath: effective.oldPath,
          newPath: effective.newPath,
          decision: effective.decision,
        });
      }
    }
    for (const [key, decision] of overrides) {
      const [oldPath, newPath] = key.split('=>');
      merged.set(key, {oldPath, newPath, decision});
    }
    return [...merged.values()];
  }

  async function saveReview() {
    if (!schema || !analysis) return;
    setSavingReview(true);
    try {
      const saved = await api.saveReview(
        schema.id,
        fromVersion,
        toVersion,
        buildDecisions(),
        analysis.review.rev,
        editorName,
      );
      setAnalysis({
        ...analysis,
        review: {
          rev: saved.rev,
          decisions: saved.decisions,
          updatedAt: saved.updatedAt,
          updatedBy: saved.updatedBy,
        },
        proposals: saved.analysis.proposals,
        unmatchedOld: saved.analysis.unmatchedOld,
        unmatchedNew: saved.analysis.unmatchedNew,
        samePathChanges: saved.analysis.samePathChanges,
        effectiveDecisions: saved.analysis.effectiveDecisions,
        compatibility: saved.analysis.compatibility,
      });
      setOverrides(new Map());
      setNotice({kind: 'ok', text: '审阅结果已保存，兼容性结论已同步更新。'});
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.status === 409) {
        setAnalysisError(apiError.message ?? '审阅状态已被别人更新，请刷新。');
        if (schema) void loadAnalysis(schema.id, fromVersion, toVersion);
      } else {
        setAnalysisError(apiError.message ?? '审阅保存失败');
      }
    } finally {
      setSavingReview(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Schema Evolution Studio</strong>
        <small>发版前 schema 变更审阅 · 改名/挪位候选 · 兼容性结论</small>
      </header>
      <section className="workspace">
        <aside className="pane pane-left">
          <SchemaList schemas={schemas} selectedId={schema?.id ?? null} onSelect={id => void selectSchema(id)} onCreate={createSchema} />
        </aside>
        <section className="pane pane-center">
          {schema && versionDetail ? (
            <EditorPane
              schema={schema}
              selectedVersion={versionDetail.version}
              draft={draft}
              dirty={dirty}
              saving={saving}
              parseError={parseError}
              notice={notice}
              onSelectVersion={v => void selectVersion(v)}
              onEdit={setDraft}
              onSave={() => void saveNewVersion()}
            />
          ) : (
            <p className="muted">← 从左侧选择或新建一份 schema</p>
          )}
        </section>
        <aside className="pane pane-right">
          <ReviewPanel
            analysis={analysis}
            loading={analysisLoading}
            loadError={analysisError}
            fromVersion={fromVersion}
            toVersion={toVersion}
            maxVersion={schema?.latestVersion ?? 1}
            decisionOverrides={overrides}
            editorName={editorName}
            saving={savingReview}
            onSelectPair={(from, to) => {
              setFromVersion(from);
              setToVersion(to);
              setAnalysisError(null);
            }}
            onOverride={setOverride}
            onEditorName={setEditorName}
            onSave={() => void saveReview()}
          />
        </aside>
      </section>
    </main>
  );
}
