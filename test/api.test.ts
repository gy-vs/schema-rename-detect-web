import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {buildServer} from '../src/server/index';
import type {Express} from 'express';

const SCHEMA_A = {
  type: 'object',
  required: ['id'],
  properties: {
    id: {type: 'string'},
    customer_name: {type: 'string', examples: ['张伟']},
    address: {
      type: 'object',
      properties: {
        street: {type: 'string'},
        zip: {type: 'string', examples: ['100080']},
      },
    },
  },
};

const SCHEMA_B = {
  type: 'object',
  required: ['id'],
  properties: {
    id: {type: 'string'},
    buyerName: {type: 'string', examples: ['张伟']},
    shipping: {
      type: 'object',
      properties: {
        street: {type: 'string'},
        postcode: {type: 'string', examples: ['100080']},
      },
    },
  },
};

const SCHEMA_C = {
  type: 'object',
  required: ['id'],
  properties: {
    id: {type: 'string'},
    buyerName: {type: 'string', examples: ['张伟']},
    shipping: {
      type: 'object',
      properties: {
        street: {type: 'string'},
        postcode: {type: 'string', pattern: '^[0-9]{6}$', examples: ['100080']},
      },
    },
  },
};

describe('HTTP API', () => {
  let app: Express;
  let dbFile: string;

  beforeEach(() => {
    dbFile = join(mkdtempSync(join(tmpdir(), 'studio-')), 'db.json');
    process.env.STUDIO_DB = dbFile;
    app = buildServer(dbFile).app;
  });
  afterEach(() => {
    delete process.env.STUDIO_DB;
  });

  async function createSchema() {
    const created = await request(app)
      .post('/api/schemas')
      .send({name: '订单', content: JSON.stringify(SCHEMA_A)})
      .expect(201);
    return created.body.id as string;
  }

  it('创建 schema、列表、读版本', async () => {
    const id = await createSchema();
    const list = await request(app).get('/api/schemas').expect(200);
    const created = list.body.find((s: {id: string}) => s.id === id);
    expect(created.latestVersion).toBe(1);
    const version = await request(app).get(`/api/schemas/${id}/versions/1`).expect(200);
    expect(version.body.fieldCount).toBeGreaterThan(3);
  });

  it('坏 schema 文本被拒', async () => {
    await request(app).post('/api/schemas').send({name: 'x', content: '{nope'}).expect(400);
  });

  it('过期版本保存被 409 拒绝并告知最新版', async () => {
    const id = await createSchema();
    await request(app)
      .post(`/api/schemas/${id}/versions`)
      .send({content: JSON.stringify(SCHEMA_B), expectedLatest: 1})
      .expect(201);
    const conflict = await request(app)
      .post(`/api/schemas/${id}/versions`)
      .send({content: JSON.stringify(SCHEMA_C), expectedLatest: 1})
      .expect(409);
    expect(conflict.body.error).toBe('version_conflict');
    expect(conflict.body.latestVersion).toBe(2);
    expect(conflict.body.message).toContain('最新');
  });

  it('分析返回候选；确认后结论 compatible，拒绝后 incompatible', async () => {
    const id = await createSchema();
    await request(app)
      .post(`/api/schemas/${id}/versions`)
      .send({content: JSON.stringify(SCHEMA_B), expectedLatest: 1})
      .expect(201);

    const analysis = await request(app).get(`/api/schemas/${id}/analysis/1/2`).expect(200);
    expect(
      (analysis.body.proposals as Array<{oldPath: string; newPath: string}>).some(
        p => p.oldPath === '$.customer_name' && p.newPath === '$.buyerName',
      ),
    ).toBe(true);
    expect(analysis.body.compatibility.verdict).toBe('undetermined');

    // 审阅人逐条过完所有候选（customer_name、zip、跟着挪位的 street 和对象本身）
    const confirmed = (analysis.body.proposals as Array<{oldPath: string; newPath: string}>).map(
      p => ({...p, decision: 'confirmed' as const}),
    );

    const saved = await request(app)
      .put(`/api/schemas/${id}/reviews/1/2`)
      .send({rev: 0, decisions: confirmed, editor: 'alice'})
      .expect(200);
    expect(saved.body.analysis.compatibility.verdict).toBe('compatible');

    // 改一条为拒绝，结论立刻变 incompatible
    const flipped = confirmed.map(d =>
      d.oldPath === '$.customer_name' ? {...d, decision: 'rejected' as const} : d,
    );
    const rejected = await request(app)
      .put(`/api/schemas/${id}/reviews/1/2`)
      .send({rev: saved.body.rev, decisions: flipped, editor: 'bob'})
      .expect(200);
    expect(rejected.body.analysis.compatibility.verdict).toBe('incompatible');
  });

  it('两个人同时审：过期 rev 被 409 拒绝并回传当前状态', async () => {
    const id = await createSchema();
    await request(app)
      .post(`/api/schemas/${id}/versions`)
      .send({content: JSON.stringify(SCHEMA_B), expectedLatest: 1})
      .expect(201);
    const analysis = await request(app).get(`/api/schemas/${id}/analysis/1/2`).expect(200);
    const decision = {...analysis.body.proposals[0], decision: 'confirmed'};

    await request(app)
      .put(`/api/schemas/${id}/reviews/1/2`)
      .send({rev: 0, decisions: [decision], editor: 'alice'})
      .expect(200);

    const stale = await request(app)
      .put(`/api/schemas/${id}/reviews/1/2`)
      .send({rev: 0, decisions: [], editor: 'bob'})
      .expect(409);
    expect(stale.body.error).toBe('review_conflict');
    expect(stale.body.current.rev).toBe(1);
    expect(stale.body.current.updatedBy).toBe('alice');
    expect(stale.body.message).toContain('alice');
  });

  it('7->8 确认后保存 v9，看 1->3：没动的沿用 active，动过的 reset', async () => {
    const id = await createSchema();
    await request(app)
      .post(`/api/schemas/${id}/versions`)
      .send({content: JSON.stringify(SCHEMA_B), expectedLatest: 1})
      .expect(201);
    await request(app)
      .post(`/api/schemas/${id}/versions`)
      .send({content: JSON.stringify(SCHEMA_C), expectedLatest: 2})
      .expect(201);

    const pair12 = await request(app).get(`/api/schemas/${id}/analysis/1/2`).expect(200);
    const confirmed = pair12.body.proposals
      .filter((p: {oldPath: string}) => ['$.customer_name', '$.address.zip'].includes(p.oldPath))
      .map((p: object) => ({...p, decision: 'confirmed'}));
    await request(app)
      .put(`/api/schemas/${id}/reviews/1/2`)
      .send({rev: 0, decisions: confirmed, editor: 'alice'})
      .expect(200);

    const pair13 = await request(app).get(`/api/schemas/${id}/analysis/1/3`).expect(200);
    const effective = pair13.body.effectiveDecisions as Array<{
      oldPath: string;
      status: string;
      resetReason?: string;
    }>;
    const buyer = effective.find(d => d.oldPath === '$.customer_name')!;
    expect(buyer.status).toBe('active');
    const zip = effective.find(d => d.oldPath === '$.address.zip')!;
    expect(zip.status).toBe('reset');
    // reset 的候选在结论里属于 pending
    expect(pair13.body.compatibility.verdict).toBe('undetermined');
  });
});
