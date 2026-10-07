import {describe, expect, it} from 'vitest';
import type {JsonSchema} from '../src/engine/types';
import {
  analyzeEvolution,
  candidateId,
  type DecisionMap,
} from '../src/engine/evolution';

const V7 = {
  type: 'object',
  properties: {
    name: {type: 'string', examples: ['Alice Smith']},
    nickname: {type: 'string', examples: ['Ally']},
    address: {
      type: 'object',
      properties: {
        street: {type: 'string'},
        zip: {type: 'string', examples: ['100000']},
      },
      required: ['street', 'zip'],
    },
  },
  required: ['name'],
} as unknown as JsonSchema;

const V8 = {
  type: 'object',
  properties: {
    fullName: {type: 'string', examples: ['Bob Jones']},
    displayName: {type: 'string', examples: ['Bobby']},
    shipping: {
      type: 'object',
      properties: {
        street: {type: 'string'},
        postcode: {type: 'string', examples: ['200000']},
      },
      required: ['street', 'postcode'],
    },
  },
  required: ['fullName'],
} as unknown as JsonSchema;

const versions = [{revision: 1, content: V7}, {revision: 2, content: V8}];

function analyze(decisions: DecisionMap = new Map()) {
  return analyzeEvolution({
    familyId: 'orders',
    fromRevision: 1,
    toRevision: 2,
    versions,
    directDecisions: decisions,
    allReviews: new Map(),
  });
}

describe('rename candidate assignment', () => {
  it('name 配 fullName、nickname 配 displayName，且一对一', () => {
    const result = analyze();
    const pair = (old: string) =>
      result.candidates.find((c) => c.oldPath === old)?.newPath;
    expect(pair('name')).toBe('fullName');
    expect(pair('nickname')).toBe('displayName');
    // 一个新字段只归一个旧字段
    const news = result.candidates.map((c) => c.newPath);
    expect(news.length).toBe(new Set(news).size);
  });

  it('address.zip 被识别为挪位置 + 改名到 shipping.postcode', () => {
    const result = analyze();
    const zip = result.candidates.find((c) => c.oldPath === 'address.zip');
    expect(zip?.newPath).toBe('shipping.postcode');
    expect(zip?.moved).toBe(true);
    expect(zip?.score).toBeGreaterThan(0.8);
  });

  it('每个候选都带可解释的评分维度和落选备选', () => {
    const result = analyze();
    const nameCandidate = result.candidates.find((c) => c.oldPath === 'name')!;
    const keys = nameCandidate.features.map((f) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining(['name', 'type', 'required', 'enum', 'format', 'examples', 'siblings', 'depth']),
    );
    // 落选备选说明分差
    const displayRunner = nameCandidate.runnerUps.find((r) => r.newPath === 'displayName');
    expect(displayRunner).toBeTruthy();
    expect(displayRunner!.gap).toBeGreaterThan(0);
    expect(displayRunner!.reason).toContain('一对一');
    // 没写 examples 的字段也能出候选（name 有 examples，这里用 address.zip 验证结构类字段）
    const street = result.candidates.find((c) => c.oldPath === 'address.street');
    expect(street).toBeTruthy();
  });

  it('examples 缺失不影响候选生成', () => {
    const vA = {type: 'object', properties: {foo_bar: {type: 'integer'}}};
    const vB = {type: 'object', properties: {fooBaz: {type: 'integer'}}};
    const r = analyzeEvolution({
      familyId: 'x',
      fromRevision: 1,
      toRevision: 2,
      versions: [
        {revision: 1, content: vA as unknown as JsonSchema},
        {revision: 2, content: vB as unknown as JsonSchema},
      ],
      directDecisions: new Map(),
      allReviews: new Map(),
    });
    expect(r.candidates.some((c) => c.oldPath === 'foo_bar' && c.newPath === 'fooBaz')).toBe(true);
  });
});

describe('compatibility verdict follows review decisions', () => {
  it('未审时结论待定', () => {
    expect(analyze().report.verdict).toBe('undetermined');
  });

  it('全部确认后：改名不算删除，结论安全', () => {
    const dec = new Map(
      analyze().candidates.map((c) => [c.id, 'confirmed' as const]),
    );
    const result = analyze(dec);
    expect(result.report.verdict).toBe('compatible');
    expect(result.report.renamedAway).toEqual(
      expect.arrayContaining(['name', 'nickname', 'address.zip']),
    );
    expect(result.report.findings.some((f) => f.code === 'field_removed')).toBe(false);
  });

  it('拒绝配对 = 删除一个 + 新增一个，报不兼容', () => {
    const initial = analyze();
    const dec = new Map<string, 'confirmed' | 'rejected'>();
    for (const c of initial.candidates) {
      dec.set(c.id, c.oldPath === 'address.zip' ? 'rejected' : 'confirmed');
    }
    const result = analyze(dec);
    expect(result.report.verdict).toBe('incompatible');
    const codes = result.report.findings.map((f) => f.code);
    expect(codes).toContain('candidate_rejected');
    expect(codes).toContain('field_removed');
    expect(codes).toContain('required_field_added');
  });

  it('integer→number 同路径兼容；string→integer 不兼容', () => {
    const vA = {type: 'object', properties: {qty: {type: 'integer'}}};
    const vB = {type: 'object', properties: {qty: {type: 'number'}}};
    const r = analyzeEvolution({
      familyId: 'x',
      fromRevision: 1,
      toRevision: 2,
      versions: [
        {revision: 1, content: vA as unknown as JsonSchema},
        {revision: 2, content: vB as unknown as JsonSchema},
      ],
      directDecisions: new Map(),
      allReviews: new Map(),
    });
    expect(r.report.verdict).toBe('compatible');
    const vC = {type: 'object', properties: {qty: {type: 'string'}}};
    const r2 = analyzeEvolution({
      familyId: 'x',
      fromRevision: 1,
      toRevision: 2,
      versions: [
        {revision: 1, content: vA as unknown as JsonSchema},
        {revision: 2, content: vC as unknown as JsonSchema},
      ],
      directDecisions: new Map(),
      allReviews: new Map(),
    });
    expect(r2.report.verdict).toBe('incompatible');
  });
});

describe('carry-forward across later versions', () => {
  const V9 = {
    type: 'object',
    properties: {
      // buyerName 在上一跳把内容改成 integer —— 动过
      buyerName: {type: 'integer'},
      displayName: {type: 'string', examples: ['Bobby']},
      shipping: {
        type: 'object',
        properties: {
          street: {type: 'string'},
          postcode: {type: 'string', examples: ['200000']},
        },
        required: ['street', 'postcode'],
      },
    },
    required: ['buyerName'],
  } as unknown as JsonSchema;

  // 7->8 版本里用 buyerName 而不是 fullName，对应“客户名”字段
  const V7b = {
    type: 'object',
    properties: {
      customer_name: {type: 'string'},
      nickname: {type: 'string'},
      address: {
        type: 'object',
        properties: {street: {type: 'string'}, zip: {type: 'string'}},
      },
    },
  } as unknown as JsonSchema;
  const V8b = {
    type: 'object',
    properties: {
      buyerName: {type: 'string'},
      displayName: {type: 'string'},
      shipping: {
        type: 'object',
        properties: {street: {type: 'string'}, postcode: {type: 'string'}},
      },
    },
  } as unknown as JsonSchema;

  it('7->8 确认后看 7->9：没动过的沿用，动过的回待确认', () => {
    const vs = [
      {revision: 1, content: V7b},
      {revision: 2, content: V8b},
      {revision: 3, content: V9},
    ];
    const r12 = analyzeEvolution({
      familyId: 'x', fromRevision: 1, toRevision: 2, versions: vs,
      directDecisions: new Map(), allReviews: new Map(),
    });
    const dec8 = new Map<string, 'confirmed'>();
    for (const c of r12.candidates) dec8.set(c.id, 'confirmed');
    const reviews = new Map<number, DecisionMap>([[2, dec8]]);

    const r13 = analyzeEvolution({
      familyId: 'x', fromRevision: 1, toRevision: 3, versions: vs,
      directDecisions: new Map(), allReviews: reviews,
    });
    const zip = r13.candidates.find((c) => c.oldPath === 'address.zip');
    const nick = r13.candidates.find((c) => c.oldPath === 'nickname');
    expect(zip?.status).toBe('confirmed');
    expect(zip?.inherited).toBe(true);
    expect(zip?.inheritedFrom).toBe('1->2');
    expect(nick?.status).toBe('confirmed');
    expect(nick?.inherited).toBe(true);
    // customer_name -> buyerName 这对在 v9 里类型变了，结论失效
    const buyer = r13.candidates.find((c) => c.oldPath === 'customer_name');
    expect(buyer).toBeUndefined(); // 2->3 配对断了，直接作为删除
    expect(r13.report.findings.some((f) => f.code === 'field_removed' && f.path === 'customer_name')).toBe(true);
  });

  it('被拒绝的配对在后续未变版本上同样沿用为拒绝', () => {
    const v1 = {type: 'object', properties: {a_name: {type: 'string'}}};
    const v2 = {type: 'object', properties: {aTitle: {type: 'string'}}};
    const v3 = {type: 'object', properties: {aTitle: {type: 'string'}}};
    const vs = [
      {revision: 1, content: v1 as unknown as JsonSchema},
      {revision: 2, content: v2 as unknown as JsonSchema},
      {revision: 3, content: v3 as unknown as JsonSchema},
    ];
    const r12 = analyzeEvolution({
      familyId: 'x', fromRevision: 1, toRevision: 2, versions: vs,
      directDecisions: new Map(), allReviews: new Map(),
    });
    const dec = new Map<string, 'rejected'>();
    for (const c of r12.candidates) dec.set(c.id, 'rejected');
    const reviews = new Map<number, DecisionMap>([[2, dec]]);
    const r13 = analyzeEvolution({
      familyId: 'x', fromRevision: 1, toRevision: 3, versions: vs,
      directDecisions: new Map(), allReviews: reviews,
    });
    const cand = r13.candidates.find((c) => c.oldPath === 'a_name');
    expect(cand?.status).toBe('rejected');
    expect(cand?.inherited).toBe(true);
  });
});

describe('performance on 400+ fields', () => {
  it('两个版本之间的候选与兼容结论在 2 秒内返回', () => {
    const N = 420;
    const mk = (renameEvery: number) => {
      const props: Record<string, unknown> = {};
      for (let i = 0; i < N; i++) {
        const name = i % renameEvery === 0 ? `field_${i}Renamed` : `field_${i}`;
        props[name] = {type: i % 3 === 0 ? 'integer' : 'string'};
      }
      return {type: 'object', properties: props} as unknown as JsonSchema;
    };
    const start = performance.now();
    const r = analyzeEvolution({
      familyId: 'big',
      fromRevision: 1,
      toRevision: 2,
      versions: [{revision: 1, content: mk(9999)}, {revision: 2, content: mk(7)}],
      directDecisions: new Map(),
      allReviews: new Map(),
    });
    const elapsed = performance.now() - start;
    // 至少找到了相当数量的改名候选
    expect(r.candidates.length).toBeGreaterThan(40);
    expect(elapsed).toBeLessThan(2000);
  }, 10000);
});

describe('candidateId stability', () => {
  it('相同路径对生成稳定 id', () => {
    expect(candidateId('a.b', 'c.d')).toBe(candidateId('a.b', 'c.d'));
    expect(candidateId('a.b', 'c.d')).not.toBe(candidateId('a.b', 'c.e'));
  });
});
