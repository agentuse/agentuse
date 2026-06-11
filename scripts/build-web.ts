/**
 * Builds the serve Web UI (Preact SPA) into dist/web with content-hashed
 * filenames and writes dist/web/manifest.json so the server can resolve them.
 *
 * Usage: bun scripts/build-web.ts [--watch]
 */
import { basename, extname, relative, resolve } from "path";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { createHash } from "crypto";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(ROOT, "src/cli/serve/web/main.tsx");
const OUTDIR = resolve(ROOT, "dist/web");
const WATCH = process.argv.includes("--watch");

async function buildWeb(): Promise<void> {
  await rm(OUTDIR, { recursive: true, force: true });
  await mkdir(OUTDIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    sourcemap: "linked",
    naming: {
      entry: "[name]-[hash].[ext]",
      chunk: "chunks/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
    // Font URLs in app.css point at the runtime asset route; they are copied
    // and hash-renamed below, not bundled.
    external: ["/assets/*"],
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Web UI build failed");
  }

  const outputs = result.outputs.map((artifact) => ({
    path: relative(OUTDIR, artifact.path),
    kind: artifact.kind,
  }));

  const entry = outputs.find((o) => o.kind === "entry-point" && o.path.endsWith(".js"))?.path;
  if (!entry) {
    throw new Error("Web UI build produced no JS entry point");
  }
  const css = outputs.filter((o) => o.path.endsWith(".css")).map((o) => o.path);

  // Copy fonts as content-hashed files and rewrite their URLs in the CSS.
  // Bun's CSS bundler inlines relative url() assets as base64, so app.css
  // references stable absolute paths that we swap for hashed ones here.
  const fontsDir = resolve(ROOT, "src/cli/serve/web/fonts");
  await mkdir(resolve(OUTDIR, "fonts"), { recursive: true });
  const fontRewrites = new Map<string, string>();
  for (const file of await readdir(fontsDir)) {
    if (!file.endsWith(".woff2")) continue;
    const content = await readFile(resolve(fontsDir, file));
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
    const ext = extname(file);
    const hashed = `fonts/${basename(file, ext)}-${hash}${ext}`;
    await writeFile(resolve(OUTDIR, hashed), content);
    fontRewrites.set(`/assets/fonts/${file}`, `/assets/${hashed}`);
    outputs.push({ path: hashed, kind: "asset" });
  }
  for (const cssPath of css) {
    let content = await readFile(resolve(OUTDIR, cssPath), "utf-8");
    for (const [from, to] of fontRewrites) {
      content = content.split(from).join(to);
    }
    await writeFile(resolve(OUTDIR, cssPath), content);
  }

  const manifest = { entry, css, files: outputs.map((o) => o.path) };
  await writeFile(resolve(OUTDIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  const total = result.outputs.reduce((sum, o) => sum + o.size, 0);
  console.log(`web ui: ${result.outputs.length} files, ${(total / 1024).toFixed(1)} kB -> dist/web (entry ${entry})`);
}

await buildWeb();

if (WATCH) {
  const { watch } = await import("chokidar");
  const webDir = resolve(ROOT, "src/cli/serve/web");
  let timer: ReturnType<typeof setTimeout> | null = null;
  let building = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (building) {
        schedule();
        return;
      }
      building = true;
      try {
        await buildWeb();
      } catch (err) {
        console.error((err as Error).message);
      } finally {
        building = false;
      }
    }, 100);
  };

  watch(webDir, { ignoreInitial: true }).on("all", schedule);
  console.log(`watching ${webDir} for changes...`);
}
