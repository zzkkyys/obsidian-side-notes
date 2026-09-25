import { App, PluginSettingTab, Setting } from "obsidian";
import type GlossPlugin from "./main";
import { TypeManagerModal } from "./typemanager";

export class GlossSettingTab extends PluginSettingTab {
  plugin: GlossPlugin;

  constructor(app: App, plugin: GlossPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("布局模式")
      .setDesc("自动 = 宽屏页边双栏 / 窄屏气泡；也可强制指定")
      .addDropdown((d) => {
        d.addOption("auto", "自动（推荐）")
          .addOption("margin", "始终页边双栏")
          .addOption("bubble", "始终气泡")
          .setValue(s.layoutMode)
          .onChange(async (v) => {
            s.layoutMode = v as typeof s.layoutMode;
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          });
      });

    new Setting(containerEl)
      .setName("宽屏断点")
      .setDesc("视口宽度超过该值时启用页边布局（自动模式）")
      .addSlider((sl) => {
        sl.setLimits(900, 2200, "any").setValue(s.wideBreakpoint)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.wideBreakpoint = Math.round(v);
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          });
      });

    new Setting(containerEl)
      .setName("页边宽度")
      .setDesc("两侧批注栏的宽度")
      .addSlider((sl) => {
        sl.setLimits(248, 420, "any").setValue(s.marginWidth)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.marginWidth = Math.round(v);
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          });
      });

    new Setting(containerEl)
      .setName("卡片风格")
      .setDesc("macOS 玻璃：半透明磨砂材质，背景和阴影随批注类型变色")
      .addDropdown((d) => {
        d.addOption("plain", "简洁（原有风格）")
          .addOption("glass", "macOS 玻璃（跟随类型颜色）")
          .setValue(s.cardStyle)
          .onChange(async (v) => {
            s.cardStyle = v as typeof s.cardStyle;
            this.plugin.updateCardStyles();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("高亮风格")
      .setDesc("下划线：彩色虚线+浅底；粗糙边缘：荧光笔手绘毛边")
      .addDropdown((d) => {
        d.addOption("underline", "下划线")
          .addOption("rough", "粗糙边缘（荧光笔）")
          .setValue(s.highlightStyle)
          .onChange(async (v) => {
            s.highlightStyle = v as typeof s.highlightStyle;
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          });
      });

    new Setting(containerEl)
      .setName("默认批注类型")
      .setDesc("新建批注时预选的类型")
      .addDropdown((d) => {
        for (const t of this.plugin.storage.sortedTypes()) {
          d.addOption(t.id, `${t.emoji} ${t.name}`);
        }
        d.setValue(s.defaultTypeId)
          .onChange(async (v) => {
            s.defaultTypeId = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("附件文件夹")
      .setDesc("图片与其他附件的存放位置（库内相对路径）")
      .addText((t) => {
        t.setValue(s.attachmentsFolder).setPlaceholder("gloss-attachments")
          .onChange(async (v) => {
            s.attachmentsFolder = v.trim() || "gloss-attachments";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("PDF 批注")
      .setDesc("在内置 PDF 阅读器中支持框选/点选挂批注（实验性）")
      .addToggle((t) => {
        t.setValue(s.pdfEnabled)
          .onChange(async (v) => {
            s.pdfEnabled = v;
            await this.plugin.saveSettings();
            this.plugin.setPdfEnabled(v); // 立即生效：关闭时移除高亮层，打开时重新扫描
          });
      });

    new Setting(containerEl)
      .setName("管理批注类型")
      .setDesc("5 种内置类型 + 自定义：名称、颜色、Emoji、拖拽排序")
      .addButton((b) => b
        .setButtonText("管理")
        .onClick(() => new TypeManagerModal(this.app, this.plugin).open()));

    new Setting(containerEl)
      .setName("关于")
      .setDesc("数据全部本地存储于 .gloss/ 目录；批注不修改笔记正文。v" + this.plugin.manifest.version);
  }
}
