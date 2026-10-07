import {describe, expect, it} from 'vitest';
import {flattenSchema} from '../src/engine/parse';
import {hungarian} from '../src/engine/matcher';

describe('flattenSchema', () => {
  it('展开 $defs/$ref 到确定的字段路径', () => {
    const schema: any = {
      type: 'object',
      properties: {
        a: {$ref: '#/$defs/A'},
      },
      $defs: {
        A: {
          type: 'object',
          properties: {x: {type: 'string'}, y: {type: 'integer'}},
          required: ['x'],
        },
      },
    };
    const nodes = flattenSchema(schema);
    const paths = nodes.map((n) => n.path);
    expect(paths).toContain('a');
    expect(paths).toContain('a.x');
    expect(paths).toContain('a.y');
    expect(nodes.find((n) => n.path === 'a.x')?.required).toBe(true);
  });

  it('category.children 指回 category 的循环引用在回边处截断，兄弟字段仍然完整展开', () => {
    const schema: any = {
      type: 'object',
      properties: {category: {$ref: '#/$defs/Category'}},
      $defs: {
        Category: {
          type: 'object',
          properties: {
            id: {type: 'string'},
            name: {type: 'string'},
            children: {type: 'array', items: {$ref: '#/$defs/Category'}},
          },
          required: ['id'],
        },
      },
    };
    const nodes = flattenSchema(schema);
    const byPath = new Map(nodes.map((n) => [n.path, n]));
    // 第一次展开：完整字段
    expect(byPath.get('category.id')).toBeTruthy();
    expect(byPath.get('category.name')).toBeTruthy();
    expect(byPath.get('category.children')).toBeTruthy();
    // 循环在数组项处截断并留痕
    const back = byPath.get('category.children[]');
    expect(back).toBeTruthy();
    expect(back?.recursiveBackRef).toBe('#/$defs/Category');
    // 截断后不再产生无限深的路径
    expect(byPath.has('category.children[].children[]')).toBe(false);
  });

  it('properties 书写顺序不影响打平结果', () => {
    const mk = (order: string[]) => ({
      type: 'object',
      properties: Object.fromEntries(
        order.map((k) => [k, {type: 'string'}]),
      ),
    });
    const a = flattenSchema(mk(['z', 'y', 'x']) as any).map((n) => n.path);
    const b = flattenSchema(mk(['x', 'y', 'z']) as any).map((n) => n.path);
    expect(a).toEqual(b);
  });

  it('数组项路径用 [] 表达且不丢字段', () => {
    const schema: any = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {type: 'object', properties: {sku: {type: 'string'}}},
        },
      },
    };
    const paths = flattenSchema(schema).map((n) => n.path);
    expect(paths).toContain('items[]');
    expect(paths).toContain('items[].sku');
  });
});

describe('hungarian', () => {
  it('给出最小代价指派', () => {
    // 2x2: 最优为 (0->1, 1->0)
    const cost = [
      [10, 1],
      [1, 10],
    ];
    const p = hungarian(cost);
    expect(p[0]).toBe(1);
    expect(p[1]).toBe(0);
  });
  it('矩形场景：多出来的旧行可以留空（指派到虚拟列）', () => {
    const FORBIDDEN = 600;
    const DUMMY = 555;
    // 1 个新列，2 个旧行，第二个旧行所有真实边都被禁配
    const cost = [
      [10, DUMMY],
      [FORBIDDEN, DUMMY],
    ];
    const p = hungarian(cost);
    expect(p[0]).toBe(0);
    expect(p[1]).toBe(1); // 虚拟列
  });
});
