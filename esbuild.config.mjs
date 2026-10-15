import esbuild from "esbuild";
import process from "process";
import path from "path";
import { fileURLToPath } from "url";
import { access, copyFile, mkdir, readFile } from "fs/promises";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
let local = {};
try {
  local = JSON.parse(await readFile(path.join(projectDir, "gloss.local.json"), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const vaultPath = process.env.GLOSS_VAULT_PATH || local.vaultPath;
const deploy = process.argv.includes("--deploy");
if (deploy && !vaultPath) throw new Error("Set GLOSS_VAULT_PATH or vaultPath in gloss.local.json before deploying");
const vaultPluginDir = vaultPath ? path.join(path.resolve(vaultPath), ".obsidian", "plugins", "gloss") : null;
if (deploy) await access(path.join(path.resolve(vaultPath), ".obsidian"));

const prod = process.argv[2] === "production";
const watch = process.argv[2] === "watch";

/** Explicit deployment keeps ordinary builds independent of any local vault. */
const syncPlugin = {
  name: "sync-to-vault",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      try {
        await mkdir(vaultPluginDir, { recursive: true });
        for (const f of ["main.js", "styles.css", "manifest.json"]) {
          await copyFile(path.join(projectDir, f), path.join(vaultPluginDir, f));
        }
        console.log(`[gloss] synced -> ${vaultPluginDir}`);
      } catch (e) {
        return { errors: [{ text: `[gloss] sync failed: ${e.message}` }] };
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: [path.join(projectDir, "src/main.ts")],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: path.join(projectDir, "main.js"),
  plugins: deploy ? [syncPlugin] : [],
});

if (watch) {
  await context.watch();
  console.log("[gloss] watching... 改码后在 Obsidian 里 Reload app (或等 3s 热重载)");
} else {
  await context.rebuild();
  await context.dispose();
}
