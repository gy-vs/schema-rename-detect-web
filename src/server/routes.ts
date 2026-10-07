import express from 'express';
import type {Response} from 'express';
import {AnalyzerService, BadRequest, NotFoundError} from './analyzer';
import {NotFoundError as StoreNotFound, Store} from './store';
import type {SchemaDoc, SchemaVersionDoc} from './store';
import {ReviewDecision, SchemaParseError} from '../core/types';
import {parseSchemaText} from '../core/flatten';

export interface AppOptions {
  store: Store;
  analyzer: AnalyzerService;
}

export function createApp({store, analyzer}: AppOptions): express.Express {
  const app = express();
  app.use(express.json({limit: '4mb'}));

  app.get('/api/health', (_req, res) => res.json({ok: true}));

  // ---- schema 列表 / 创建 ----
  app.get('/api/schemas', (_req, res) => {
    res.json(
      store.listSchemas().map(schema => ({
        id: schema.id,
        name: schema.name,
        createdAt: schema.createdAt,
        updatedAt: schema.updatedAt,
        latestVersion: schema.versions[schema.versions.length - 1].version,
        versionCount: schema.versions.length,
      })),
    );
  });

  app.post('/api/schemas', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!name) return res.status(400).json({error: 'name_required'});
    const parsed = tryParse(content);
    if (!parsed.ok) return res.status(400).json({error: 'invalid_schema', message: parsed.error.message});
    const doc = store.createSchema(name, content);
    res.status(201).json(schemaPayloadDoc(doc));
  });

  // ---- 单个 schema 元数据 + 版本列表 / 内容 ----
  app.get('/api/schemas/:id', (req, res) => {
    const schema = store.getSchema(req.params.id);
    if (!schema) return res.status(404).json({error: 'not_found'});
    res.json(schemaPayloadDoc(schema));
  });

  app.get('/api/schemas/:id/versions/:version', (req, res) => {
    const schema = store.getSchema(req.params.id);
    if (!schema) return res.status(404).json({error: 'not_found'});
    const version = Number(req.params.version);
    const doc = schema.versions.find(v => v.version === version);
    if (!doc) return res.status(404).json({error: 'not_found'});
    const parsed = analyzer.fieldsFor(doc.content);
    res.json({
      ...doc,
      parseError: parsed.error ? {message: parsed.error.message} : null,
      fieldCount: parsed.fields ? parsed.fields.length - 1 : 0,
    });
  });

  // ---- 保存新版本：乐观锁，过期就拒并告诉对方最新版 ----
  app.post('/api/schemas/:id/versions', (req, res) => {
    const schema = store.getSchema(req.params.id);
    if (!schema) return res.status(404).json({error: 'not_found'});
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const expectedLatest = Number(req.body?.expectedLatest);
    if (!Number.isInteger(expectedLatest) || expectedLatest < 1) {
      return res.status(400).json({error: 'expected_latest_required'});
    }
    const parsed = tryParse(content);
    if (!parsed.ok) {
      return res.status(400).json({error: 'invalid_schema', message: parsed.error.message});
    }
    const result = store.addVersion(schema.id, content, expectedLatest);
    if (!result.ok) {
      return res.status(409).json({
        error: 'version_conflict',
        message: `你手里的是 v${expectedLatest}，最新已经是 v${result.latest}，保存会覆盖别人的改动，已拒绝。`,
        latestVersion: result.latest,
        latest: versionPayload(schema.versions.find(v => v.version === result.latest)!),
      });
    }
    res.status(201).json(schemaPayloadDoc(result.doc));
  });

  // ---- 取一对版本的工作台分析（候选 + 兼容性）----
  app.get('/api/schemas/:id/analysis/:fromVersion/:toVersion', (req, res) => {
    const schema = store.getSchema(req.params.id);
    if (!schema) return res.status(404).json({error: 'not_found'});
    const fromVersion = Number(req.params.fromVersion);
    const toVersion = Number(req.params.toVersion);
    try {
      const result = analyzer.analyzePair(schema, fromVersion, toVersion);
      res.json({
        schemaId: schema.id,
        fromVersion,
        toVersion,
        proposals: result.analysis.proposals,
        unmatchedOld: result.analysis.unmatchedOld,
        unmatchedNew: result.analysis.unmatchedNew,
        samePathChanges: result.analysis.samePathChanges,
        stats: result.analysis.stats,
        review: result.review,
        effectiveDecisions: result.effective,
        compatibility: result.compatibility,
      });
    } catch (error) {
      handleError(error, res);
    }
  });

  // ---- 审阅状态 ----
  app.get('/api/schemas/:id/reviews/:fromVersion/:toVersion', (req, res) => {
    const schema = store.getSchema(req.params.id);
    if (!schema) return res.status(404).json({error: 'not_found'});
    const fromVersion = Number(req.params.fromVersion);
    const toVersion = Number(req.params.toVersion);
    const doc = store.getReview(schema.id, fromVersion, toVersion);
    res.json({schemaId: schema.id, fromVersion, toVersion, ...doc});
  });

  app.put('/api/schemas/:id/reviews/:fromVersion/:toVersion', (req, res) => {
    const schema = store.getSchema(req.params.id);
    if (!schema) return res.status(404).json({error: 'not_found'});
    const fromVersion = Number(req.params.fromVersion);
    const toVersion = Number(req.params.toVersion);
    if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion) || fromVersion >= toVersion) {
      return res.status(400).json({error: 'invalid_versions'});
    }
    if (!schema.versions.some(v => v.version === fromVersion) ||
        !schema.versions.some(v => v.version === toVersion)) {
      return res.status(404).json({error: 'version_not_found'});
    }
    const expectedRev = Number(req.body?.rev);
    if (!Number.isInteger(expectedRev) || expectedRev < 0) {
      return res.status(400).json({error: 'rev_required'});
    }
    const decisions = sanitizeDecisions(req.body?.decisions);
    if (!decisions) return res.status(400).json({error: 'invalid_decisions'});
    const editor = typeof req.body?.editor === 'string' ? req.body.editor.slice(0, 80) : undefined;

    const saved = store.saveReview(schema.id, fromVersion, toVersion, decisions, expectedRev, editor);
    if (!saved.ok) {
      return res.status(409).json({
        error: 'review_conflict',
        message: `审阅状态已被${saved.current.updatedBy ? ` ${saved.current.updatedBy}` : '别人'}更新（rev ${saved.current.rev}，${saved.current.updatedAt}），请刷新后在最新结果上修改。`,
        current: {schemaId: schema.id, fromVersion, toVersion, ...saved.current},
      });
    }
    // 保存后立即返回最新分析（结论随审阅状态变化）
    try {
      const result = analyzer.analyzePair(schema, fromVersion, toVersion);
      res.json({
        schemaId: schema.id,
        fromVersion,
        toVersion,
        ...saved.doc,
        analysis: {
          proposals: result.analysis.proposals,
          unmatchedOld: result.analysis.unmatchedOld,
          unmatchedNew: result.analysis.unmatchedNew,
          samePathChanges: result.analysis.samePathChanges,
          effectiveDecisions: result.effective,
          compatibility: result.compatibility,
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  });

  return app;
}

function sanitizeDecisions(value: unknown): ReviewDecision[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ReviewDecision[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const row = item as Record<string, unknown>;
    if (typeof row.oldPath !== 'string' || typeof row.newPath !== 'string') return undefined;
    if (row.decision !== 'confirmed' && row.decision !== 'rejected') return undefined;
    out.push({oldPath: row.oldPath, newPath: row.newPath, decision: row.decision});
  }
  return out;
}

function tryParse(content: string): {ok: true} | {ok: false; error: SchemaParseError} {
  try {
    parseSchemaText(content);
    return {ok: true};
  } catch (error) {
    if (error instanceof SchemaParseError) return {ok: false, error};
    throw error;
  }
}

function handleError(error: unknown, res: Response): void {
  if (error instanceof BadRequest) {
    res.status(400).json({error: 'bad_request', message: error.message});
  } else if (error instanceof NotFoundError || error instanceof StoreNotFound) {
    res.status(404).json({error: 'not_found'});
  } else if (error instanceof Error) {
    res.status(500).json({error: 'internal', message: error.message});
  } else {
    res.status(500).json({error: 'internal'});
  }
}

function schemaPayloadDoc(doc: SchemaDoc) {
  return {
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    latestVersion: doc.versions[doc.versions.length - 1].version,
    versions: doc.versions.map(versionPayload),
  };
}

function versionPayload(v: SchemaVersionDoc) {
  return {
    version: v.version,
    createdAt: v.createdAt,
    baseVersion: v.baseVersion,
    content: v.content,
  };
}
