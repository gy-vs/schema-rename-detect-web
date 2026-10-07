# Schema Evolution Studio

发版前审阅 JSON Schema 变更的内部工作台：保存 schema 版本、找出两个版本之间
**改名或挪了位置的字段**、逐条人工确认，最后给出“新版本能不能安全替换旧版本”的结论。

复盘背景：订单 schema v7→v8 把 `customer_name` 改成 `buyerName`、`address.zip` 挪进
`shipping.postcode`，下游当成“删两个字段 + 加两个字段”，迁移脚本把客户名和邮编整列
丢掉。这个工具就是为了在发版前拦住这类问题。

## 它做什么

- **版本管理**：作者编辑 JSON Schema 文本保存，每次保存都是一个新版本，旧版本随时可取。
  手里版本过期时保存被 409 拒绝，并返回最新版，不会覆盖别人的改动。
- **改名/挪位候选**：审阅人选任意两个版本，工作台用名称分词/词尾/编辑距离、类型兼容、
  required、enum、format、树中位置、兄弟字段、examples 样例分类等可追溯特征打分，
  再做全局**一对一**最优分配（一个新字段最多归一个旧字段）。
  - `integer → number` 算兼容，`number → integer` 算收窄，`string → integer` 不兼容。
  - 没有 examples 的字段拿中性分，仍然可以出候选。
  - 每条候选展开能看到每个特征的原始分、贡献分和人类可读依据；备选新字段、
    竞争者以及分数接近时的反事实解释（让给备选后全局总分损失多少）都列得出来。
- **逐条审阅 + 乐观锁**：确认/拒绝结果存在服务端（JSON 文件），换人打开也看得到；
  两个人同时审同一对版本，后提交的人若 rev 过期会收到 409，并看到是谁先改的。
- **结论随审阅联动**：确认为改名的字段，旧数据按新名字读得出来，不算删除；
  被拒绝的按“删除 + 新增”处理，该报不兼容就报。审阅状态一变，结论立即重算。
- **跨版本沿用**：审完 v7→v8 后又出 v9，再看 v7→v9 时，字段在 v9 没动过的决定直接
  沿用（`carried/active`）；又被改过或承接链断了的回到待确认（`carried/reset`），
  并给出失效原因。
- **$ref / 循环**：本地 `$ref`、`allOf/oneOf/anyOf` 都解析；`category.children` 指回
  `category` 这类循环在祖先链上第二次遇到 ref 时停成确定的终态节点，不会无限递归；
  外部 ref 标记 `externalRef`，断链标记 `brokenRef`。properties 书写顺序不影响结论。
- **性能**：450+ 字段的两版本，候选与兼容结论秒级返回（实测单请求约 0.8–1.5s）。
  大 schema 用带 IDF 的倒排索引预筛候选，只对少量配对做完整打分。
- **没有引入任何 JSON Schema diff / 比对 / 字段匹配第三方包**：匹配核心全部在
  `src/core/`，误判时可以从每条特征顺着查到具体算法。

## 目录结构

```
src/core/        纯 TS 领域核心（服务端、前端、测试共用）
  flatten.ts     JSON Schema 打平（$ref/循环/allOf/oneOf，顺序无关）
  text.ts        名称分词、词集合、编辑距离、公共子串/词尾
  values.ts      examples 样例分类与“是不是一类东西”
  types-compat.ts 类型兼容（integer→number 放宽等）
  match.ts       特征打分、候选预筛、匈牙利一对一分配、备选/反事实解释
  lineage.ts     审阅决定跨版本沿用 / 失效
  compat.ts      最终兼容性结论
src/server/      Express API + JSON 文件持久化（原子写）+ 分析缓存
src/client/      React + Vite 三栏工作台
test/            vitest 单测与 API 集成测试
```

## 开发

```bash
npm install
npm run dev        # tsx watch 跑 API(4174)，vite 跑页面(4173) 并代理 /api
npm test           # vitest
npm run typecheck  # 前后端 tsc --noEmit
npm run build      # typecheck + vite 构建客户端 + esbuild 打包服务端
npm start          # 运行生产包（dist/server/index.cjs，同时托管 dist/client）
```

数据默认写在 `./data/studio-db.json`，可用环境变量 `STUDIO_DB` 改路径。
首次启动且库为空时会种入订单 schema 的 v7→v8→v9 复盘数据（v7→v8 两条改名已确认）。

## API 摘要

| 方法 & 路径 | 作用 |
| --- | --- |
| `GET /api/schemas` / `POST /api/schemas` | 列表 / 新建 |
| `GET /api/schemas/:id` | 元数据 + 全部版本 |
| `GET /api/schemas/:id/versions/:v` | 单个版本内容 |
| `POST /api/schemas/:id/versions` | 存新版本（body 带 `expectedLatest`，过期返回 409 + 最新版） |
| `GET /api/schemas/:id/analysis/:from/:to` | 候选 + 同路径变化 + 沿用决定 + 兼容性结论 |
| `GET/PUT /api/schemas/:id/reviews/:from/:to` | 取 / 存审阅状态（PUT 带 `rev`，过期返回 409 + 当前状态） |
