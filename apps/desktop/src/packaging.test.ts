import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const desktopRoot = join(import.meta.dir, "..");
const require = createRequire(import.meta.url);
const { onNodeModuleFile } = require(join(
  desktopRoot,
  "scripts",
  "include-typescript-lib-declarations.cjs",
)) as { onNodeModuleFile: (filePath: string) => true | undefined };

describe("desktop dependency packaging", () => {
  it("configures the TypeScript declaration inclusion hook", async () => {
    const manifest = await Bun.file(join(desktopRoot, "package.json")).json();
    expect(manifest.build.onNodeModuleFile).toBe("./scripts/include-typescript-lib-declarations.cjs");
    expect(manifest.build.asarUnpack).toEqual(expect.arrayContaining([
      "node_modules/esbuild/**",
      "node_modules/@esbuild/**",
    ]));
  });

  it("force-includes only TypeScript standard-library declarations", () => {
    const typeScriptLib = dirname(require.resolve("typescript"));
    const standardLibraryDeclarations = readdirSync(typeScriptLib)
      .filter(name => name.startsWith("lib") && name.endsWith(".d.ts"));

    expect(standardLibraryDeclarations.length).toBeGreaterThan(0);
    expect(standardLibraryDeclarations.filter(
      name => onNodeModuleFile(join(typeScriptLib, name)) !== true,
    )).toEqual([]);
    expect(onNodeModuleFile(join(typeScriptLib, "typescript.d.ts"))).toBeUndefined();
    expect(onNodeModuleFile(join(typeScriptLib, "typescript.js"))).toBeUndefined();
    expect(onNodeModuleFile(join(typeScriptLib, "..", "package.json"))).toBeUndefined();
    expect(onNodeModuleFile(join(typeScriptLib, "..", "..", "@types", "node", "index.d.ts"))).toBeUndefined();
  });

  it("recognizes pnpm and Windows dependency paths", () => {
    expect(onNodeModuleFile(
      "/repo/node_modules/.pnpm/typescript@5.9.2/node_modules/typescript/lib/lib.es2022.d.ts",
    )).toBe(true);
    expect(onNodeModuleFile(
      String.raw`C:\repo\node_modules\.pnpm\typescript@5.9.2\node_modules\typescript\lib\lib.es2022.d.ts`,
    )).toBe(true);
  });
});
