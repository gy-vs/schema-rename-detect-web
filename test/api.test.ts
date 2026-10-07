import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {Express} from 'express';
import {JsonStore} from '../src/server/store';

const SCHEMA_V1 = JSON.stringify({
  type: 'object',
  properties: {name: {type: 'string'}, nickname: {type: 'string'}},
  required: ['name'],
});
const SCHEMA_V2 = JSON.stringify({
  type: 'object',
  properties: {fullName: {type: 'string'}, displayName: {type: 'string'}},
  required: ['fullName'],
});

describe('schema evolution api', () => {
  let dir: string;
  let app: Express;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ses-'));
    const store = new JsonStore(join(dir, 'data.json'));
    app = createApp(store);
  });
  afterEach(() => rmSync(dir, {recursive: true, force: true}));

  async function createFamily(content = SCHEMA_V1) {
    const res = await request(app)
      .post('/api/families')
      .send({id: 'orders', name: '订单', content})
      .expect(201);
    return res.body;
  }

  it('创建 family、保存新版本、取回旧版本', async () => {
    await createFamily();
    const v2 = await request(app)
      .post('/api/families/orders/versions')
      .send({content: SCHEMA_V2, expectedRevision: 1, author: '小王'})
      .expect(201);
    expect(v2.body.revision).toBe(2);
    const old = await request(app).get('/api/families/orders/versions/1').expect(200);
    expect(old.body.content).toBe(SCHEMA_V1);
  });

  it('手里版本过期时保存被拒，并告知最新版本号', async () => {
    await createFamily();
    await request(app)
      .post('/api/families/orders/versions')
      .send({content: SCHEMA_V2, expectedRevision: 1})
      .expect(201);
    const stale = await request(app)
      .post('/api/families/orders/versions')
      .send({content: '{}', expectedRevision: 1})
      .expect(409);
    expect(stale.body.error).toBe('stale_revision');
    expect(stale.body.latestRevision).toBe(2);
  });

  it('非法 JSON 或根非对象的 schema 保存返回 400', async () => {
    await createFamily();
    await request(app)
      .post('/api/families/orders/versions')
      .send({content: '{not json', expectedRevision: 1})
      .expect(400);
    await request(app)
      .post('/api/families/orders/versions')
      .send({content: JSON.stringify({type: 'string'}), expectedRevision: 1})
      .expect(400);
  });

  it('evolution 给出 name->fullName、nickname->displayName 候选', async () => {
    await createFamily();
    await request(app)
      .post('/api/families/orders/versions')
      .send({content: SCHEMA_V2, expectedRevision: 1})
      .expect(201);
    const res = await request(app).get('/api/families/orders/evolutions/1-2').expect(200);
    const pairs = Object.fromEntries(
      res.body.candidates.map((c: any) => [c.oldPath, c.newPath]),
    );
    expect(pairs.name).toBe('fullName');
    expect(pairs.nickname).toBe('displayName');
    expect(res.body.report.verdict).toBe('undetermined');
    expect(res.body.review.revision).toBe(0);
  });

  it('提交审阅后结论变为 compatible；换人重新打开看得到（持久化）', async () => {
    await createFamily();
    await request(app)
      .post('/api/families/orders/versions')
      .send({content: SCHEMA_V2, expectedRevision: 1})
      .expect(201);
    const evo = await request(app).get('/api/families/orders/evolutions/1-2');
    const decisions: Record<string, string> = {};
    for (const c of evo.body.candidates) decisions[c.id] = 'confirmed';
    const saved = await request(app)
      .put('/api/families/orders/reviews/1-2')
      .send({decisions, baseRevision: 0, author: '审阅人A'})
      .expect(200);
    expect(saved.body.revision).toBe(1);

    const after = await request(app).get('/api/families/orders/evolutions/1-2').expect(200);
    expect(after.body.report.verdict).toBe('compatible');
    expect(after.body.review.updatedBy).toBe('审阅人A');

    // 模拟“换人打开”：用同一个数据文件重新建一个 app
    const reopened = createApp(new JsonStore(join(dir, 'data.json')));
    const other = await request(reopened)
      .get('/api/families/orders/evolutions/1-2')
      .expect(200);
    expect(other.body.report.verdict).toBe('compatible');
    expect(other.body.review.updatedBy).toBe('审阅人A');
  });

  it('两个人同时审，后提交且 revision 过期时收到 409 并知道别人改过', async () => {
    await createFamily();
    await request(app)
      .post('/api/families/orders/versions')
      .send({content: SCHEMA_V2, expectedRevision: 1});
    const evo = await request(app).get('/api/families/orders/evolutions/1-2');
    const decisions: Record<string, string> = {};
    for (const c of evo.body.candidates) decisions[c.id] = 'confirmed';

    await request(app)
      .put('/api/families/orders/reviews/1-2')
      .send({decisions, baseRevision: 0, author: 'A'})
      .expect(200);

    // B 仍以 baseRevision=0 提交
    const conflict = await request(app)
      .put('/api/families/orders/reviews/1-2')
      .send({decisions, baseRevision: 0, author: 'B'})
      .expect(409);
    expect(conflict.body.error).toBe('review_conflict');
    expect(conflict.body.currentRevision).toBe(1);
    // 基于最新 revision 重试成功
    await request(app)
      .put('/api/families/orders/reviews/1-2')
      .send({decisions, baseRevision: 1, author: 'B'})
      .expect(200);
  });

  it('非相邻区间（如 1-3）也有独立的审阅记录与乐观锁', async () => {
    await createFamily();
    await request(app)
      .post('/api/families/orders/versions')
      .send({content: SCHEMA_V2, expectedRevision: 1});
    // 第 3 版与第 2 版相同
    const v3 = await request(app)
      .post('/api/families/orders/versions')
      .send({content: SCHEMA_V2, expectedRevision: 2})
      .expect(201);
    expect(v3.body.revision).toBe(3);

    const evo = await request(app).get('/api/families/orders/evolutions/1-3').expect(200);
    const decisions: Record<string, string> = {};
    for (const c of evo.body.candidates) decisions[c.id] = 'confirmed';
    await request(app)
      .put('/api/families/orders/reviews/1-3')
      .send({decisions, baseRevision: 0})
      .expect(200);
    const after = await request(app).get('/api/families/orders/evolutions/1-3').expect(200);
    expect(after.body.report.verdict).toBe('compatible');
    // 1-2 区间不受影响，仍为未审
    const adjacent = await request(app).get('/api/families/orders/evolutions/1-2').expect(200);
    expect(adjacent.body.review.revision).toBe(0);
  });

  it('审阅状态一变，兼容结论立刻跟着变', async () => {
    await createFamily();
    await request(app)
      .post('/api/families/orders/versions')
      .send({content: SCHEMA_V2, expectedRevision: 1});
    const evo = await request(app).get('/api/families/orders/evolutions/1-2');
    const zipCandidate = evo.body.candidates[0];

    await request(app)
      .put('/api/families/orders/reviews/1-2')
      .send({decisions: {[zipCandidate.id]: 'confirmed'}, baseRevision: 0})
      .expect(200);
    const confirmed = await request(app).get('/api/families/orders/evolutions/1-2');
    // 另一个候选未决
    expect(confirmed.body.report.verdict).toBe('undetermined');

    const rejected: Record<string, string> = {};
    for (const c of evo.body.candidates) rejected[c.id] = 'rejected';
    await request(app)
      .put('/api/families/orders/reviews/1-2')
      .send({decisions: rejected, baseRevision: 1})
      .expect(200);
    const afterReject = await request(app).get('/api/families/orders/evolutions/1-2');
    expect(afterReject.body.report.verdict).toBe('incompatible');
  });
});
