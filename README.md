# 无限画板 · Infinite Canvas

写给 AI 用的无限画布面板，作为 DeepSeek Harness 的 bundle 插件运行（Host + Web Client 同一个包）。

## 功能

- **无限画布**：便签、文本、形状、画框、图片、画笔、连线，缩放/平移/框选/撤销重做
- **Agent 卡**：任务 / 角色 / 产出方式；三击打开独立大编辑面板；点「开工」在画板上产出
- **项目工作区**：一键新建项目画框 + 负责人 Agent；项目列表跳转；关联本地路径（📂 资源管理器打开）
- **父/子 Agent 派活**：父卡「派活」拆分子项目（每个项目一个画框 + 子 Agent，最多 6 个、最多两层）；父卡「跑子任务」逐个执行并汇总
- **AI 生成**：工具栏「生成」直接让 Agent 在画板上创建/修改内容；模型选择只影响本画板
- **图片 / GIF**：本地程序化生成 SVG 图片或 GIF 动图
- **提示词库 / 皮肤 / 赛博朋克视觉**：本机保存；世界线变动率仪表、扫描线、霓虹选中框
- **缩放联动**：卡片缩放时文字、图标、按钮同步等比缩放

## 目录结构

```
packages/infinite-canvas/
  index.js      # Host 半：文档存储、browser API (/api/canvas.doc)、Agent tools、AI 生成
  client.js     # Web Client 半：画板面板、工具栏、编辑面板、Agent/项目/媒体/设置界面
  model.js      # 纯数据模型：op 应用、item 归一化、frameId 规则、summarize
  store.js      # 持久化：storageDomain → $DSH_HOME/storages/infinite_canvas.json
scripts/
  verify.mjs    # 离线验收（语法、模型、存储、Host 端到端、客户端渲染冒烟）
docs/           # 协议与开发说明
main.py         # 本地小工具
```

## 开发与验证

需要 Node.js。

```bash
# 语法 + 模型 + Host + 客户端渲染 全量离线验收
node scripts/verify.mjs
# 更新客户端构建号（写入 client.js 的 CLIENT_BUILD）
node scripts/bump-build.mjs
```

## 安装（DeepSeek Harness 插件）

本项目是「本地 link 插件」：把 `packages/infinite-canvas` 链接到 profile 的 `node_modules/@local/infinite-canvas`，
在 profile 配置中启用后，侧边栏出现「无限画板」入口。

- Host 代码改动：需要重新加载/重载插件（或重启 Host）；
- Client 代码改动：需要完全退出并重开 DeepSeek Harness（重新快照客户端产物）；
- 画板数据保存在 `$DSH_HOME/storages/infinite_canvas.json`，重启不丢。

## License

MIT © 2026 zerotsl — 见 [LICENSE](./LICENSE)。

## 说明

这是个人实验项目，接口/行为仍可能调整。
