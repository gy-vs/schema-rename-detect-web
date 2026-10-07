import {describe, expect, it} from 'vitest';
import {flattenSchema, loadAndFlatten, parseSchemaText} from '../src/core/flatten';
import {RawSchema} from '../src/core/types';

function flatten(obj: Record<string, unknown>) {
  return flattenSchema(obj);
}

const paths = (fields: {path: string}[]) => fields.map(f => f.path);

describe('flatten 基础', () => {
  it('展开嵌套 properties 并记录 required', () => {
    const fields = flatten({
      type: 'object',
      required: ['a'],
      properties: {
        a: {type: 'string'},
        b: {type: 'object', properties: {c: {type: 'integer'}}},
      },
    });
    expect(paths(fields)).toEqual(['$', '$.a', '$.b', '$.b.c']);
    expect(fields.find(f => f.path === '$.a')?.required).toBe(true);
    expect(fields.find(f => f.path === '$.b.c')?.required).toBe(false);
  });

  it('数组项落在 [] 节点下', () => {
    const fields = flatten({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {type: 'object', properties: {sku: {type: 'string'}}},
        },
      },
    });
    expect(paths(fields)).toContain('$.items[].sku');
  });

  it('properties 书写顺序不影响输出顺序', () => {
    const a = flatten({
      type: 'object',
      properties: {z: {type: 'string'}, a: {type: 'string'}, m: {type: 'string'}},
    });
    const b = flatten({
      type: 'object',
      properties: {m: {type: 'string'}, z: {type: 'string'}, a: {type: 'string'}},
    });
    expect(paths(a)).toEqual(paths(b));
    expect(paths(a)).toEqual(['$', '$.a', '$.m', '$.z']);
  });

  it('记录 enum / format / examples', () => {
    const fields = flatten({
      type: 'object',
      properties: {
        status: {type: 'string', enum: ['a', 'b'], examples: ['a']},
        when: {type: 'string', format: 'date-time'},
      },
    });
    const status = fields.find(f => f.path === '$.status')!;
    expect(status.enumValues).toEqual(['"a"', '"b"']);
    expect(status.exampleClasses[0].pattern).toBe('text');
    expect(fields.find(f => f.path === '$.when')?.format).toBe('date-time');
  });

  it('兄弟字段集合', () => {
    const fields = flatten({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {street: {type: 'string'}, zip: {type: 'string'}, city: {type: 'string'}},
        },
      },
    });
    expect(fields.find(f => f.path === '$.address.zip')?.siblingNames).toEqual(['city', 'street']);
  });
});

describe('$ref 与循环', () => {
  const cyclic: RawSchema = {
    $defs: {
      category: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: {type: 'integer'},
          name: {type: 'string'},
          children: {type: 'array', items: {$ref: '#/$defs/category'}},
        },
      },
    },
    type: 'object',
    properties: {
      category: {$ref: '#/$defs/category'},
    },
  };

  it('category.children 指回 category 时终止下钻且字段集合确定', () => {
    const fields1 = flatten(cyclic);
    const fields2 = flatten(cyclic);
    expect(paths(fields1)).toEqual(paths(fields2)); // 确定性
    expect(paths(fields1)).toEqual([
      '$',
      '$.category',
      '$.category.children',
      '$.category.children[]',
      '$.category.id',
      '$.category.name',
    ]);
    const terminal = fields1.find(f => f.path === '$.category.children[]')!;
    expect(terminal.cycleRef).toBe('#/$defs/category');
  });

  it('兄弟配对时循环终态节点仍参与匹配', () => {
    const oldFields = flatten(cyclic);
    const newFields = flatten({
      $defs: {
        category: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: {type: 'integer'},
            name: {type: 'string'},
            kids: {type: 'array', items: {$ref: '#/$defs/category'}},
          },
        },
      },
      type: 'object',
      properties: {category: {$ref: '#/$defs/category'}},
    });
    // 循环终态依然有确定路径和类型，不会因为递归而爆掉
    expect(oldFields.find(f => f.path === '$.category.children[]')?.types).toEqual(['object']);
    expect(newFields.find(f => f.path === '$.category.kids[]')?.cycleRef).toBe('#/$defs/category');
  });

  it('外部 $ref 标记为 externalRef，不猜结构', () => {
    const fields = flatten({
      type: 'object',
      properties: {remote: {$ref: 'https://example.com/schema.json#/x'}},
    });
    expect(fields.find(f => f.path === '$.remote')?.externalRef).toBe('https://example.com/schema.json#/x');
  });

  it('断掉的 $ref 标记 brokenRef', () => {
    const fields = flatten({
      type: 'object',
      properties: {ghost: {$ref: '#/$defs/missing'}},
    });
    expect(fields.find(f => f.path === '$.ghost')?.brokenRef).toBe('#/$defs/missing');
  });

  it('allOf 内联、oneOf 合并', () => {
    const fields = flatten({
      type: 'object',
      properties: {
        mixed: {
          allOf: [{type: 'object', required: ['x'], properties: {x: {type: 'string'}}}],
          oneOf: [{type: 'object', properties: {y: {type: 'integer'}}}],
        },
      },
    });
    expect(paths(fields)).toContain('$.mixed.x');
    expect(paths(fields)).toContain('$.mixed.y');
    expect(fields.find(f => f.path === '$.mixed.x')?.required).toBe(true);
  });
});

describe('解析错误', () => {
  it('坏 JSON 报错', () => {
    expect(() => loadAndFlatten('{bad')).toThrow(/JSON/);
  });
  it('根不是对象报错', () => {
    expect(() => parseSchemaText('[]')).toThrow(/对象/);
  });
});
