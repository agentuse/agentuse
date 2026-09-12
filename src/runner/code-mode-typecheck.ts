import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { dirname, join } from 'path';

let typeScriptPromise: Promise<typeof import('typescript')> | undefined;
// Standard library sources never change within a process; read each once.
const libSourceCache = new Map<string, Promise<string>>();

/**
 * Type-check one Code Mode body entirely in memory before QuickJS or any nested
 * tool starts. Module and filesystem resolution are deliberately unavailable.
 */
export async function typecheckCodeMode(
  source: string,
  declarations: string,
  maxBytes: number
): Promise<void> {
  typeScriptPromise ??= import('typescript');
  const ts = await typeScriptPromise;
  const files = new Map<string, string>();
  let bytes = 0;
  const add = (name: string, text: string): void => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) {
      throw new Error('Code Mode TypeScript preflight exceeds the memory allowance');
    }
    files.set(name, text);
  };

  add('user.ts', `async function __agentusePreflight() {\n${source}\n}`);
  add('guest.d.ts', declarations);

  const libDir = dirname(createRequire(import.meta.url).resolve('typescript'));
  const loadLib = async (name: string): Promise<void> => {
    if (files.has(name)) return;
    if (!/^lib\.[a-z0-9.]+\.d\.ts$/.test(name)) {
      throw new Error('Invalid TypeScript preflight standard library');
    }
    let pending = libSourceCache.get(name);
    if (!pending) {
      pending = readFile(join(libDir, name), 'utf8');
      libSourceCache.set(name, pending);
      pending.catch(() => libSourceCache.delete(name));
    }
    const text = await pending;
    add(name, text);
    for (const reference of ts.preProcessFile(text).libReferenceDirectives) {
      await loadLib(`lib.${reference.fileName}.d.ts`);
    }
  };
  await loadLib('lib.es2022.d.ts');

  const host: import('typescript').CompilerHost = {
    getSourceFile: (name, target) => {
      const text = files.get(name);
      return text === undefined ? undefined : ts.createSourceFile(name, text, target, true);
    },
    getDefaultLibFileName: () => 'lib.es2022.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    fileExists: name => files.has(name),
    readFile: name => files.get(name),
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram(
    [...files.keys()],
    {
      strict: true,
      noEmit: true,
      noLib: true,
      noResolve: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    },
    host
  );
  const failure = ts.getPreEmitDiagnostics(program)
    .find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (!failure) return;

  const point = failure.file && failure.start !== undefined
    ? failure.file.getLineAndCharacterOfPosition(failure.start)
    : undefined;
  const location = failure.file?.fileName === 'user.ts' && point
    ? `agentuse-code-mode:user.ts:${Math.max(1, point.line)}:${point.character + 1}: `
    : '';
  throw new Error(
    `Code Mode TypeScript preflight failed: ${location}${ts.flattenDiagnosticMessageText(failure.messageText, '\n')}`
  );
}
