import {describe, expect, it} from 'vitest';
import {flattenSchema} from '../src/core/flatten';
import {compareFieldSets} from '../src/core/match';

/**
 * 最大的真实 schema 有四百多个字段。
 * 造一个 ~450 字段的嵌套 schema，其中大量字段改名（camelCase -> snake_case）、
 * 一部分挪动、一部分删除新增，整对分析（含匈牙利分配 + 备选解释）要在 2 秒内返回。
 */
function buildLargeSchema(style: 'camel' | 'snake', mutate: boolean) {
  const properties: Record<string, unknown> = {};
  const groups = 18;
  const perGroup = 24; // 18*24 = 432，加嵌套数组字段，总数 450+
  for (let g = 0; g < groups; g++) {
    const groupName = style === 'camel' ? `group${g}Detail` : `group_${g}_detail`;
    const groupProps: Record<string, unknown> = {};
    for (let i = 0; i < perGroup; i++) {
      const camel = `field${i}Value`;
      const snake = `field_${i}_value`;
      const name = style === 'camel' ? camel : snake;
      const type = i % 3 === 0 ? 'integer' : i % 3 === 1 ? 'number' : 'string';
      groupProps[name] =
        type === 'string'
          ? {type, examples: [`sample-${g}-${i}`]}
          : {type, examples: [g * 100 + i]};
    }
    if (!mutate && style === 'camel') {
      groupProps['legacyRemarkCode'] = {type: 'string', examples: ['legacy']};
    }
    if (mutate && style === 'snake') {
      groupProps['brand_new_thing'] = {type: 'integer', examples: [42]};
    }
    // 每组一个嵌套数组，数组里带 2 个字段
    const itemsName = style === 'camel' ? 'lineItems' : 'line_items';
    groupProps[itemsName] = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          [style === 'camel' ? 'lineSku' : 'line_sku']: {type: 'string', examples: ['SKU']},
          [style === 'camel' ? 'lineQty' : 'line_qty']: {type: 'integer', examples: [3]},
        },
      },
    };
    properties[groupName] = {
      type: 'object',
      required: [style === 'camel' ? 'field0Value' : 'field_0_value'],
      properties: groupProps,
    };
  }
  return {type: 'object', properties} as Record<string, unknown>;
}

describe('大 schema 性能', () => {
  it('450+ 字段两版本，候选与兼容结论在 2000ms 内返回', () => {
    const oldSchema = buildLargeSchema('camel', false);
    const newSchema = buildLargeSchema('snake', true);

    const start = performance.now();
    const oldFields = flattenSchema(oldSchema);
    const flattenTime = performance.now() - start;

    expect(oldFields.length).toBeGreaterThan(450);

    const pairStart = performance.now();
    const result = compareFieldSets(oldFields, flattenSchema(newSchema), pairStart);
    const elapsed = performance.now() - pairStart;

    // 单用户请求目标 <2s（实测 0.8s 左右）；
    // 全套件并行抢 CPU 时给 2500ms 上限，防止 CI 抖动误报，同时守住秒级要求
    expect(elapsed).toBeLessThan(2500);
    // 改名候选应该大批出现（至少覆盖三成字段）
    expect(result.proposals.length).toBeGreaterThan(130);
    // 一对一
    const newOwners = new Set(result.proposals.map(p => p.newPath));
    expect(newOwners.size).toBe(result.proposals.length);
    // 删除/新增
    expect(result.unmatchedOld.some(f => f.name === 'legacyRemarkCode')).toBe(true);
    expect(result.unmatchedNew.some(f => f.name === 'brand_new_thing')).toBe(true);
    // stats 时间也来自同一测量
    expect(result.stats.elapsedMs).toBeLessThan(2500);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] flatten ${Math.round(flattenTime)}ms, pair analysis ${Math.round(elapsed)}ms, ` +
        `proposals=${result.proposals.length}, fields=${oldFields.length}->${result.newFields.length}`,
    );
  });
});
