// Bundles the renderer entry points to dist/renderer and copies the static HTML
// and CSS alongside them. Run with: node scripts/build-renderer.mjs
import esbuild from "esbuild";
import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src", "renderer");
const outDir = join(root, "dist", "renderer");

const entryPoints = [
  join(srcDir, "settings.ts"),
  join(srcDir, "overlay.ts"),
  join(srcDir, "audio.ts"),
];

async function copyStaticAssets() {
  const entries = await readdir(srcDir);
  const assets = entries.filter((name) => name.endsWith(".html") || name.endsWith(".css"));
  await Promise.all(assets.map((name) => cp(join(srcDir, name), join(outDir, name))));
  return assets;
}

async function main() {
  await mkdir(outDir, { recursive: true });

  await esbuild.build({
    entryPoints,
    outdir: outDir,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    logLevel: "info",
  });

  const assets = await copyStaticAssets();
  console.log(`renderer: bundled ${entryPoints.length} entries, copied ${assets.length} assets -> ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
