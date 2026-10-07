import { readFile, writeFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
const run = (file, args) => execFileSync(process.execPath, [file, ...args], { stdio: "inherit" });
run("node_modules/vite/bin/vite.js", ["build"]);
const generated = JSON.parse(await readFile(".wrangler/deploy/config.json", "utf8"));
await mkdir(".local", { recursive: true });
const bundleDirectory = await mkdtemp(resolve(".local/release-worker-"));
run("node_modules/wrangler/bin/wrangler.js", ["deploy", "--dry-run", "--config", resolve(".wrangler/deploy", generated.configPath), "--outdir", bundleDirectory]);
const digest = (data, algo = "sha256") => createHash(algo).update(data).digest("hex");
const types = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".png":"image/png", ".json":"application/json", ".woff2":"font/woff2", ".ico":"image/x-icon" };
async function walk(root, dir = root) {
  const entries = await readdir(dir, { withFileTypes: true }); const files = [];
  for (const e of entries.sort((a,b) => a.name.localeCompare(b.name))) { const path = join(dir, e.name); if (e.isDirectory()) files.push(...await walk(root, path)); else files.push({ path, name: relative(root, path).replaceAll("\\", "/") }); } return files;
}
const modules = [];
for (const f of await walk(bundleDirectory)) {
  if (!/\.(m?js|wasm)$/.test(f.name)) continue;
  modules.push({ name: f.name, type: f.name.endsWith(".wasm") ? "application/wasm" : "application/javascript+module", content: (await readFile(f.path)).toString("base64") });
}
const assets = [];
for (const f of await walk("dist/client")) {
  const data = await readFile(f.path); if (f.name.endsWith(".map") || f.name.startsWith(".")) continue;
  const extension = "." + f.name.split(".").at(-1);
  assets.push({ path: "/" + f.name, hash: digest(data, "md5"), content: data.toString("base64"), type: types[extension] || "application/octet-stream" });
}
const main = modules.find(m => m.name === "index.js")?.name || modules.find(m => m.name.endsWith(".js"))?.name;
if (!main || !assets.some(a => a.path === "/index.html")) throw new Error("Incomplete release");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const payload = { version: pkg.version, main, modules, assets };
await writeFile("installer/public/release.json", JSON.stringify({ ...payload, sha256: digest(JSON.stringify(payload)) }));
console.log(`Packaged IntentTrace ${pkg.version}: ${modules.length} modules, ${assets.length} interface assets. No runtime secrets included.`);
