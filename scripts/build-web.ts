/**
 * Builds the serve Web UI (Preact SPA) into dist/web with content-hashed
 * filenames and writes dist/web/manifest.json so the server can resolve them.
 *
 * Usage: bun scripts/build-web.ts [--watch]
 */
import { basename, extname, relative, resolve } from "path";
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { tmpdir } from "os";
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "zlib";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(ROOT, "src/cli/serve/web/main.tsx");
const OUTDIR = resolve(ROOT, "dist/web");
const WATCH = process.argv.includes("--watch");
const LOCK_PATH = resolve(
  tmpdir(),
  `agentuse-build-web-${createHash("sha256").update(ROOT).digest("hex").slice(0, 16)}.lock`,
);
const LOCK_STALE_GRACE_MS = 5_000;
const LOCK_TIMEOUT_MS = 120_000;

type BuildLock = {
  pid: number;
  root: string;
  token: string;
};

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function lockIsStale(): Promise<boolean> {
  try {
    const raw = await readFile(LOCK_PATH, "utf-8");
    const lock = JSON.parse(raw) as Partial<BuildLock>;
    if (lock.root === ROOT && typeof lock.pid === "number") {
      return !processIsAlive(lock.pid);
    }
  } catch {
    // A process can be between creating and populating the lock file. Only
    // reclaim an unreadable lock after that short startup window has passed.
  }

  try {
    return Date.now() - (await stat(LOCK_PATH)).mtimeMs > LOCK_STALE_GRACE_MS;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function acquireBuildLock(): Promise<() => Promise<void>> {
  const lock: BuildLock = { pid: process.pid, root: ROOT, token: randomUUID() };
  const startedAt = Date.now();
  let announcedWait = false;

  while (true) {
    try {
      const handle = await open(LOCK_PATH, "wx");
      try {
        await handle.writeFile(JSON.stringify(lock));
      } finally {
        await handle.close();
      }

      return async () => {
        try {
          const current = JSON.parse(await readFile(LOCK_PATH, "utf-8")) as Partial<BuildLock>;
          if (current.token === lock.token) await rm(LOCK_PATH, { force: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    if (await lockIsStale()) {
      await rm(LOCK_PATH, { force: true });
      continue;
    }

    if (!announcedWait) {
      console.log("web ui: waiting for another build to finish...");
      announcedWait = true;
    }
    if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for the web build lock at ${LOCK_PATH}`);
    }
    await Bun.sleep(50);
  }
}

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

  // The entry statically imports the shared framework/vendor chunk(s); route
  // chunks are dynamic import() (lazy). Record the static imports so the HTML
  // shell can modulepreload them in parallel with the entry instead of paying
  // an extra round-trip once the entry parses and discovers them.
  const entryCode = await readFile(resolve(OUTDIR, entry), "utf-8");
  const preload = [...entryCode.matchAll(/from\s*"\.\/(chunks\/[^"]+\.js)"/g)].map((m) => m[1]);

  const manifest = { entry, css, preload, files: outputs.map((o) => o.path) };
  await writeFile(resolve(OUTDIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Pre-brotli/gzip the JS+CSS so the server streams immutable, precompressed
  // bytes with zero per-request CPU (filenames are content-hashed). woff2 is
  // already compressed; source maps are dev-only, so both are skipped.
  let compressedSavings = 0;
  for (const o of outputs) {
    if (!o.path.endsWith(".js") && !o.path.endsWith(".css")) continue;
    const abs = resolve(OUTDIR, o.path);
    const buf = await readFile(abs);
    const br = brotliCompressSync(buf, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
    await writeFile(`${abs}.br`, br);
    await writeFile(`${abs}.gz`, gzipSync(buf, { level: 9 }));
    compressedSavings += buf.length - br.length;
  }

  const total = result.outputs.reduce((sum, o) => sum + o.size, 0);
  console.log(
    `web ui: ${result.outputs.length} files, ${(total / 1024).toFixed(1)} kB -> dist/web ` +
      `(entry ${entry}, brotli saves ${(compressedSavings / 1024).toFixed(1)} kB over the wire)`,
  );
}

const runBuildWeb = async (): Promise<void> => {
  const releaseBuildLock = await acquireBuildLock();
  try {
    await buildWeb();
  } finally {
    await releaseBuildLock();
  }
};

await runBuildWeb();

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
        await runBuildWeb();
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
