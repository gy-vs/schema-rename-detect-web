# Schema Evolution Studio

发版前审阅 JSON Schema 变更的服务 + 网页。它解决的问题：

- 字段改名 / 挪位置不能被下游当成“删一个再加一个”，否则迁移脚本会把整列数据扔掉；
- 需要一个人工确认环节，并且让“新版本能不能安全替换旧版本”的结论随审阅结论自动更新、可追溯。

没有引入任何现成的 JSON Schema 比对、diff 或字段匹配包——匹配、兼容判定、跨版本沿用都是本仓库自己的代码（`src/engine/`），误判时可以顺着每一个评分维度查下去。

## 用法

```bash
npm install
npm run dev        # tsx watch 起 API(4174) + Vite(4173)
```

- 作者在“Schema 编辑”页编辑 JSON Schema 文本并保存，每次保存生成一个新版本，旧版本随时可从下拉框取回；
- 手里的版本不是最新时保存会被拒绝（409），并告知当前最新版本号；
- 审阅人在“变更审阅”页挑同一 schema 的任意两个版本，逐条确认/拒绝候选并提交。

生产构建：

```bash
npm run build      # 前后端类型检查 + vite build + tsc 产出 dist-server/
npm start          # node dist-server/server/index.js，同时托管 API 和前端静态资源
```

数据默认存在 `.data/ses.json`（原子写），可用 `SES_DATA_FILE` 覆盖。首次启动且数据为空时会播种一份“订单 schema v7→v8”示例。

## 审阅规则

工作台对两个版本做这些事：

1. **打平字段树**：展开 `$ref`（含 `$defs`、`allOf` 浅合并），`category.children → category` 这类循环引用在回边处确定性截断并留痕；数组项路径用 `items[]` 表达；`properties` 书写顺序不影响任何结论。
2. **同路径逐项比对**：类型、`required`、`enum`、`format`、`const`。`integer → number` 兼容，`string → integer` 不兼容；enum 收窄、新增 required 直接报 error。
3. **改名/挪位置候选**：对两侧独有的字段做一对一全局最优指派（匈牙利算法），一个新字段最多归一个旧字段。评分维度全部可解释：
   - 字段名：驼峰/下划线分词、复合词拆分、编辑距离，以及一份内置、可审计的短小别名词表（`name/fullName`、`nickname/displayName`、`zip/postcode`、`customer/buyer`…）；
   - 类型（硬门，不兼容不配对）、`required`、`enum`、`format`、`const`；
   - `examples` 是否同一类东西（没写 examples 时该维度弃权，不惩罚，字段照样能出候选）；
   - 树中深度、兄弟字段集合（`address → shipping` 这种搬迁靠兄弟大面积重合）。
4. **证据**：每个候选展示每个维度的原始分、权重、贡献与文字依据，并列出落选备选及其分差、是否因“一对一”被别的旧字段占走。
5. **审阅结论**：
   - 确认（confirmed）：旧数据按新名字读得出，删除被消除；
   - 拒绝（rejected）：按删除一个 + 新增一个处理，required 新字段报不兼容；
   - 待定（pending）：最终结论为 undetermined。
   审阅状态存在服务端，换人打开同一版本对看得到；提交带乐观锁 revision，两人同时审、后提交者拿着过期状态会收到 409，明确知道别人改过。
6. **跨版本沿用**：确认完 7→8 之后再看 7→9，涉及字段在后续版本里内容没动（类型/enum/format/const 及子树指纹一致）的决定自动沿用并标注“沿用 7→8”；中间动过的配对链断裂，回到待确认。非相邻区间（如 7→9）也可以直接逐条审阅，区间自身的结论优先于继承。
7. **最终判定**：`compatible / undetermined / incompatible`，审阅状态一变结论立刻重算。

## 性能

最大的一份 schema（400+ 字段）两版本之间的候选与兼容结论在 2 秒内返回（常规场景约几百毫秒，极端全量改名 <1 秒）。实现方式：倒排索引做稀疏候选（词干/数字标记/前缀/别名词组），两阶段打分（廉价名称分 top-K 剪枝 + 入选边完整特征），再做 O(n³) 一对一指派，避免稠密 O(n²) 昂贵评分。

## 代码结构

```
src/engine/
  types.ts     前后端共享的数据结构
  parse.ts     JSON 解析、$ref 展开（循环截断）、字段树打平、子树指纹
  names.ts     分词、编辑距离、别名词表
  features.ts  类型/required/enum/format/examples/兄弟/深度/const 各维度打分
  matcher.ts   稀疏候选、两阶段打分、匈牙利一对一指派、容器改名折叠
  changes.ts   同路径逐项变化
  evolution.ts 编排：候选、审阅结论、跨版本沿用、最终兼容判定
src/server/    Express API + JSON 文件存储
src/client/    React + Vite 页面（编辑栏 / 审阅工作台）
test/          vitest：引擎单测 + supertest API 测试
```

## 测试

```bash
npm test         # vitest
npm run typecheck
```
