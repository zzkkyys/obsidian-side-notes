import { App, Modal, Notice } from "obsidian";
import type GlossPlugin from "./main";
import type { GlossType } from "./types";
import { uuid } from "./util";

/**
 * 批注类型管理：名称 / 颜色 / Emoji 就地编辑，拖拽（或 ↑↓）排序。
 * 内置类型同样可改可删；删除类型的存量批注显示为灰色 fallback。
 */
export class TypeManagerModal extends Modal {
  constructor(app: App, private plugin: GlossPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "管理批注类型" });
    contentEl.createDiv({
      cls: "gloss-tm-hint",
      text: "点击名称 / Emoji / 色块就地修改；拖动 ⋮⋮（或按 ↑↓）排序；点击“保存并关闭”后生效；外部变更时保留草稿并阻止覆盖。",
    });
    if (!this.plugin.storage.canEditTypes) {
      contentEl.createDiv({ text: "类型文件不可读，暂时无法编辑。请修复 .gloss/types.json 后重新打开此面板。" });
      return;
    }
    const list = contentEl.createDiv({ cls: "gloss-tm-list" });

    const expected = JSON.stringify(this.plugin.storage.types);
    const draft: GlossType[] = JSON.parse(expected);
    const persist = () => {}; // 编辑独立草稿；保存成功前不改变共享类型。

    const render = () => {
      list.empty();
      const types = [...draft].sort((a, b) => a.order - b.order);
      let dragged: string | null = null;

      const setOrder = (arr: GlossType[]) => {
        draft.splice(0, draft.length, ...arr);
        draft.forEach((t, i) => { t.order = i; });
        persist();
        render();
      };

      types.forEach((t, idx) => {
        const row = list.createDiv({ cls: "gloss-tm-row" });
        row.style.setProperty("--gloss-color", t.color);
        row.draggable = true;

        row.createSpan({ cls: "gloss-tm-grip", text: "⋮⋮" });

        const emoji = row.createEl("input", { cls: "gloss-tm-emoji" });
        emoji.value = t.emoji;
        emoji.maxLength = 4;
        emoji.onchange = () => { t.emoji = emoji.value.trim() || "📝"; persist(); row.style.setProperty("--gloss-color", t.color); };

        const name = row.createEl("input", { cls: "gloss-tm-name" });
        name.value = t.name;
        name.onchange = () => { t.name = name.value.trim() || "未命名"; persist(); };

        const color = row.createEl("input", { cls: "gloss-tm-color" });
        color.type = "color";
        color.value = t.color;
        color.onchange = () => {
          t.color = color.value;
          row.style.setProperty("--gloss-color", t.color);
          persist(); // 颜色改动即时刷到所有视图的卡片/高亮
        };

        const nav = row.createDiv({ cls: "gloss-tm-nav" });
        const up = nav.createEl("button", { text: "↑" });
        const down = nav.createEl("button", { text: "↓" });
        up.onclick = () => { if (idx > 0) setOrder(moveIn(types, idx, idx - 1)); };
        down.onclick = () => { if (idx < types.length - 1) setOrder(moveIn(types, idx, idx + 1)); };

        const del = row.createEl("button", { cls: "gloss-ic gloss-tm-del", text: "✕" });
        del.title = "删除类型（再点一次确认）";
        del.onclick = () => {
          if (del.dataset.arm) {
            setOrder(types.filter(x => x.id !== t.id));
          } else {
            del.dataset.arm = "1";
            del.addClass("gloss-armed");
            setTimeout(() => { delete del.dataset.arm; del.removeClass("gloss-armed"); }, 2500);
          }
        };

        // 拖拽排序
        row.addEventListener("dragstart", (e) => {
          dragged = t.id;
          (e as DragEvent).dataTransfer?.setData("text/plain", t.id);
          row.addClass("gloss-dragging");
        });
        row.addEventListener("dragend", () => row.removeClass("gloss-dragging"));
        row.addEventListener("dragover", (e) => { e.preventDefault(); row.addClass("gloss-drag-over"); });
        row.addEventListener("dragleave", () => row.removeClass("gloss-drag-over"));
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          row.removeClass("gloss-drag-over");
          if (!dragged || dragged === t.id) return;
          const from = types.findIndex((x) => x.id === dragged);
          const to = types.findIndex((x) => x.id === t.id);
          if (from < 0 || to < 0) return;
          setOrder(moveIn(types, from, to));
          dragged = null;
        });
      });
    };

    const foot = contentEl.createDiv({ cls: "gloss-tm-foot" });
    const add = foot.createEl("button", { text: "＋ 新建类型" });
    add.onclick = () => {
      const maxOrder = draft.reduce((m, t) => Math.max(m, t.order), -1);
      draft.push({ id: uuid().slice(0, 8), name: "新类型", color: "#3b82f6", emoji: "📝", order: maxOrder + 1 });
      persist();
      render();
    };
    const done = foot.createEl("button", { cls: "gloss-primary", text: "保存并关闭" });
    done.onclick = async () => {
      const controls = Array.from(contentEl.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"));
      controls.forEach(control => { control.disabled = true; });
      try {
        await this.plugin.storage.saveTypesSnapshot(draft, expected);
        if (!draft.some(t => t.id === this.plugin.settings.defaultTypeId)) {
          this.plugin.settings.defaultTypeId = draft[0]?.id ?? "general"; await this.plugin.saveSettings();
        }
        this.close();
      } catch (error) { new Notice(`${String(error)}。面板中的草稿仍保留。`); }
      finally { controls.forEach(control => { control.disabled = false; }); }
    };

    render();
  }

  onClose(): void {
    this.plugin.refreshAll(); // 兜底：关闭前把未触发的类型改动刷到视图
    this.contentEl.empty();
  }
}

function moveIn<T>(arr: T[], from: number, to: number): T[] {
  const out = [...arr];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}
