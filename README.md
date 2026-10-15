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

## GitHub 自动发布

`.github/workflows/auto-release.yml` 与 Paper Vault 插件采用相同的发布方式：推送到 `main` 或 `master` 且 `manifest.json` 有变化时，读取其中的版本号；已发布则跳过，新版本通过测试和生产构建后自动创建 Release。也可以在 GitHub Actions 页面手动运行此 workflow（选择 `main` 或 `master`），用于首次发布或失败后重试。

在干净的工作区升级版本并推送：

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json manifest.json versions.json
git commit -m "Release 0.1.1"
git push origin main
```

`patch` 可替换为 `minor`、`major` 或明确的版本号；提交信息中的版本号应与实际版本一致。版本脚本会同步 `manifest.json` 和 `versions.json`，npm 同步 `package.json` 与锁文件。使用稳定的 `X.Y.Z` 版本；Release 标签由 workflow 创建，不带 `v` 前缀。

CI 使用 Node.js 24，执行 `npm ci`、`npm test`、`npm run build`，上传 `main.js`、`manifest.json`、`styles.css`、`versions.json` 四个文件。发布绑定触发 workflow 的提交，不会部署到本地 Obsidian 库。

首次使用需要将本仓库连接并推送到 GitHub，且仓库允许 GitHub Actions 运行。workflow 使用 GitHub 自动提供的 `GITHUB_TOKEN`，已声明 `contents: write` 权限，无需额外配置个人 token。配置文件本身不会提高插件版本。

参考：[GitHub Release 命令](https://cli.github.com/manual/gh_release_create)、[npm version 生命周期](https://docs.npmjs.com/cli/v11/commands/npm-version/)。
