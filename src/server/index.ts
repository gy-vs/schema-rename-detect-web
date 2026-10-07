import express, {type Express, type Response} from 'express';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve as resolvePath, dirname} from 'node:path';
import {candidateId} from '../engine/evolution.js';
import {parseSchemaText} from '../engine/parse.js';
import type {EvolutionResult} from '../engine/types.js';
import {analyzeEvolution, type DecisionMap} from '../engine/evolution.js';
import type {JsonSchema} from '../engine/types.js';
import {JsonStore, type Family, type ReviewDoc, type Version} from './store.js';
import {seedIfEmpty} from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseRange(range: string): {from: number; to: number} | null {
  const [fromStr, toStr] = String(range).split('-');
  const from = Number(fromStr);
  const to = Number(toStr);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  return {from, to};
}

export function createApp(store = new JsonStore(process.env.SES_DATA_FILE ?? '.data/ses.json')): Express {
  const app = express();
  app.use(express.json({limit: '8mb'}));

  const json = <T,>(res: Response, status: number, body: T) => res.status(status).json(body);

  // ---------- families ----------

  app.get('/api/families', (_req, res) => {
    const data = store.snapshot();
    res.json(
      data.families
        .map((f) => ({
          id: f.id,
          name: f.name,
          createdAt: f.createdAt,
          latestRevision: f.versions.at(-1)?.revision ?? 0,
          versionCount: f.versions.length,
          updatedAt: f.versions.at(-1)?.createdAt ?? f.createdAt,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  app.post('/api/families', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const id =
      String(req.body?.id ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || `schema-${Date.now().toString(36)}`;
    let content = '';
    if (typeof req.body?.content === 'string' && req.body.content.trim()) {
      try {
        parseSchemaText(req.body.content);
        content = req.body.content;
      } catch (err) {
        return json(res, 400, {error: 'invalid_schema', message: (err as Error).message});
      }
    }
    const author = String(req.body?.author ?? '') || null;
    let result: Family | undefined;
    let conflict = false;
    store.mutate((data) => {
      if (data.families.some((f) => f.id === id)) {
        conflict = true;
        return;
      }
      const now = new Date().toISOString();
      const family: Family = {
        id,
        name: name || id,
        createdAt: now,
        versions: content
          ? [
              {
                revision: 1,
                content,
                createdAt: now,
                createdBy: author,
                note: req.body?.note ? String(req.body.note) : null,
              },
            ]
          : [],
      };
      data.families.push(family);
      result = family;
    });
    if (conflict) return json(res, 409, {error: 'family_exists', message: `id ${id} 已存在`});
    res.status(201).json(serializeFamily(result!));
  });

  app.get('/api/families/:id', (req, res) => {
    const family = store.snapshot().families.find((f) => f.id === req.params.id);
    if (!family) return json(res, 404, {error: 'not_found'});
    res.json(serializeFamily(family));
  });

  app.get('/api/families/:id/versions/:revision', (req, res) => {
    const family = store.snapshot().families.find((f) => f.id === req.params.id);
    if (!family) return json(res, 404, {error: 'not_found'});
    const rev = Number(req.params.revision);
    const version = family.versions.find((v) => v.revision === rev);
    if (!version) return json(res, 404, {error: 'not_found', message: `没有第 ${rev} 版`});
    res.json(version);
  });

  // 保存新版本：expectedRevision 必须是当前最新，否则 409 并返回最新版本号
  app.post('/api/families/:id/versions', (req, res) => {
    const family = store.snapshot().families.find((f) => f.id === req.params.id);
    if (!family) return json(res, 404, {error: 'not_found'});
    const content = String(req.body?.content ?? '');
    try {
      parseSchemaText(content);
    } catch (err) {
      return json(res, 400, {error: 'invalid_schema', message: (err as Error).message});
    }
    const expected = Number(req.body?.expectedRevision ?? 0);
    const latest = family.versions.at(-1)?.revision ?? 0;
    if (expected !== latest) {
      return json(res, 409, {
        error: 'stale_revision',
        message: `你手里是第 ${expected} 版，最新已经是第 ${latest} 版，请取回最新版本后再保存`,
        latestRevision: latest,
      });
    }
    const author = String(req.body?.author ?? '') || null;
    let saved: Version | undefined;
    store.mutate((data) => {
      const f = data.families.find((x) => x.id === req.params.id)!;
      saved = {
        revision: f.versions.length + 1,
        content,
        createdAt: new Date().toISOString(),
        createdBy: author,
        note: req.body?.note ? String(req.body.note) : null,
      };
      f.versions.push(saved);
    });
    res.status(201).json(saved);
  });

  // ---------- evolution / review ----------

  function buildEvolution(
    family: Family,
    fromRevision: number,
    toRevision: number,
    overrideDecisions?: DecisionMap,
  ): EvolutionResult | {error: string; message: string} {
    const from = family.versions.find((v) => v.revision === fromRevision);
    const to = family.versions.find((v) => v.revision === toRevision);
    if (!from || !to) {
      return {error: 'not_found', message: `需要两个已存在的版本（当前 1..${family.versions.length}）`};
    }
    if (fromRevision >= toRevision) {
      return {error: 'bad_range', message: 'from 必须早于 to'};
    }
    const versions = family.versions.map((v) => ({
      revision: v.revision,
      content: JSON.parse(v.content) as JsonSchema,
    }));
    const data = store.snapshot();
    const docs = data.reviews.filter((r) => r.familyId === family.id);
    // 只有相邻版本对的审阅记录参与“跨版本沿用”的 hop 链
    const allReviews = new Map<number, DecisionMap>();
    for (const doc of docs) {
      if (doc.fromRevision === doc.toRevision - 1) {
        allReviews.set(doc.toRevision, new Map(Object.entries(doc.decisions)));
      }
    }
    const directDoc = docs.find(
      (r) => r.fromRevision === fromRevision && r.toRevision === toRevision,
    );
    const directDecisions: DecisionMap =
      overrideDecisions ?? new Map(Object.entries(directDoc?.decisions ?? {}));
    const result = analyzeEvolution({
      familyId: family.id,
      fromRevision,
      toRevision,
      versions,
      directDecisions,
      allReviews,
    });
    return {
      familyId: family.id,
      fromRevision,
      toRevision,
      ...result,
      review: {
        revision: directDoc?.revision ?? 0,
        updatedAt: directDoc?.updatedAt ?? null,
        updatedBy: directDoc?.updatedBy ?? null,
      },
    };
  }

  app.get('/api/families/:id/evolutions/:range', (req, res) => {
    const family = store.snapshot().families.find((f) => f.id === req.params.id);
    if (!family) return json(res, 404, {error: 'not_found'});
    const parsed = parseRange(req.params.range);
    if (!parsed) {
      return json(res, 400, {error: 'bad_range', message: '范围格式应为 7-8'});
    }
    const result = buildEvolution(family, parsed.from, parsed.to);
    if ('error' in result) {
      const status = result.error === 'bad_range' ? 400 : 404;
      return json(res, status, result);
    }
    res.json(result);
  });

  app.get('/api/families/:id/reviews/:range', (req, res) => {
    const parsed = parseRange(req.params.range);
    if (!parsed) {
      return json(res, 400, {error: 'bad_range', message: '范围格式应为 7-8'});
    }
    const {from: fromRevision, to: toRevision} = parsed;
    const doc = store
      .snapshot()
      .reviews.find(
        (r) =>
          r.familyId === req.params.id &&
          r.fromRevision === fromRevision &&
          r.toRevision === toRevision,
      );
    if (!doc) {
      return res.json({
        familyId: req.params.id,
        fromRevision,
        toRevision,
        revision: 0,
        decisions: {},
        updatedAt: null,
        updatedBy: null,
      });
    }
    res.json(doc);
  });

  // 提交审阅：整批替换，baseRevision 必须等于服务端该区间审阅记录版本，否则 409
  app.put('/api/families/:id/reviews/:range', (req, res) => {
    const family = store.snapshot().families.find((f) => f.id === req.params.id);
    if (!family) return json(res, 404, {error: 'not_found'});
    const parsed = parseRange(req.params.range);
    if (!parsed) {
      return json(res, 400, {error: 'bad_range', message: '范围格式应为 7-8'});
    }
    const {from: fromRevision, to: toRevision} = parsed;
    if (
      !family.versions.some((v) => v.revision === fromRevision) ||
      !family.versions.some((v) => v.revision === toRevision)
    ) {
      return json(res, 404, {error: 'not_found', message: `需要两个已存在的版本（${fromRevision}-${toRevision}）`});
    }
    if (fromRevision >= toRevision) {
      return json(res, 400, {error: 'bad_range', message: 'from 必须早于 to'});
    }
    const baseRevision = Number(req.body?.baseRevision ?? 0);
    const rawDecisions = req.body?.decisions;
    if (
      typeof rawDecisions !== 'object' ||
      rawDecisions === null ||
      Array.isArray(rawDecisions)
    ) {
      return json(res, 400, {error: 'bad_request', message: 'decisions 必须是 candidateId -> confirmed/rejected 的对象'});
    }
    const decisions: Record<string, 'confirmed' | 'rejected'> = {};
    for (const [id, value] of Object.entries(rawDecisions)) {
      if (value !== 'confirmed' && value !== 'rejected') {
        return json(res, 400, {error: 'bad_request', message: `${id} 的结论只能是 confirmed 或 rejected`});
      }
      decisions[id] = value;
    }

    let updated: ReviewDoc | undefined;
    let current: ReviewDoc | undefined;
    let stale = false;
    store.mutate((data) => {
      let doc = data.reviews.find(
        (r) =>
          r.familyId === family.id &&
          r.fromRevision === fromRevision &&
          r.toRevision === toRevision,
      );
      current = doc;
      const currentRev = doc?.revision ?? 0;
      if (baseRevision !== currentRev) {
        stale = true;
        return;
      }
      if (!doc) {
        doc = {
          familyId: family.id,
          fromRevision,
          toRevision,
          revision: 0,
          decisions: {},
          updatedAt: null,
          updatedBy: null,
        };
        data.reviews.push(doc);
      }
      doc.decisions = decisions;
      doc.revision += 1;
      doc.updatedAt = new Date().toISOString();
      doc.updatedBy = String(req.body?.author ?? '') || null;
      updated = doc;
    });
    if (stale) {
      return json(res, 409, {
        error: 'review_conflict',
        message: `审阅状态已被别人更新（当前版本 ${current?.revision ?? 1}，你手里是 ${baseRevision}），请刷新后在此基础上再提交`,
        currentRevision: current?.revision ?? 1,
        currentUpdatedAt: current?.updatedAt ?? null,
        currentUpdatedBy: current?.updatedBy ?? null,
      });
    }
    res.json(updated);
  });

  // 校验候选项 id 属于给定版本对（前端不直接用，调试/防呆）
  app.get('/api/families/:id/evolutions/:range/validate-candidate', (req, res) => {
    const family = store.snapshot().families.find((f) => f.id === req.params.id);
    if (!family) return json(res, 404, {error: 'not_found'});
    const oldPath = String(req.query.oldPath ?? '');
    const newPath = String(req.query.newPath ?? '');
    res.json({candidateId: candidateId(oldPath, newPath)});
  });

  // 生产模式：托管 vite build 产物
  const clientDist = resolvePath(__dirname, '../../dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        return res.sendFile(resolvePath(clientDist, 'index.html'));
      }
      next();
    });
  }

  return app;
}

function serializeFamily(family: Family) {
  return {
    id: family.id,
    name: family.name,
    createdAt: family.createdAt,
    versions: family.versions.map((v) => ({
      revision: v.revision,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      note: v.note,
      content: v.content,
    })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4174);
  const store = new JsonStore(process.env.SES_DATA_FILE ?? '.data/ses.json');
  seedIfEmpty(store);
  createApp(store).listen(port, '127.0.0.1', () => {
    console.log(`Schema Evolution Studio http://127.0.0.1:${port}`);
  });
}
