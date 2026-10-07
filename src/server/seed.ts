/**
 * 首次启动时种入复盘用的订单 schema：v7 -> v8（出事的那次改名/挪位）-> v9。
 * 只在库里一个 schema 都没有时执行，绝不覆盖已有数据。
 */
import {Store} from './store';

const ORDER_V7 = JSON.stringify(
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Order',
    type: 'object',
    required: ['orderId', 'customer_name', 'address'],
    properties: {
      orderId: {type: 'string', description: '订单号', examples: ['ORD-100231']},
      customer_name: {
        type: 'string',
        minLength: 1,
        examples: ['张伟', 'Ana Gómez'],
      },
      status: {
        type: 'string',
        enum: ['pending', 'paid', 'shipped', 'done'],
      },
      total_amount: {type: 'number', examples: [128.5]},
      address: {
        type: 'object',
        required: ['street', 'city', 'zip'],
        properties: {
          street: {type: 'string'},
          city: {type: 'string'},
          zip: {type: 'string', examples: ['100080']},
        },
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['sku', 'qty'],
          properties: {
            sku: {type: 'string', examples: ['SKU-8842']},
            qty: {type: 'integer', minimum: 1},
          },
        },
      },
    },
  },
  null,
  2,
);

const ORDER_V8 = JSON.stringify(
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Order',
    type: 'object',
    required: ['orderId', 'buyerName', 'shipping'],
    properties: {
      orderId: {type: 'string', description: '订单号', examples: ['ORD-100231']},
      buyerName: {type: 'string', minLength: 1, examples: ['张伟', 'Ana Gómez']},
      status: {type: 'string', enum: ['pending', 'paid', 'shipped', 'done']},
      total_amount: {type: 'number', examples: [128.5]},
      shipping: {
        type: 'object',
        required: ['street', 'city', 'postcode'],
        properties: {
          street: {type: 'string'},
          city: {type: 'string'},
          postcode: {type: 'string', examples: ['100080']},
        },
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['sku', 'qty'],
          properties: {
            sku: {type: 'string', examples: ['SKU-8842']},
            qty: {type: 'integer', minimum: 1},
          },
        },
      },
    },
  },
  null,
  2,
);

// v9：buyerName 没动（7->9 应沿用确认）；postcode 加了 pattern、从 shipping 挪到 shipping.address
// （动过 -> 回到待确认）；total_amount 从 number 收窄成 integer 也动了。
const ORDER_V9 = JSON.stringify(
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Order',
    type: 'object',
    required: ['orderId', 'buyerName', 'shipping'],
    properties: {
      orderId: {type: 'string', description: '订单号', examples: ['ORD-100231']},
      buyerName: {type: 'string', minLength: 1, examples: ['张伟', 'Ana Gómez']},
      status: {type: 'string', enum: ['pending', 'paid', 'shipped', 'done']},
      total_amount: {type: 'integer', examples: [129]},
      shipping: {
        type: 'object',
        required: ['street', 'city', 'address'],
        properties: {
          street: {type: 'string'},
          city: {type: 'string'},
          address: {
            type: 'object',
            required: ['postcode'],
            properties: {
              postcode: {type: 'string', pattern: '^[0-9]{6}$', examples: ['100080']},
            },
          },
        },
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['sku', 'qty'],
          properties: {
            sku: {type: 'string', examples: ['SKU-8842']},
            qty: {type: 'integer', minimum: 1},
          },
        },
      },
    },
  },
  null,
  2,
);

export function seedIfEmpty(store: Store): void {
  if (store.listSchemas().length > 0) return;
  const schema = store.createSchema('订单 Order（复盘数据：v7→v8→v9）', ORDER_V7, () => new Date('2026-09-02T09:00:00Z'));
  store.addVersion(schema.id, ORDER_V8, 1, () => new Date('2026-09-04T09:00:00Z'));
  store.addVersion(schema.id, ORDER_V9, 2, () => new Date('2026-09-12T09:00:00Z'));

  // 7->8 的审阅结论：两个改名/挪位都确认
  store.saveReview(
    schema.id,
    1,
    2,
    [
      {oldPath: '$.customer_name', newPath: '$.buyerName', decision: 'confirmed'},
      {oldPath: '$.address.zip', newPath: '$.shipping.postcode', decision: 'confirmed'},
    ],
    0,
    'reviewer-a',
    () => new Date('2026-09-05T02:10:00Z'),
  );
}
