import {useCallback, useEffect, useState} from 'react';
import {FlaskConical, PencilLine, GitBranch} from 'lucide-react';
import {SchemaEditor} from './SchemaEditor';
import {ReviewWorkbench} from './ReviewWorkbench';
import {api, type FamilySummary} from './api';

type Tab = 'edit' | 'review';

export default function App() {
  const [tab, setTab] = useState<Tab>('edit');
  const [families, setFamilies] = useState<FamilySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [author, setAuthor] = useState(() => localStorage.getItem('ses.author') ?? '');
  const [refreshTick, setRefreshTick] = useState(0);

  const reload = useCallback(() => {
    api.listFamilies().then((list) => {
      setFamilies(list);
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    localStorage.setItem('ses.author', author);
  }, [author]);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Schema Evolution Studio</strong>
        <small>发版前审阅 JSON Schema 变更 · 改名识别 · 兼容判定</small>
        <span className="spacer" />
        <input
          className="author-input"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="审阅署名（可空）"
        />
        <nav className="tabs">
          <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>
            <PencilLine size={14} /> Schema 编辑
          </button>
          <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>
            <GitBranch size={14} /> 变更审阅
          </button>
        </nav>
      </header>
      {tab === 'edit' ? (
        <SchemaEditor
          families={families}
          selectedId={selectedId}
          onSelect={setSelectedId}
          author={author}
          onChanged={() => {
            reload();
            setRefreshTick((t) => t + 1);
          }}
        />
      ) : (
        <ReviewWorkbench
          families={families}
          selectedId={selectedId}
          author={author}
          refreshTick={refreshTick}
        />
      )}
    </main>
  );
}
