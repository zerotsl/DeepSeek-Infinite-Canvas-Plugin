# DeepSeek 无限画板 — 实现协议（v1.2，与已安装实现一致）

插件包：`@local/infinite-canvas`（Host + Web Client 同包，无构建步骤）
源码目录：`E:\T\T...\packages\infinite-canvas`
当前客户端构建号：`2026-10-21.55`（显示在画板工具栏右侧，并在面板加载时 toast 一次）
Host 构建号：`2026-10-22.9`（`state` 响应里的 `hostBuild` 字段；客户端用它检测 Host 是否为旧版并提示重启）
投递诊断：`$DSH_HOME/canvas/ai-generate.log`（记录模型路由、prompt 原文、耗时、返回字符数、计划解析结果、落库统计与错误）

目标：一个「适合 AI」的无限画布主面板。人用鼠标/触控板画，AI 用工具读写同一份场景文档，
两边都通过 Host 侧的 **唯一文档 + 操作日志** 实时同步。

---

## 1. 文档模型（Host 为唯一真源）

```js
// CanvasDoc
{
  schema: 1,
  id: 'default',
  title: '未命名画板',
  rev: 42,                    // Host 单调递增；任何内容变更都会 +1
  updatedAt: '2026-10-21T12:00:00.000Z',
  viewport: { cx: 0, cy: 0, zoom: 1, vw: 1200, vh: 800 },
  focus: null,                // { cx, cy, zoom, at }；AI 请求聚焦时写入，Client 消费一次
  items: {                    // id -> CanvasItem（扁平 map，便于按 id 增量同步）
    'n_ab12': {
      id: 'n_ab12',
      type: 'note',           // note | text | shape | frame | image | edge | stroke
      x: 0, y: 0, w: 240, h: 168,   // 世界坐标（左上角 + 宽高）；edge 为 0；stroke 为笔画包框
      z: 1,                   // 叠放层级，越大越靠上
      text: '你好',
      color: 'yellow',        // yellow|blue|green|pink|purple|orange|gray|white
      shape: 'rect',          // 仅 type=shape：rect|ellipse|diamond
      src: 'https://…',       // 仅 type=image：https:// 或 data:image/（内联图 ≤200KB）
      from: 'n_a', to: 'n_b', label: '',   // 仅 type=edge
      points: [[0,0],[12,8]], width: 3,    // 仅 type=stroke：相对坐标点集（≤3000 点）+ 线宽 1–40
      frameId: null,          // 可选：所属 frame 的 id
      by: 'ai',               // 最后写入者：user | ai
      createdAt: '…', updatedAt: '…',
      meta: {}                // AI 可放任意 JSON（UI 不渲染，canvas_read include:'full' 可见）
    }
  }
}
```

- 视口以 **世界坐标中心 `cx/cy` + `zoom` + 屏幕尺寸 `vw/vh`** 表示；可见世界矩形 = `cx ± vw/2/zoom`。
- `zoom` 夹在 0.1–4；坐标/尺寸取整；单文档最多 2000 节点；文本 ≤20000 字符。

## 2. 操作（ops）——Client 与 AI 工具共用同一套

```js
{ op: 'upsert',   item }              // 新建或整体覆盖（Host 归一化补全字段）
{ op: 'patch',    id, patch }         // 局部更新（浅合并；保留原 by 的归属由调用方决定）
{ op: 'delete',   id }                // 删除；指向它的 edge 会级联删除
{ op: 'clear' }                       // 清空全部
{ op: 'title',    title }             // 改标题（自动 trim）
{ op: 'focus',    cx, cy, zoom }      // 请求把视口移到某世界点（AI 用）
{ op: 'viewport', viewport }          // 仅由 Host 内部使用；不写入操作日志、不 +rev
```

Host `applyOpsNow(ops, by)`：逐条归一化 → 应用 → `rev += 1`（一批一次）→ 追加内存操作日志
`{ rev, ops, by, at }`（最多 400 批）→ debounce 220ms 持久化 → 轮询方通过增量拿到。
失败的 op 不改变 rev，错误以可读文本返回（Agent 工具/浏览器 API 都能看到）。

## 3. Host ↔ Client 传输

Host 用 `ctx.connection.fetch.register` 在 `/api/canvas.doc` 注册**精确 Fetch 路由**
（`requestBody: 'buffered'`，仅 POST），Connection 负责 Host/Origin 校验与浏览器 cookie 认证。
浏览器用**文档相对** `fetch('api/canvas.doc', …)`（自动带 cookie，无 token/CORS）。

请求：`{ "action": "state" | "apply" | "viewport", "payload": {…} }`
响应：`{ "ok": true, "value": … }` 或 `{ "ok": false, "error": { code, message } }`

| action | payload | value |
|---|---|---|
| `state` | `{ since?: number }` | `{ rev, title, viewport, focus, updatedAt, full:boolean, items?, ops? }`：`since` 命中日志时回增量 ops，否则全量 items；`since > rev` 时强制全量 |
| `apply` | `{ ops, by?: 'user' }` | `{ revision, applied, changed, errors, title }`（`applied` 为 Host 归一化后的 op，客户端用它校正本地状态） |
| `viewport` | `{ viewport }` | `{ ok: true }`（只更新视口并持久化，不 +rev、不写日志） |
| `generate` | `{ prompt, scope?, mode?, selection?, anchor?, anchorId?, sessionId? }` | 直接生成：Host 用 `ctx.llm.stream` 调当前默认模型产出 JSON 计划。`mode:'auto'`（默认）直接写入画布，返回 `{ mode:'direct', revision, created, updated, deleted, total, warnings }`；`mode:'ask'` 返回方案预览 `{ mode:'plan', planId, created, updated, deleted, nodeTexts, updateTexts, warnings }`，尚未写入。`anchor` 让生成内容围绕某世界坐标排布，`anchorId` 会让新节点自动连回该卡片（Agent 卡片用）。没有 LLM 路由时退回会话方式 `{ mode:'session', sessionId, sessionTitle }` |
| `generate-apply` | `{ planId }` | 确认并写入 `ask` 模式返回的方案（一次性，5 分钟过期），返回与 `mode:'direct'` 相同的结构 |

Client 行为：面板挂载时轮询 `state`（700ms，`since=lastRev`，无变化不重渲染）；
本地编辑先乐观应用并 `apply`，失败入队待下次成功轮询后重放；AI 增量（`item.by === 'ai'`）闪烁高亮。

## 4. AI 工具面（Host `ctx.tools.register`，原始 JSON Schema）

| 工具 | 参数 | 语义 |
|---|---|---|
| `canvas_read` | `{ include?, limit?, cursor? }` | 读画板；`full` 返回完整文本/meta；返回 JSON（>24KB 截断并提示翻页） |
| `canvas_create` | `{ items: [...] }` | 批量创建（未给 x/y 自动排布）；拒绝 `id`；image 必须带合法 src；返回新 id |
| `canvas_update` | `{ items: [{id, …patch}] }` | 按 id 局部更新；未知 id 记入 errors |
| `canvas_delete` | `{ ids?: [], all?: boolean }` | 批量删除或清空 |
| `canvas_connect` | `{ edges: [{from,to,label?}] }` | 连线，端点必须存在 |
| `canvas_focus` | `{ ids?, rect?, zoom? }` | 把用户视口带到目标区域 |

系统提示词：`ctx.systemPrompt.section({ name:'canvas:infinite-canvas', order:3200, interpolate:false })`，
每次组装时附带实时 title/rev/节点数/视口中心。

## 5. Client UI（`main` slot key `infinite-canvas` + `sidebar.panellist` id 同值）

- 顶部工具栏：标题、工具（选择/抓手/便签/文本/形状/画框/连线/画笔，图标 + 名称 + 快捷键）、
  撤销/重做、缩放、适应内容、添加文字、**Agent**、插入图片、**独立删除按钮**（选中后可用）、
  **功能介绍（?）**、同步状态 + 构建号。
- **提示词库**（工具栏「提示词」按钮）：独立于角色设定的可复用提示词管理。
  - 新建 / 编辑 / 删除 / 搜索，名称 ≤60 字、内容 ≤20000 字、最多 50 条；
  - 持久化在浏览器 `localStorage`（key `dsic.prompts.v1`），不写入画板文档，重启客户端仍在；
  - 内置 4 条示例提示词（用户访谈提纲 / 竞品分析 / 会议记录整理 / 改写润色），可一键插入；
  - 三种使用方式：`插入到 Agent 输入框`、`插入到角色设定`、`放到画板上`（生成文本节点）。
- **图片 / GIF 动图生成**（工具栏「图片」按钮）：本地程序化生成，不依赖外部模型或 ffmpeg。
  - 图片：SVG 矢量输出（海报 / 封面 / 横幅 / 卡片 / 抽象 5 种风格，16:9 / 1:1 / 竖版），
    尺寸上限 2048×2048，插入为图片节点（`src` 为 `data:image/svg+xml`）。
  - 动图：canvas 2D 逐帧绘制 → 内置 GIF89a 编码器（216 色 LZW）→ `data:image/gif`，
    360×203、10 帧、约 1 秒循环，内联上限 1.2MB；画板 `<img>` 中自动循环播放。
  - 弹窗内固定展示「能力上限与用法」：不做照片级/AI 写实、不支持 MP4（无 ffmpeg）、用法步骤。
- **Agent 任务卡片**（工具栏「Agent」工具，快捷键 `G`）：画布上的卡片节点，含名称、
  状态徽章（待命中/开工中/搞定了/翻车了）、任务文本与 ▶ 运行按钮；双击写任务，运行后生成内容
  围绕卡片排布并自动连线回卡片。
  - **固定几何**：卡片永远按数据里的 `w/h`（默认 360×280）渲染，不做自动测量/回写；
    因此选择框、`+` 气泡、连线锚点与卡片本体使用同一份尺寸，高度不会漂移。
    （历史上短暂出现过的「自动高度」测量功能已整体移除，旧开关不再生效。）
  - `+` 气泡是卡片元素的**子节点**（`.dsic-node-plus`，按 `1/zoom` 补偿尺寸与间距），
    位置由卡片自身边缘（`100%` / `0`）决定，与卡片天然绑定。
  - **大编辑面板**：Agent 卡双击 / Enter / 工具条「编辑文字」会打开**独立的大编辑弹窗**
    （`.dsic-bigeditor`，居中模态，Markdown 提示、字数统计、Esc 取消、Ctrl/⌘+Enter 保存），
    不再使用画布坐标的浮层编辑器，因此打开编辑时卡片和连线都不会跳位；
    便签 / 文本 / 形状仍保留原来的内联浮动编辑器。
  - **角色设定**（卡片上的 🎭 徽章 / 「设定角色」）：可粘贴完整人设模板（角色/任务/已知信息/
    工作步骤/约束/输出格式/自检），支持「插入示例角色」；`role` ≤12000 字。
  - **产出方式**：`画布结构化`（模型产出便签/连线计划）或 `文本文档`（模型输出 Markdown，
    Host 自动排成「画框 + 分页文本卡片」，长文按 3000 字分页，最多 12 页）。
  - 运行请求携带 `persona`（角色文本）与 `output`：结构化模式下角色设定追加进系统提示词；
    文档模式下作为文档生成的最高优先级人设。
- **Agent 生成弹窗**（工具栏「Agent」按钮与底部工具条 ✨）：输入需求，可切换**生成范围**与**模式**：
  - 生成范围：`整个画板` / `选中模块`（未选中时禁用）；
  - 模式：`询问`（先返回方案预览，确认后才写入画板）/ `自动`（直接写入）；
  请求由 Host **直接调用模型生成并写入画布**（不再经过对话会话，也不会出现在别的聊天窗口）：
  - 计划格式：`{title?, delete?, updates?, nodes:[{ref,type,text,x,y,w,h,color,shape,src}], edges:[{from,to,label}], focus?}`；
  - Host 解析 JSON、映射 `ref → 新节点 id`、把节点/连线/更新/删除作为一批 op 应用，并可选 `focus` 到新内容；
  - `选中模块` 范围下：Host 丢弃任何针对选中范围外节点的 `updates`，并忽略计划里的 `title`；
    当用户请求像「回答/解释/为什么/怎么做/翻译/改写/续写」或选中节点文本含问号时，走**回答模式**：
    只允许 `updates`，答案追加到该节点文本（保留原文 + 换行「答：…」），不允许新建节点、不允许套用无关的通用流程模板；
    其它情况下才允许在选中节点右侧/下方新增节点与连线。
  - 没有 LLM 路由（或调用失败）时才退回会话方式作为兜底。
- 文字编辑：单击空白便签直接进入；双击便签/文本框/形状进入；选中后 Enter/F2 或底部铅笔按钮；
  编辑为**屏幕空间浮层 textarea**（不受缩放/裁剪影响，IME 正常），
  失焦或 Ctrl/⌘+Enter 保存，Esc 取消，被卸载时草稿兜底保存。
- 画布：**赛博朋克星空**——黑底 + 三层白点星（大亮星 / 中等星 / 小暗星，随平移缩放移动，
  最亮一层呼吸闪烁）+ 极淡青色霓虹网格 + 星云径向渐变 + CRT 扫描线 + 缓慢下移的扫光带 +
  四角 HUD 括号（青/品红）+ 四周暗角；连线为霓虹渐变 + 发光箭头 + 选中流动虚线。
  无限平移/缩放、框选、Shift 加选、拖拽移动、八向缩放把手、Del 删除、Ctrl+D 复制、
  Ctrl+Z/Shift+Z 撤销重做、Ctrl+0 适应内容。
- **连线样式（纯色 + 扫描感）**：每条连线按 id 固定一个**纯色**（青/粉/紫/琥珀/青绿/蓝），
  描边无渐变、无发光光晕，箭头同色；线上叠一层**细密亮色扫描虚纹**（2px 亮 / 7px 空，
  `dsic-edge-scan`）形成数据线/CRT 扫描质感；选中或悬停时再叠加**流动虚线**（`dsic-edge-flow`，
  仅 1 条路径动画）。
- **稳定性约束（避免闪烁/掉帧）**：世界层**不做** `will-change` 升降级（避免提升/取消提升时的重栅格闪烁；
  静止时文字始终按当前缩放重新绘制）；连线图层**不加整层 `drop-shadow` 滤镜**（发光只由每条线下的两层半透明路径实现，
  拖动/缩放时不触发整层滤镜重算）；扫描线为静态贴图，**无扫光带动画**、**无星星闪烁循环动画**；
  仅选中连线保留流动虚线动画（单个路径，开销很小）。
- **画框（frame）与成组移动**：
  - 拖动画框时，框内全部内容（含嵌套子画框的内容，按 `frameId` 递归）一起移动；
  - 新建画框会自动收编框内已有节点；把节点拖进画框自动归属（`frameId`），拖出去自动解除；
  - 删除画框不会删除内容，只把子节点 `frameId` 置空；多选拖拽同样整组移动。
- 线条（无限条）：
  - **画笔**（`P`）：按住拖动随手画任意多条自由线；提交为 `stroke` 节点，可选中后改色、删除、拖动、缩放。
  - **连线**（`C`）：点起点后可连续点击多个目标，从同一节点分叉出无限条带箭头连线；工具不自动退出，
    点空白处或 `Esc` 结束。
  - 选中节点/连线后出现圆形「+」：**节点四边各一个**（上 / 下 / 左 / 右）——节点上的「+」渲染在
    **节点元素内部**（`.dsic-node-plus`，尺寸按 `1/zoom` 补偿），因此与卡片物理绑定、不可能再错位；
    连线/画笔的「+」仍用屏幕层（`.dsic-plus`）。按下即可拖动：拖到目标节点上松手 = 直接连线；
    拖到空白处松手 = 在该处生成相连便签；原地点击 = 在对应方向生成相连便签。
  - 连线工具支持**按下拖拽直达目标**（松手成线），也保留「点起点 → 连续点目标」的连续画线方式。
- 颜色全部走 `--dsw-alias-*` 主题 token；便签/形状本体色使用自带可读调色板。
- 空画板时展示引导卡 + 「插入示例画板」+ 三个 AI 指令 chip（点击会打开「Agent」并预填提示词），
  并额外说明文字编辑方式。

## 6. 持久化

优先 `ctx.storageDomain.open({ name:'infinite_canvas', version:1, layout:'single', tables:{ scenes:{ valueSchema } } })`
→ `$DSH_HOME/storages/infinite_canvas.json`（原子写、串行提交、重启不丢）。
仅当服务缺失时才回退到 `$DSH_HOME/canvas/scene.json`；domain 打开失败不静默换介质，而是日志告警并内存运行。

## 7. 开发与重载注意（重要）

本包是 profile 的 **link 目录**（`E:\T\T...\packages\infinite-canvas`）。当前部署的 HMR 只监听 profile
目录（`root: []`），**不会重新快照链接目录里的 `client.js`**，禁用/启用插件也不会改变客户端产物版本。
因此：

1. 修改 **Host** 代码（`index.js`/`model.js`/`store.js`）后，需要让 Host 重新加载插件（重载/重启生效）；
2. 修改 **Client** 代码（`client.js`）后，必须**完全退出并重开 DeepSeek Harness**（Host 重启时重新快照
   客户端产物），然后刷新页面；工具栏右侧的构建号可用于确认新代码是否生效；
3. 日常调试可用 `node scripts/verify.mjs`（14 项离线验收：语法、模型、存储、Host 工具端到端、客户端模块
   契约、面板渲染冒烟）。
