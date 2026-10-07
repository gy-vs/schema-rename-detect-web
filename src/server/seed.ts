import type {JsonStore} from './store.js';

/**
 * 首次启动且数据为空时播种一份示例：订单 schema v7 -> v8，
 * 正是 customer_name→buyerName、address.zip→shipping.postcode 那次事故。
 * 只在独立启动入口调用，测试里的空 store 不受影响。
 */
export function seedIfEmpty(store: JsonStore): void {
  const data = store.snapshot();
  if (data.families.length > 0) return;

  const now = new Date();
  const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  const v7 = {
    type: 'object',
    title: 'Order',
    properties: {
      orderId: {type: 'string', description: '订单号'},
      customer_name: {type: 'string', examples: ['张伟']},
      nickname: {type: 'string', examples: ['小张']},
      quantity: {type: 'integer'},
      address: {
        type: 'object',
        properties: {
          street: {type: 'string'},
          zip: {type: 'string', examples: ['100086']},
        },
        required: ['street', 'zip'],
      },
    },
    required: ['orderId', 'customer_name'],
  };

  const v8 = {
    type: 'object',
    title: 'Order',
    properties: {
      orderId: {type: 'string', description: '订单号'},
      buyerName: {type: 'string', examples: ['张伟']},
      displayName: {type: 'string', examples: ['小张']},
      quantity: {type: 'integer'},
      shipping: {
        type: 'object',
        properties: {
          street: {type: 'string'},
          postcode: {type: 'string', examples: ['100086']},
        },
        required: ['street', 'postcode'],
      },
    },
    required: ['orderId', 'buyerName'],
  };

  store.mutate((d) => {
    d.families.push({
      id: 'orders',
      name: '订单 schema（v7→v8 事故示例）',
      createdAt: iso(30),
      versions: [
        {
          revision: 1,
          content: JSON.stringify(v7, null, 2),
          createdAt: iso(20),
          createdBy: '作者',
          note: '第 7 版：customer_name / address.zip',
        },
        {
          revision: 2,
          content: JSON.stringify(v8, null, 2),
          createdAt: iso(10),
          createdBy: '作者',
          note: '第 8 版：buyerName / shipping.postcode',
        },
      ],
    });
  });
}
