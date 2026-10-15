# Gloss

Obsidian 页边批注插件。当前功能和数据恢复说明见 [使用说明](使用说明.md)。

## 开发

```sh
npm ci
npm test
npm run type
npm run build
```

普通构建只在项目目录生成 `main.js`，不会部署到笔记库。

需要在 Obsidian 中测试时，将 `gloss.local.example.json` 复制为 `gloss.local.json`，把 `vaultPath` 改为测试库的绝对路径；也可以设置环境变量 `GLOSS_VAULT_PATH`。本地配置不提交到 Git。

```sh
npm run deploy  # 类型检查、生产构建并复制到指定测试库
npm run dev     # 监听源码改动并持续构建、部署
```

部署仅复制 `main.js`、`styles.css` 和 `manifest.json` 到指定库的 `.obsidian/plugins/gloss/`；配置路径必须已包含 `.obsidian` 目录。部署不会修改插件设置、`.gloss/` 批注或附件。

## 源码迁移

2026-10-15，源码及 Git 仓库从测试库中的 `gloss/` 迁到本项目目录，保留已有提交历史。测试库内原有 Markdown 笔记继续保留，以维持已有链接和批注路径；后续开发请编辑本项目中的源码与文档。
