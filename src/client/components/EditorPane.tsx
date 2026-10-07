import {Save, AlertTriangle, CheckCircle2, History} from 'lucide-react';
import {SchemaDetail, VersionPayload} from '../api';

interface Props {
  schema: SchemaDetail;
  selectedVersion: number;
  draft: string;
  dirty: boolean;
  saving: boolean;
  parseError: string | null;
  notice: {kind: 'ok' | 'error' | 'info'; text: string} | null;
  onSelectVersion: (version: number) => void;
  onEdit: (content: string) => void;
  onSave: () => void;
}

export function EditorPane({
  schema,
  selectedVersion,
  draft,
  dirty,
  saving,
  parseError,
  notice,
  onSelectVersion,
  onEdit,
  onSave,
}: Props) {
  const viewed: VersionPayload | undefined = schema.versions.find(v => v.version === selectedVersion);

  return (
    <div className="editor-pane">
      <div className="pane-head">
        <div>
          <h2 title={schema.name}>{schema.name}</h2>
          <small>
            正在查看 v{selectedVersion}
            {dirty && <span className="dirty-dot">（有未保存改动）</span>}
          </small>
        </div>
        <button className="primary" onClick={onSave} disabled={saving || !dirty || Boolean(parseError)}>
          <Save size={15} /> {saving ? '保存中…' : '保存为新版本'}
        </button>
      </div>

      <div className="version-strip">
        <History size={14} />
        {schema.versions.map(version => (
          <button
            key={version.version}
            className={version.version === selectedVersion ? 'active' : ''}
            onClick={() => onSelectVersion(version.version)}
            title={`v${version.version}，基于 v${version.baseVersion} 保存于 ${version.createdAt}`}
          >
            v{version.version}
          </button>
        ))}
      </div>

      {notice && (
        <div className={`notice notice-${notice.kind}`}>
          {notice.kind === 'error' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span>{notice.text}</span>
        </div>
      )}
      {parseError && (
        <div className="notice notice-error">
          <AlertTriangle size={15} />
          <span>{parseError}</span>
        </div>
      )}

      <textarea
        aria-label="JSON Schema 文本"
        spellCheck={false}
        value={draft}
        onChange={event => onEdit(event.target.value)}
      />
      {viewed && (
        <small className="muted meta-line">
          v{viewed.version} 保存于 {viewed.createdAt}
          {viewed.baseVersion > 0 ? `，基于 v${viewed.baseVersion}` : '（首个版本）'}
        </small>
      )}
    </div>
  );
}
