import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export interface Version {
  revision: number;
  content: string; // 原始 JSON Schema 文本
  createdAt: string;
  createdBy: string | null;
  note: string | null;
}

export interface Family {
  id: string;
  name: string;
  createdAt: string;
  versions: Version[];
}

/** 每一对版本（fromRevision -> toRevision，可跨多版）的审阅记录。 */
export interface ReviewDoc {
  familyId: string;
  fromRevision: number;
  toRevision: number;
  revision: number; // 审阅状态自身的乐观锁版本
  decisions: Record<string, 'confirmed' | 'rejected'>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface StoreData {
  families: Family[];
  reviews: ReviewDoc[];
}

function emptyData(): StoreData {
  return {families: [], reviews: []};
}

/**
 * 极简 JSON 文件存储：读时解析、写时先落临时文件再 rename（原子）。
 * 单进程服务足够；数据文件路径可用环境变量覆盖，测试用临时文件隔离。
 */
export class JsonStore {
  private data: StoreData;

  constructor(private readonly file: string) {
    this.data = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as StoreData)
      : emptyData();
  }

  snapshot(): StoreData {
    return structuredClone(this.data);
  }

  mutate(fn: (data: StoreData) => void): StoreData {
    fn(this.data);
    this.persist();
    return this.snapshot();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), {recursive: true});
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
