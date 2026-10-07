import {useEffect, useMemo, useState} from 'react';
import {Save, FilePlus2, AlertTriangle, CheckCircle2} from 'lucide-react';
import {api, type FamilyDetail, type FamilySummary} from './api';

interface Props {
  families: FamilySummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  author: string;
}

export function SchemaEditor({families, selectedId, onSelect, onChanged, author}: Props) {
  const [family, setFamily] = useState<FamilyDetail | null>(null);
  const [revision, setRevision] = useState(1);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newId, setNewId] = useState('');

  useEffect(() => {
    if (!selectedId) {
      setFamily(null);
      return;
    }
    api.getFamily(selectedId).then((f) => {
      setFamily(f);
      const latest = f.versions.at(-1)?.revision ?? 0;
      setRevision(latest);
    });
  }, [selectedId, onChanged]);

  const version = useMemo(
    () => family?.versions.find((v) => v.revision === revision),
    [family, revision],
  );

  useEffect(() => {
    setDraft(version?.content ?? '');
    setMessage(null);
  }, [version?.revision, family?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = draft !== (version?.content ?? '');
  const viewingLatest = revision === (family?.versions.at(-1)?.revision ?? 0);

  async function save() {
    if (!family) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api.saveVersion(family.id, {
        content: draft,
        expectedRevision: revision,
        author: author || undefined,
      });
      setMessage({kind: 'ok', text: `已保存为第 ${saved.revision} 版`});
      onChanged();
      api.getFamily(family.id).then((f) => {
        setFamily(f);
        setRevision(saved.revision);
      });
    } catch (err) {
      const e = err as Error & {status?: number; body?: {latestRevision?: number}};
      if (e.status === 409) {
        setMessage({
          kind: 'error',
          text: `${e.message}（请在左侧切到第 ${e.body?.latestRevision} 版取回最新内容，合并改动后再保存）`,
        });
      } else {
        setMessage({kind: 'error', text: e.message});
      }
    } finally {
      setBusy(false);
    }
  }

  async function createFamily() {
    setBusy(true);
    setMessage(null);
    try {
      const f = await api.createFamily({
        name: newName || newId || '未命名 schema',
        id: newId || undefined,
        content: draft || undefined,
        author: author || undefined,
      });
      setShowNew(false);
      setNewName('');
      setNewId('');
      onChanged();
      onSelect(f.id);
    } catch (err) {
      setMessage({kind: 'error', text: (err as Error).message});
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="editor-layout">
      <aside className="pane list-pane">
        <div className="pane-head">
          <h2>Schema 列表</h2>
          <button className="ghost" onClick={() => setShowNew((v) => !v)} title="新建">
            <FilePlus2 size={15} /> 新建
          </button>
        </div>
        {showNew && (
          <div className="new-box">
            <input
              placeholder="名称，如：订单 schema"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              placeholder="id（可空，自动生成）"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
            />
            <button className="primary small" onClick={createFamily} disabled={busy}>
              创建
            </button>
          </div>
        )}
        <div className="list">
          {families.map((f) => (
            <button
              key={f.id}
              className={f.id === selectedId ? 'active' : ''}
              onClick={() => onSelect(f.id)}
            >
              <strong>{f.name}</strong>
              <br />
              <small>
                {f.id} · {f.versionCount} 个版本
              </small>
            </button>
          ))}
          {families.length === 0 && <p className="muted">还没有 schema，点“新建”开始。</p>}
        </div>
      </aside>

      <section className="pane editor-pane">
        {!family ? (
          <p className="muted">从左边选一份 schema，或新建一份。</p>
        ) : (
          <>
            <div className="toolbar">
              <strong>{family.name}</strong>
              <select
                value={revision}
                onChange={(e) => setRevision(Number(e.target.value))}
                aria-label="版本"
              >
                {family.versions
                  .slice()
                  .reverse()
                  .map((v) => (
                    <option key={v.revision} value={v.revision}>
                      第 {v.revision} 版{v.note ? ` · ${v.note}` : ''}
                    </option>
                  ))}
              </select>
              {!viewingLatest && <span className="tag warn">这是旧版本，只读参考</span>}
              {dirty && viewingLatest && <span className="tag">有未保存改动</span>}
              <span className="spacer" />
              <button className="primary" onClick={save} disabled={busy || !dirty || !viewingLatest}>
                <Save size={15} /> 保存为新版本
              </button>
            </div>
            {message && (
              <div className={`banner ${message.kind}`}>
                {message.kind === 'ok' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                {message.text}
              </div>
            )}
            <textarea
              aria-label="JSON Schema 文本"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="editor-foot muted">
              {version ? `当前载入：第 ${version.revision} 版` : ''} · 保存即生成新版本，旧版本随时可取回
            </div>
          </>
        )}
      </section>
    </div>
  );
}
