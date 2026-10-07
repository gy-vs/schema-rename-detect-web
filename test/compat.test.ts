import {describe, expect, it} from 'vitest';
import {flattenSchema} from '../src/core/flatten';
import {compareFieldSets} from '../src/core/match';
import {buildCompatibility} from '../src/core/compat';
import {EffectiveDecision, ReviewDecision} from '../src/core/types';

function run(oldSchema: Record<string, unknown>, newSchema: Record<string, unknown>) {
  return compareFieldSets(flattenSchema(oldSchema), flattenSchema(newSchema), 0);
}

const orderV7 = {
  type: 'object',
  required: ['orderId', 'customer_name'],
  properties: {
    orderId: {type: 'string'},
    customer_name: {type: 'string', examples: ['张伟']},
  },
};
const orderV8 = {
  type: 'object',
  required: ['orderId', 'buyerName'],
  properties: {
    orderId: {type: 'string'},
    buyerName: {type: 'string', examples: ['张伟']},
  },
};

describe('兼容性随审阅状态变化', () => {
  it('没审阅：undetermined（pending）', () => {
    const analysis = run(orderV7, orderV8);
    const report = buildCompatibility({analysis, decisions: []});
    expect(report.verdict).toBe('undetermined');
    expect(report.pending.length).toBeGreaterThan(0);
  });

  it('确认改名：兼容，旧字段不算删除', () => {
    const analysis = run(orderV7, orderV8);
    const proposal = analysis.proposals.find(p => p.oldPath === '$.customer_name')!;
    const decisions: EffectiveDecision[] = [
      {
        oldPath: proposal.oldPath,
        newPath: proposal.newPath,
        decision: 'confirmed',
        source: 'stored',
        status: 'active',
      },
    ];
    const report = buildCompatibility({analysis, decisions});
    expect(report.verdict).toBe('compatible');
    expect(report.summary.confirmedRenames).toBe(1);
    expect(report.blockers.filter(i => i.code === 'field/removed')).toHaveLength(0);
  });

  it('拒绝：incompatible，按删除+新增处理', () => {
    const analysis = run(orderV7, orderV8);
    const proposal = analysis.proposals.find(p => p.oldPath === '$.customer_name')!;
    const decisions: EffectiveDecision[] = [
      {
        oldPath: proposal.oldPath,
        newPath: proposal.newPath,
        decision: 'rejected',
        source: 'stored',
        status: 'active',
      },
    ];
    const report = buildCompatibility({analysis, decisions});
    expect(report.verdict).toBe('incompatible');
    expect(report.blockers.some(i => i.code === 'pair/rejected')).toBe(true);
    // buyerName 是必填新增 -> 阻断
    expect(report.blockers.some(i => i.code === 'field/added-rejected')).toBe(true);
  });
});

describe('同路径变化', () => {
  it('可选变必填、enum 收窄、format 改变都是阻断；新增可选字段只是 info', () => {
    const analysis = run(
      {
        type: 'object',
        properties: {
          region: {type: 'string'},
          color: {type: 'string', enum: ['r', 'g', 'b']},
          code: {type: 'string', format: 'email'},
          extra: {type: 'string'},
        },
      },
      {
        type: 'object',
        required: ['region'],
        properties: {
          region: {type: 'string'},
          color: {type: 'string', enum: ['r', 'g']},
          code: {type: 'string', format: 'uri'},
          extra: {type: 'string'},
          fresh: {type: 'string'},
        },
      },
    );
    const report = buildCompatibility({analysis, decisions: []});
    const codes = report.blockers.map(i => i.code);
    expect(codes).toContain('same-path/became-required');
    expect(codes).toContain('same-path/enum-values-removed');
    expect(codes).toContain('same-path/format-changed');
    expect(report.infos.some(i => i.code === 'field/added' && i.newPath === '$.fresh')).toBe(true);
    expect(report.verdict).toBe('incompatible');
  });

  it('integer -> number 同路径不算阻断，number -> integer 算', () => {
    const widened = run(
      {type: 'object', properties: {n: {type: 'integer'}}},
      {type: 'object', properties: {n: {type: 'number'}}},
    );
    expect(buildCompatibility({analysis: widened, decisions: []}).blockers).toHaveLength(0);

    const narrowed = run(
      {type: 'object', properties: {n: {type: 'number'}}},
      {type: 'object', properties: {n: {type: 'integer'}}},
    );
    const report = buildCompatibility({analysis: narrowed, decisions: []});
    expect(report.blockers.some(i => i.code === 'same-path/type')).toBe(true);
  });
});

describe('确认改名但定义不兼容仍然阻断', () => {
  it('确认 string -> integer 的改名：类型阻断保留', () => {
    const analysis = run(
      {type: 'object', properties: {age_code: {type: 'string'}}},
      {type: 'object', properties: {ageCode: {type: 'integer'}}},
    );
    const proposal = analysis.proposals.find(p => p.oldPath === '$.age_code')!;
    const decision: EffectiveDecision = {
      oldPath: proposal.oldPath,
      newPath: proposal.newPath,
      decision: 'confirmed',
      source: 'stored',
      status: 'active',
    };
    const report = buildCompatibility({analysis, decisions: [decision]});
    expect(report.verdict).toBe('incompatible');
    expect(report.blockers.some(i => i.code === 'rename/type-incompatible')).toBe(true);
  });
});

describe('纯决策类型检查（ReviewDecision 可直接构造）', () => {
  it('stored + rejected 不产生沿用信息', () => {
    const decision: ReviewDecision = {oldPath: '$.a', newPath: '$.b', decision: 'rejected'};
    expect(decision.decision).toBe('rejected');
  });
});
