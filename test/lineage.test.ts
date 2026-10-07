import {describe, expect, it} from 'vitest';
import {flattenSchema} from '../src/core/flatten';
import {compareFieldSets} from '../src/core/match';
import {AdjacentStep, effectiveDecisions} from '../src/core/lineage';
import {ReviewDecision} from '../src/core/types';

// 三个版本：
// v7: customer_name + address.zip
// v8: buyerName + shipping.postcode（7->8 两条都确认）
// v9: buyerName 没动；postcode 挪到 shipping.address.postcode 且加了 pattern；新增 note
const v7 = {
  type: 'object',
  required: ['customer_name'],
  properties: {
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
const v8 = {
  type: 'object',
  required: ['buyerName'],
  properties: {
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
const v9 = {
  type: 'object',
  required: ['buyerName'],
  properties: {
    buyerName: {type: 'string', examples: ['张伟']},
    note: {type: 'string'},
    shipping: {
      type: 'object',
      properties: {
        street: {type: 'string'},
        address: {
          type: 'object',
          properties: {
            postcode: {type: 'string', pattern: '^[0-9]{6}$', examples: ['100080']},
          },
        },
      },
    },
  },
};

function step(from: number, to: number, oldSchema: unknown, newSchema: unknown, stored: ReviewDecision[]): AdjacentStep {
  return {
    fromVersion: from,
    toVersion: to,
    analysis: compareFieldSets(flattenSchema(oldSchema as Record<string, unknown>), flattenSchema(newSchema as Record<string, unknown>), 0),
    stored,
  };
}

const review78: ReviewDecision[] = [
  {oldPath: '$.customer_name', newPath: '$.buyerName', decision: 'confirmed'},
  {oldPath: '$.address.zip', newPath: '$.shipping.postcode', decision: 'confirmed'},
];

describe('跨版本沿用 v7->v9（中间经 v8）', () => {
  const steps = [step(7, 8, v7, v8, review78), step(8, 9, v8, v9, [])];

  it('buyerName 没再动过：确认决定沿用且 active', () => {
    const effective = effectiveDecisions(steps, 7, 9, []);
    const buyer = effective.find(d => d.oldPath === '$.customer_name');
    expect(buyer).toBeTruthy();
    expect(buyer!.newPath).toBe('$.buyerName');
    expect(buyer!.decision).toBe('confirmed');
    expect(buyer!.source).toBe('carried');
    expect(buyer!.status).toBe('active');
    expect(buyer!.carriedFrom).toEqual({fromVersion: 7, toVersion: 8});
  });

  it('postcode 又挪位置且加了 pattern：回到待确认（reset，带原因）', () => {
    const effective = effectiveDecisions(steps, 7, 9, []);
    const zip = effective.find(d => d.oldPath === '$.address.zip');
    expect(zip).toBeTruthy();
    expect(zip!.newPath).toBe('$.shipping.address.postcode');
    expect(zip!.status).toBe('reset');
    expect(zip!.resetReason).toMatch(/v9/);
  });
});

describe('目标对上直接保存的决定优先于沿用', () => {
  it('stored 覆盖 carried，且不会重复', () => {
    const steps = [step(7, 8, v7, v8, review78), step(8, 9, v8, v9, [])];
    const direct: ReviewDecision[] = [
      {oldPath: '$.customer_name', newPath: '$.buyerName', decision: 'rejected'},
    ];
    const effective = effectiveDecisions(steps, 7, 9, direct);
    const buyer = effective.filter(d => d.oldPath === '$.customer_name');
    expect(buyer).toHaveLength(1);
    expect(buyer[0].source).toBe('stored');
    expect(buyer[0].decision).toBe('rejected');
  });
});

describe('字段在中间版本被删除：承接链断裂', () => {
  it('v9 删掉 buyerName -> reset', () => {
    const v9deleted = {
      type: 'object',
      properties: {shipping: {type: 'object', properties: {postcode: {type: 'string'}}}},
    };
    const steps = [step(7, 8, v7, v8, review78), step(8, 9, v8, v9deleted, [])];
    const effective = effectiveDecisions(steps, 7, 9, []);
    const buyer = effective.find(d => d.oldPath === '$.customer_name');
    expect(buyer!.status).toBe('reset');
    expect(buyer!.resetReason).toMatch(/不存在|断裂/);
  });
});

describe('相邻跳审阅：v8->v9 单独确认的改名也会在 7->9 体现', () => {
  it('postcode 在 8->9 确认后，7->9 拿到 active carried', () => {
    const review89: ReviewDecision[] = [
      {
        oldPath: '$.shipping.postcode',
        newPath: '$.shipping.address.postcode',
        decision: 'confirmed',
      },
    ];
    const steps = [step(7, 8, v7, v8, review78), step(8, 9, v8, v9, review89)];
    const effective = effectiveDecisions(steps, 7, 9, []);
    const zip = effective.find(d => d.oldPath === '$.address.zip');
    // 8->9 的移动已被审阅；签名变化（pattern）随该确认被接受
    expect(zip!.status).toBe('active');
    expect(zip!.newPath).toBe('$.shipping.address.postcode');
  });
});
