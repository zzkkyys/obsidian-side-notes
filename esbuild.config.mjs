import esbuild from "esbuild";
import process from "process";
import path from "path";
import { fileURLToPath } from "url";
import { copyFile, mkdir } from "fs/promises";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const VAULT_PLUGIN_DIR = path.join(projectDir, "..", ".obsidian", "plugins", "gloss");

const prod = process.argv[2] === "production";
const watch = process.argv[2] === "watch";

/** 构建成功后把产物同步进当前库的插件目录，方便直接重载测试 */
const syncPlugin = {
  name: "sync-to-vault",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      try {
        await mkdir(VAULT_PLUGIN_DIR, { recursive: true });
        for (const f of ["main.js", "styles.css", "manifest.json"]) {
          await copyFile(path.join(projectDir, f), path.join(VAULT_PLUGIN_DIR, f));
        }
        console.log(`[gloss] synced -> ${VAULT_PLUGIN_DIR}`);
      } catch (e) {
        console.error("[gloss] sync failed:", e.message);
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
  plugins: [syncPlugin],
});

if (watch) {
  await context.watch();
  console.log("[gloss] watching... 改码后在 Obsidian 里 Reload app (或等 3s 热重载)");
} else {
  await context.rebuild();
  await context.dispose();
}
