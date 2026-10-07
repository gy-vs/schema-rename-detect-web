import {SchemaSummary} from '../api';
import {FileJson2, Plus} from 'lucide-react';
import {useState} from 'react';

interface Props {
  schemas: SchemaSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
}

export function SchemaList({schemas, selectedId, onSelect, onCreate}: Props) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(name.trim());
      setName('');
    } catch (e) {
      setError((e as {message?: string}).message ?? '创建失败');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="sidebar-block">
      <h2>Schemas</h2>
      <div className="list">
        {schemas.map(schema => (
          <button
            key={schema.id}
            className={schema.id === selectedId ? 'active' : ''}
            onClick={() => onSelect(schema.id)}
          >
            <span className="list-title">
              <FileJson2 size={14} /> {schema.name}
            </span>
            <small>
              {schema.versionCount} 个版本 · 最新 v{schema.latestVersion}
            </small>
          </button>
        ))}
        {schemas.length === 0 && <p className="muted">还没有 schema</p>}
      </div>
      <div className="create-row">
        <input
          value={name}
          placeholder="新 schema 名称"
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
        />
        <button onClick={submit} disabled={creating || !name.trim()} title="新建 schema">
          <Plus size={15} />
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
