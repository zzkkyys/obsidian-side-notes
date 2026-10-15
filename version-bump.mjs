import { readFileSync, writeFileSync } from "node:fs";

// npm version updates package.json and package-lock.json before this lifecycle hook.
const targetVersion = process.env.npm_package_version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(targetVersion ?? "")) {
  throw new Error("Use npm version with a stable X.Y.Z version (without a v prefix).");
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
manifest.version = targetVersion;
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
