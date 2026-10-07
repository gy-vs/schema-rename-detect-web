/**
 * JSON 文件持久化。单进程 Express，同步读写 + 临时文件原子 rename 即可；
 * 数据文件不存在时用空数据初始化。
 */
import {randomBytes} from 'node:crypto';
import {existsSync, readFileSync, renameSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {ReviewDecision} from '../core/types';

export interface SchemaVersionDoc {
  version: number;
  content: string;
  createdAt: string;
  /** 保存时手里的基底版本，用于审计谁基于谁改的 */
  baseVersion: number;
}

export interface SchemaDoc {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  versions: SchemaVersionDoc[];
}

export interface ReviewDoc {
  /** 审阅状态行版本号，每次保存 +1，乐观锁 */
  rev: number;
  decisions: ReviewDecision[];
  updatedAt: string;
  updatedBy?: string;
}

export interface DBShape {
  schemas: Record<string, SchemaDoc>;
  /** key: `${schemaId}:${fromVersion}:${toVersion}` */
  reviews: Record<string, ReviewDoc>;
}

function emptyDB(): DBShape {
  return {schemas: {}, reviews: {}};
}

export class Store {
  private data: DBShape;

  constructor(private readonly file: string) {
    if (!existsSync(file)) {
      this.data = emptyDB();
      mkdirSync(dirname(file), {recursive: true});
      this.persist();
    } else {
      this.data = JSON.parse(readFileSync(file, 'utf8')) as DBShape;
      this.data.schemas ??= {};
      this.data.reviews ??= {};
    }
  }

  listSchemas(): SchemaDoc[] {
    return Object.values(this.data.schemas).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getSchema(id: string): SchemaDoc | undefined {
    return this.data.schemas[id];
  }

  createSchema(name: string, firstContent: string, now: () => Date = () => new Date()): SchemaDoc {
    const id = uniqueId(this.data.schemas);
    const doc: SchemaDoc = {
      id,
      name,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      versions: [{version: 1, content: firstContent, createdAt: now().toISOString(), baseVersion: 0}],
    };
    this.data.schemas[id] = doc;
    this.persist();
    return doc;
  }

  addVersion(
    id: string,
    content: string,
    expectedLatest: number,
    now: () => Date = () => new Date(),
  ): {ok: true; doc: SchemaDoc} | {ok: false; latest: number} {
    const doc = this.data.schemas[id];
    if (!doc) throw new NotFoundError('schema not found');
    const latest = doc.versions[doc.versions.length - 1].version;
    if (expectedLatest !== latest) return {ok: false, latest};
    doc.versions.push({
      version: latest + 1,
      content,
      createdAt: now().toISOString(),
      baseVersion: expectedLatest,
    });
    doc.updatedAt = now().toISOString();
    this.persist();
    return {ok: true, doc};
  }

  getReview(schemaId: string, fromVersion: number, toVersion: number): ReviewDoc {
    const key = reviewKey(schemaId, fromVersion, toVersion);
    return (
      this.data.reviews[key] ?? {
        rev: 0,
        decisions: [],
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  saveReview(
    schemaId: string,
    fromVersion: number,
    toVersion: number,
    decisions: ReviewDecision[],
    expectedRev: number,
    editor: string | undefined,
    now: () => Date = () => new Date(),
  ): {ok: true; doc: ReviewDoc} | {ok: false; current: ReviewDoc} {
    const key = reviewKey(schemaId, fromVersion, toVersion);
    const existing = this.data.reviews[key];
    const currentRev = existing?.rev ?? 0;
    if (expectedRev !== currentRev) {
      return {ok: false, current: existing ?? emptyReview()};
    }
    const doc: ReviewDoc = {
      rev: currentRev + 1,
      decisions,
      updatedAt: now().toISOString(),
      updatedBy: editor,
    };
    this.data.reviews[key] = doc;
    this.persist();
    return {ok: true, doc};
  }

  /** 供分析层遍历用：某 schema 的全部已存审阅 */
  allReviews(schemaId: string): Array<{fromVersion: number; toVersion: number; doc: ReviewDoc}> {
    const out: Array<{fromVersion: number; toVersion: number; doc: ReviewDoc}> = [];
    for (const [key, doc] of Object.entries(this.data.reviews)) {
      const parts = key.split(':');
      if (parts[0] !== schemaId || parts.length !== 3) continue;
      out.push({fromVersion: Number(parts[1]), toVersion: Number(parts[2]), doc});
    }
    return out.sort((a, b) => a.fromVersion - b.fromVersion || a.toVersion - b.toVersion);
  }

  private persist(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}

export class NotFoundError extends Error {}

function emptyReview(): ReviewDoc {
  return {rev: 0, decisions: [], updatedAt: new Date(0).toISOString()};
}

export function reviewKey(schemaId: string, fromVersion: number, toVersion: number): string {
  return `${schemaId}:${fromVersion}:${toVersion}`;
}

function uniqueId(existing: Record<string, unknown>): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = randomBytes(6).toString('hex');
    if (!existing[id]) return id;
  }
  throw new Error('id generation failed');
}

export function defaultDBPath(): string {
  return join(process.cwd(), 'data', 'studio-db.json');
}
