import {describe, expect, it} from 'vitest';
import {flattenSchema} from '../src/core/flatten';
import {compareFieldSets} from '../src/core/match';

function analyze(oldSchema: Record<string, unknown>, newSchema: Record<string, unknown>) {
  const oldFields = flattenSchema(oldSchema);
  const newFields = flattenSchema(newSchema);
  return compareFieldSets(oldFields, newFields, 0);
}

function findProposal(result: ReturnType<typeof analyze>, oldPath: string, newPath: string) {
  return result.proposals.find(p => p.oldPath === oldPath && p.newPath === newPath);
}

describe('事故复盘：订单 v7 -> v8', () => {
  const v7 = {
    type: 'object',
    required: ['orderId', 'customer_name', 'address'],
    properties: {
      orderId: {type: 'string', examples: ['ORD-1']},
      customer_name: {type: 'string', examples: ['张伟']},
      address: {
        type: 'object',
        required: ['street', 'city', 'zip'],
        properties: {
          street: {type: 'string'},
          city: {type: 'string'},
          zip: {type: 'string', examples: ['100080']},
        },
      },
    },
  };
  const v8 = {
    type: 'object',
    required: ['orderId', 'buyerName', 'shipping'],
    properties: {
      orderId: {type: 'string', examples: ['ORD-1']},
      buyerName: {type: 'string', examples: ['张伟']},
      shipping: {
        type: 'object',
        required: ['street', 'city', 'postcode'],
        properties: {
          street: {type: 'string'},
          city: {type: 'string'},
          postcode: {type: 'string', examples: ['100080']},
        },
      },
    },
  };

  it('customer_name -> buyerName 出候选', () => {
    const result = analyze(v7, v8);
    const proposal = findProposal(result, '$.customer_name', '$.buyerName');
    expect(proposal).toBeTruthy();
    expect(proposal!.score).toBeGreaterThanOrEqual(45);
  });

  it('address.zip -> shipping.postcode 出候选（位置移动 + examples 同类）', () => {
    const result = analyze(v7, v8);
    const proposal = findProposal(result, '$.address.zip', '$.shipping.postcode');
    expect(proposal).toBeTruthy();
    // examples 是一样的六位字符串，兄弟字段 street/city 也一致
    expect(proposal!.score).toBeGreaterThanOrEqual(35);
    const examplesFeature = proposal!.features.find(f => f.key === 'examples');
    expect(examplesFeature!.contribution).toBeGreaterThan(2);
    const siblingFeature = proposal!.features.find(f => f.key === 'sibling');
    expect(siblingFeature!.contribution).toBeGreaterThan(10);
  });

  it('同路径 orderId、street、city 不进候选池', () => {
    const result = analyze(v7, v8);
    expect(result.proposals.some(p => p.oldPath === '$.orderId')).toBe(false);
  });
});

describe('一对一分配：name/nickname -> fullName/displayName', () => {
  const oldSchema = {
    type: 'object',
    properties: {
      name: {type: 'string', examples: ['张三']},
      nickname: {type: 'string', examples: ['小三']},
    },
  };
  const newSchema = {
    type: 'object',
    properties: {
      fullName: {type: 'string', examples: ['张三']},
      displayName: {type: 'string', examples: ['小三']},
    },
  };

  it('name 配 fullName，nickname 配 displayName；一个新字段只归一个旧字段', () => {
    const result = analyze(oldSchema, newSchema);
    expect(findProposal(result, '$.name', '$.fullName')).toBeTruthy();
    expect(findProposal(result, '$.nickname', '$.displayName')).toBeTruthy();
    const newOwners = new Set(result.proposals.map(p => p.newPath));
    expect(newOwners.size).toBe(result.proposals.length);
    // 反过来的错误配对不应出现
    expect(findProposal(result, '$.name', '$.displayName')).toBeFalsy();
    expect(findProposal(result, '$.nickname', '$.fullName')).toBeFalsy();
  });

  it('每条候选都带可追溯依据和备选解释', () => {
    const result = analyze(oldSchema, newSchema);
    for (const proposal of result.proposals) {
      expect(proposal.features.map(f => f.key).sort()).toEqual(
        ['enum', 'examples', 'format', 'name', 'required', 'sibling', 'structure', 'type'].sort(),
      );
      const total = proposal.features.reduce((sum, f) => sum + f.contribution, 0);
      expect(total).toBe(proposal.score);
      expect(proposal.runnerUps.length).toBeGreaterThan(0);
    }
    // name 这条上 displayName 应该作为落选备选可见
    const nameToFull = findProposal(result, '$.name', '$.fullName')!;
    expect(nameToFull.runnerUps.some(edge => edge.newName === 'displayName')).toBe(true);
  });
});

describe('类型不兼容仍出候选但类型分为 0', () => {
  it('string age -> integer ageName 改名仍可见，兼容结论留给审阅人+阻断', () => {
    const result = analyze(
      {
        type: 'object',
        properties: {ageCode: {type: 'string', examples: ['01']}},
      },
      {
        type: 'object',
        properties: {ageCodeValue: {type: 'integer', examples: [1]}},
      },
    );
    const proposal = result.proposals[0];
    expect(proposal).toBeTruthy();
    const typeFeature = proposal.features.find(f => f.key === 'type')!;
    expect(typeFeature.contribution).toBe(0);
    expect(proposal.typeTransition).toBe('changed');
  });
});

describe('integer->number 兼容、name 无关不配对', () => {
  it('integer count 重命名 total 且放宽 number：类型高分', () => {
    const result = analyze(
      {type: 'object', properties: {count: {type: 'integer'}, note: {type: 'string'}}},
      {type: 'object', properties: {total: {type: 'number'}, remark: {type: 'string'}}},
    );
    const countTotal = findProposal(result, '$.count', '$.total');
    expect(countTotal).toBeTruthy();
    const typeFeature = countTotal!.features.find(f => f.key === 'type')!;
    expect(typeFeature.contribution).toBe(Math.round(14 * 0.85));
  });

  it('完全不同名字且无兄弟/examples 支撑的字段宁可判删除+新增', () => {
    const result = analyze(
      {type: 'object', properties: {aaa: {type: 'string'}, zzz: {type: 'string'}}},
      {type: 'object', properties: {qqq: {type: 'string'}, xxx: {type: 'string'}}},
    );
    expect(result.proposals.length).toBe(0);
    expect(result.unmatchedOld.map(f => f.name).sort()).toEqual(['aaa', 'zzz']);
    expect(result.unmatchedNew.map(f => f.name).sort()).toEqual(['qqq', 'xxx']);
  });
});
