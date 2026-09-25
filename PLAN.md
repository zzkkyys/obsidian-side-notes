> 历史设计存档：当前实现已删除闪卡、复习视图与录音功能；以下相关规划不再执行。图片与文件附件继续支持。

# Gloss 开发计划（PLAN）

> 目标：完整复刻「Gloss — Word 风格页边批注」插件。本文档是技术实现蓝图：架构、数据模型、关键算法、模块拆分、里程碑与验收标准。

## 1. 目标与非目标

**目标（MVP 必须交付）**
1. Markdown 笔记：选区 → 新建批注卡片 → 正文高亮 + 页边卡片（宽屏）/ 气泡（窄屏）一一对应。
2. 批注卡片：文字内容、6 内置 + 自定义类型（名称/颜色/Emoji/拖拽排序）、回复（时间戳）、语音录音、任意附件（图片/视频/音频内联预览）、⚡闪卡开关、删除。
3. 两种高亮风格：下划线（虚线+浅底）/ 粗糙边缘（SVG 滤镜毛边）。
4. 数据本地化：`.gloss/` 目录 JSON，零运行时第三方依赖，`isDesktopOnly: false`。

**M2/M3 目标**：PDF 场景；闪卡复习视图 + Markdown 导出（`{{card}}`）。

**非目标（本期不做）**：源码模式高亮渲染（仅保留命令建批注）、内置同步/协作服务器、Anki `.apkg` 二进制导出、批注全文搜索引擎。

## 2. 技术选型

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 运行框架 | Obsidian Plugin API（`obsidian` npm 包） | 平台约束 |
| 打包 | esbuild（bundle → 单文件 `main.js`） | 官方推荐，移动端兼容 |
| 语言 | TypeScript 5 | 类型安全，锚点/布局算法复杂度高 |
| 运行时依赖 | **零** | 录音=MediaRecorder、拖拽=HTML5 DnD、毛边=内联 SVG filter、Markdown 渲染=Obsidian 自带 `MarkdownRenderer`。零依赖 = 移动端 WebView 无包体/许可风险 |
| 存储 | 库内 JSON 文件（`.gloss/`） | 不污染源文件；纯文本可进 git；卸载无残留 |
| 高亮毛边 | 内联 `<svg><filter id="gloss-rough">feTurbulence+feDisplacementMap`，只作用于高亮背景层 `::before` | 文字保持锐利；无 rough.js 依赖 |
| 页边连线 | 单个全屏 `<svg>` 覆盖层（文档坐标系），贝塞尔曲线 | 一条覆盖层画所有连线，重排 O(n) |

## 3. 目录结构

```
gloss/
├── manifest.json            # id: gloss
├── versions.json
├── package.json             # 仅 devDependencies: obsidian/typescript/esbuild/@types/node
├── tsconfig.json
├── esbuild.config.mjs       # build + dev(watch)；dev 自动同步产物到 vault .obsidian/plugins/gloss/
├── styles.css               # 全部样式：页边栏/卡片/高亮(两风格)/气泡/类型管理/复习视图
├── 插件介绍.md               # 产品文档
├── PLAN.md                  # 本文档
└── src/
    ├── main.ts              # 插件入口：命令/事件/视图注册，协调各模块
    ├── types.ts             # 数据模型 + 设置 + 内置类型常量
    ├── storage.ts           # GlossStorage：.gloss/ 读写、缓存、防抖写盘、失效缓存
    ├── settings.ts          # GlossSettingTab + loadSettings
    ├── anchor.ts            # 文本锚点：选区→锚点；渲染时定位+模糊重锚；wrap/unwrap 文本节点
    ├── layout.ts            # 宽屏布局算法：side 判定、纵向 sweep 防重叠、SVG 连线；窄屏判定
    ├── card.ts              # 批注卡片 UI（内容/回复/录音/附件/闪卡/类型切换/删除）
    ├── popover.ts           # 选区浮泡 pill + 新建批注 popover + 气泡模式弹出
    ├── typemanager.ts       # 类型管理：Modal（拖拽排序/增删改）
    ├── review.ts            # 闪卡复习 ItemView（M3）
    ├── pdf.ts               # PDF 场景挂接（M2）
    └── export.ts            # 批注导出 Markdown / JSON 备份
```

## 4. 数据模型

```ts
// ---- 锚点 ----
interface MdAnchor   { kind: 'md';  blockId: string;      // 预览块 data-block-id（可空）
                             start: number; end: number;  // 块内纯文本坐标
                             text: string }               // 选中原文（重锚依据）
interface PdfAnchor  { kind: 'pdf'; page: number;         // 1-based
                             text: string;                // 选中文本（可空）
                             bbox?: [number,number,number,number] } // 归一化 0-1 区域
type Anchor = MdAnchor | PdfAnchor;

interface GlossReply  { id: string; content: string; createdAt: number }
interface GlossAttachment { id: string; path: string; name: string; mime: string; size: number;
                            kind: 'audio'|'image'|'video'|'file' }
interface GlossAnnotation { id: string; typeId: string; content: string;
                             createdAt: number; updatedAt: number;
                             replies: GlossReply[]; attachments: GlossAttachment[];
                             flashcard: boolean }
interface GlossEntry { anchor: Anchor; note: GlossAnnotation }   // note 字段名保留与 Obsidian File 区分

// ---- 文件：.gloss/annotations/<safePath>.json ----
interface GlossDocStore { version: 1; docPath: string; kind: 'md'|'pdf';
                           entries: GlossEntry[] }

// ---- 文件：.gloss/types.json ----
interface GlossType { id: string; name: string; color: string; emoji: string;
                      builtin?: boolean; order: number }

// ---- 设置 ----
interface GlossSettings {
  layoutMode: 'auto'|'margin'|'bubble';   // 默认 auto
  wideBreakpoint: number;                 // 1280
  marginWidth: number;                    // 240
  highlightStyle: 'underline'|'rough';    // underline
  defaultTypeId: string;                  // 'key'
  attachmentsFolder: string;              // 'gloss-attachments'
  pdfEnabled: boolean;                    // true
}
```

内置类型（首次运行写入 `types.json`，之后全部可编辑/删除）：
`correction 🔧 #e5484d`、`idea 💡 #f5a524`、`question ❓ #e8843c`、`key ⭐ #3b82f6`、`review 📌 #30a46c`、`reference 📚 #8e4ec6`。
删除类型的存量批注渲染为灰色 `🗑 已删除类型`（fallback 常量 `GHOST_TYPE`）。

**safePath**：笔记相对路径中 `/` → `__`，空格/中文原样保留（vault 内合法字符）。

## 5. 关键技术方案

### 5.1 文本锚定与模糊重锚（最核心）

- **新建**（预览/实时预览）：`selectionchange` 捕获选区 → 最近祖先 `[data-block-id]` 块 → 遍历块内文本节点（跳过 `.gloss-*` UI 节点）计算选区在块纯文本中的 `[start,end)` → `MdAnchor{blockId,start,end,text}`。
- **新建**（源码模式，命令）：取光标段落行范围，段落纯文本 + 选区在段内偏移 → 锚点（blockId 置空，靠文本重锚）。
- **渲染定位**（每次 `markdown-rendered`）：
  1. 优先 `blockId` 命中 → 校验 `text === blockText.slice(start,end)`；
  2. 失败 → 在同块纯文本内 `indexOf(text)`；
  3. 失败 → 全文档块遍历（按 `blockId` 前缀/相邻块优先）；
  4. 仍失败 → 标记 orphan（不渲染，统计计数，导出可见）。
- **wrap**：按文本节点切分 + `Range.surroundContents(span.gloss-hl)`；跨行内元素（加粗/代码）时逐段分别 wrap，视觉连续。渲染前先 unwrap 旧 `.gloss-hl` 保证幂等。

### 5.2 宽屏页边布局算法

- 触发条件：`layoutMode=margin` 或（`auto` 且 `视口宽度 ≥ wideBreakpoint` 且 `sizer 宽度 + 2×marginWidth ≤ 容器宽度`）。
- 注入 `.gloss-margin-layer`（absolute，覆盖预览内容区，文档坐标系，height=scrollHeight）；给 `.markdown-preview-sizer` 加 `padding-inline: marginWidth` 让出空间。
- 每条批注：`rect = 高亮 span 的 rect`（相对内容原点 + scrollTop）；`side = 用户指定 | (rect.midX < sizerMidX ? left : right)`。
- 纵向 sweep（每侧独立）：按 `anchorTop` 排序，`cardTop = max(anchorTop + rect.height/2 - 24, prevBottom + 12)`，保证不重叠；卡片高度由 `ResizeObserver` 实测，变化后重排。
- 连线：SVG 贝塞尔 `C`，起点=高亮左/右中点，终点=卡片内侧边缘中点，stroke=类型色，opacity .55，width 1.5。
- 重排时机：`markdown-rendered`（防抖 150ms）、`resize`、卡片高度变化、CRUD、滚动不重排（卡片在文档坐标系）。

### 5.3 窄屏气泡模式

- 无页边层；高亮 span `click/tap` → 在 span 附近弹 `.gloss-bubble`（absolute 于预览容器，视口内 clamp；下方空间不足则上翻）。
- 气泡内=完整卡片（max-height 60vh 可滚动）；点外部/Esc 关闭。
- 移动端判定：`matchMedia('(hover: none)')` 辅助，点击用 `pointerdown` 兜底。

### 5.4 高亮两风格（CSS + 内联 SVG）

- 下划线：`background: color-mix(in srgb, <c> 12%, transparent); border-bottom: 2px dashed <c>;`（`color-mix` 不可用时回退固定 rgba）。
- 粗糙边缘：注入一次全局 `<svg width=0><filter id="gloss-rough">…feTurbulence baseFrequency=0.02 numOctaves=3 + feDisplacementMap scale=6…</filter>`；高亮 `::before`（inset:-2px -2px，背景色块）`filter: url(#gloss-rough)`，文字不受影响。

### 5.5 录音 / 附件

- `navigator.mediaDevices.getUserMedia({audio:true})` → `MediaRecorder`（MIME 按 `isTypeSupported` 顺序选 `audio/webm;codecs=opus` → `audio/ogg` → 默认）→ blob → `vault.createBinary(path, blob)`，存 `<attachmentsFolder>/<annId>/voice-<ts>.webm`。
- 附件：`<input type=file>` → `vault.createBinary` → 记 `GlossAttachment`。渲染：image→`<img>`（`app.vault.getResourcePath`）、video/audio→原生控件、其他→可点击打开链接。
- 权限失败：`NotAllowedError` → 卡片内红字提示，不静默。

### 5.6 类型管理（拖拽排序）

- Modal 列表，HTML5 `draggable` + `dragover` 指示线（移动端回退为 ↑↓ 按钮）；行内编辑名称/Emoji，`<input type=color>` 选色；保存即写 `types.json`，所有已渲染页边卡片即时换色。

### 5.7 PDF 场景（M2）

- 监听 `layout-ready`/`file-open` 找到 `PdfView`（`view instanceof` 探测 + `view.pdfDocument` 属性探测）。
- 有 `pdfDocument`（PDFDocumentProxy）：canvas 上框选 → 逆变换到 PDF 坐标 → `getPage(page).getTextContent()` 取覆盖的 text items → `PdfAnchor{page,text}`；渲染用 text items 的 transform 合成矩形，按当前 viewport scale 画在 canvas 上层的 absolute 覆盖层，随缩放重算。
- 无 `pdfDocument`（版本差异）：降级为**纯区域锚点** `bbox`（归一化矩形），高亮=半透明色块矩形，功能不缺失。
- 批注卡片复用 Markdown 同一套 UI；页边布局复用 `layout.ts`（PDF 视口同样左右留白）。

### 5.8 闪卡（M3）

- 复习视图（`ItemView`，type `gloss-review`）：扫描 `.gloss/annotations/*` 收集 `flashcard=true` → 卡片流：正面=引用原文+来源链接，背面=批注内容+回复；`←/→` 导航，`空格` 翻面，`g` 标记已掌握（关 flashcard）。
- 导出：Markdown 笔记，每条 `> 原文` + `{{card}}` + 类型/时间 frontmatter 风格标记；文件名 `Gloss 闪卡 - <doc> - <date>.md`。

### 5.9 导出（M1 附带）

- 「导出批注」：当前文档 → Markdown（按页边顺序：`### [类型emoji 类型名] 原文引用` + 内容 + 回复 + 附件链接 + 时间；orphan 标注 `⚠️ 锚点失效`）。

## 6. 里程碑与验收

### M0 脚手架（~0.5d）
- [ ] package/tsconfig/esbuild/manifest/versions 就绪，`npm run dev` 可 watch 并同步产物进 vault，Obsidian 重载后插件加载无报错。
- 验收：命令面板可见 5 条 Gloss 命令；设置页出现。

### M1 Markdown 核心（~3d，本期主体）
- [ ] 选区浮泡 + 右键 + 命令三条入口建批注；卡片 CRUD；回复；录音；附件；类型管理（含拖拽）。
- [ ] 高亮两风格；宽屏页边布局 + 连线；窄屏气泡；重锚与 orphan。
- 验收用例：
  1. 长文档 20 条批注，页边无重叠、连线对位、滚动流畅；
  2. 拖窗口跨断点，布局/气泡自动切换无残留 DOM；
  3. 修改高亮文字一个词 → 重锚成功；整段删除 → 变 orphan，数据仍在；
  4. 录音在桌面+移动端可播放；图片附件内联预览；
  5. 自定义类型（改名/换色/拖拽）后全库即时生效；删除类型 → 存量显示灰色 fallback；
  6. 重启 Obsidian 后批注完整恢复；源文件 md5 无变化。

### M2 PDF（~2d）
- 验收：PDF 选文/框选挂批注；缩放/翻页后高亮对位；与 Markdown 批注共存不串。

### M3 闪卡（~1d）
- 验收：⚡ 开关 → 复习视图可见；翻页/翻面/掌握；导出 md 可被 Spaced Repetition 插件识别。

### M4 体验（~1d，按需）
- 失效批注修复向导、JSON 导入、源码模式 gutter 标记、按类型筛选查看。

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 块纯文本 vs 源码不一致（行内代码/链接/数学公式渲染差异） | 重锚失败率 | 锚点用**渲染层纯文本**坐标；重锚三级回退；orphan 兜底不丢数据 |
| `data-block-id` 在部分块（表格/代码块）缺失 | 无法锚定 | 允许 blockId 空 → 走文本重锚；表格内选区取最近有 id 祖先 |
| Obsidian 各版本 PDF 内部属性差异 | M2 挂接失败 | 属性探测 + 纯区域锚点降级；`pdfEnabled` 可关 |
| 移动端 MediaRecorder 支持不全 | 录音不可用 | MIME 回退链 + 明确错误提示（不静默） |
| 大文档渲染开销（200+ 条批注） | 卡顿 | 防抖 + 增量重排（只动变化侧）+ 连线单 SVG 一次 batch |
| 多窗口/分屏同开一篇笔记 | 双写 | 存储防抖写盘 + `vault.on('modify')` 监听 `.gloss` 失效缓存重读 |

## 8. 开发流程

```bash
cd gloss
npm install            # 走代理：https_proxy=http://127.0.0.1:7897
npm run dev            # watch + 自动同步到 ../.obsidian/plugins/gloss/
# Obsidian: 设置→第三方插件→启用 Gloss；改代码后 Ctrl/Cmd+P → Reload app
npm run build          # 发布产物 main.js（minified）
```

- 提交粒度：每个里程碑内按模块提交（anchor / layout / card / …），commit 尾行带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 类型检查：`npm run type`（tsc --noEmit）每次提交前跑。
