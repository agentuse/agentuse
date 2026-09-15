import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { toErrorMessage } from '../utils/error-message';

let typeScriptPromise: Promise<typeof import('typescript')> | undefined;
// Standard library sources never change within a process; read each once.
const libSourceCache = new Map<string, Promise<string>>();

export interface CodeModeSourceLocation {
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface CodeModePreflightResult {
  locations: CodeModeSourceLocation[];
}

const MIB = 1024 * 1024;

/**
 * The TypeScript compiler needs host-side heap for its own module, ASTs, and
 * diagnostics in addition to the bounded source/declaration bytes. Reusing the
 * QuickJS guest limit as the Node heap cap leaves the default 32 MiB run with
 * effectively no compiler working space and can OOM before a tool is called.
 */
export function codeModeTypecheckHeapMb(maxBytes: number): number {
  return Math.max(64, Math.ceil(maxBytes / MIB) * 2);
}

// Deliberately self-contained: the production bundle has no separate source
// file beside it that a child process could import.
const TYPECHECK_CHILD_SOURCE = String.raw`
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
let payload = ''; for await (const chunk of process.stdin) payload += chunk;
const { source, declarations, maxBytes, typeScriptPath, libDir } = JSON.parse(payload);
try {
  const ts = await import(pathToFileURL(typeScriptPath).href);
  const files = new Map(); let bytes = 0;
  const add = (name, text) => { bytes += Buffer.byteLength(text, 'utf8'); if (bytes > maxBytes) throw new Error('Code Mode TypeScript preflight exceeds the memory allowance'); files.set(name, text); };
  const sourcePrefix = 'async function __agentusePreflight() {\n';
  add('user.ts', sourcePrefix + source + '\n}'); add('guest.d.ts', declarations);
  const loadLib = async (name) => { if (files.has(name)) return; if (!/^lib\.[a-z0-9.]+\.d\.ts$/.test(name)) throw new Error('Invalid TypeScript preflight standard library'); const text = await readFile(join(libDir, name), 'utf8'); add(name, text); for (const reference of ts.preProcessFile(text).libReferenceDirectives) await loadLib('lib.' + reference.fileName + '.d.ts'); };
  await loadLib('lib.es2022.d.ts');
  const host = { getSourceFile: (name, target) => { const text = files.get(name); return text === undefined ? undefined : ts.createSourceFile(name, text, target, true); }, getDefaultLibFileName: () => 'lib.es2022.d.ts', writeFile: () => {}, getCurrentDirectory: () => '', getDirectories: () => [], fileExists: name => files.has(name), readFile: name => files.get(name), getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n' };
  const program = ts.createProgram([...files.keys()], { strict: true, noEmit: true, noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true }, host);
  const userFile = program.getSourceFile('user.ts'); let detachedAsyncIife;
  const unwrap = node => { while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))) node = node.expression; return node; };
  const visit = node => { if (detachedAsyncIife) return; if (ts.isCallExpression(node)) { const callee = unwrap(node.expression); if ((ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) && callee.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) { let current = node; let parent = current.parent; while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(parent)))) { current = parent; parent = parent.parent; } if (parent && (ts.isVoidExpression(parent) || ts.isExpressionStatement(parent))) detachedAsyncIife = node; } } ts.forEachChild(node, visit); };
  if (userFile) visit(userFile);
  if (detachedAsyncIife && userFile) { const point = userFile.getLineAndCharacterOfPosition(detachedAsyncIife.getStart(userFile)); throw new Error('Code Mode TypeScript preflight failed: agentuse-code-mode:user.ts:' + Math.max(1, point.line) + ':' + (point.character + 1) + ': Detached async work can hide tool failures; await or return this async call.'); }
  const failure = ts.getPreEmitDiagnostics(program).find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (failure) { const point = failure.file && failure.start !== undefined ? failure.file.getLineAndCharacterOfPosition(failure.start) : undefined; const location = failure.file?.fileName === 'user.ts' && point ? 'agentuse-code-mode:user.ts:' + Math.max(1, point.line) + ':' + (point.character + 1) + ': ' : ''; throw new Error('Code Mode TypeScript preflight failed: ' + location + ts.flattenDiagnosticMessageText(failure.messageText, '\n')); }
  const locations = []; const seenLocations = new Set();
  const addLocation = expression => { if (!userFile || !expression) return; const start = expression.getStart(userFile) - sourcePrefix.length; const end = expression.end - sourcePrefix.length; if (start < 0 || end > source.length || start >= end) return; const key = start + ':' + end; if (seenLocations.has(key)) return; seenLocations.add(key); const point = userFile.getLineAndCharacterOfPosition(expression.getStart(userFile)); locations.push({ start, end, line: Math.max(1, point.line), column: point.character + 1 }); };
  const collectLocations = node => { if (ts.isExpressionStatement(node) || ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node)) addLocation(node.expression); else if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) || ts.isParameter(node)) addLocation(node.initializer); else if (ts.isForStatement(node)) { if (node.initializer && ts.isExpression(node.initializer)) addLocation(node.initializer); addLocation(node.condition); addLocation(node.incrementor); } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) addLocation(node.expression); else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) addLocation(node.body); ts.forEachChild(node, collectLocations); };
  if (userFile) collectLocations(userFile);
  process.stdout.write(JSON.stringify({ locations }));
} catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
`;

/**
 * Type-check one Code Mode body entirely in memory before QuickJS or any nested
 * tool starts. Module and filesystem resolution are deliberately unavailable.
 */
export async function typecheckCodeMode(
  source: string,
  declarations: string,
  maxBytes: number,
  abortSignal?: AbortSignal
): Promise<CodeModePreflightResult> {
  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Code Mode execution aborted');
  }
  const memoryMb = codeModeTypecheckHeapMb(maxBytes);
  const typeScriptPath = createRequire(import.meta.url).resolve('typescript');
  const libDir = dirname(typeScriptPath);
  const child = spawn(process.execPath, [`--max-old-space-size=${memoryMb}`, '--input-type=module', '--eval', TYPECHECK_CHILD_SOURCE], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise<CodeModePreflightResult>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const cleanup = (): void => {
      abortSignal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      child.kill();
      finish(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error('Code Mode execution aborted'));
    };
    const finish = (error?: Error, result?: CodeModePreflightResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result ?? { locations: [] });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', finish);
    child.once('close', code => {
      if (code !== 0) {
        finish(new Error(`Code Mode TypeScript preflight worker exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      try {
        const message = JSON.parse(stdout) as { error?: string; locations?: CodeModeSourceLocation[] };
        finish(message.error ? new Error(message.error) : undefined, {
          locations: Array.isArray(message.locations) ? message.locations : [],
        });
      } catch (error) {
        finish(new Error(`Code Mode TypeScript preflight worker returned invalid output: ${toErrorMessage(error)}`));
      }
    });
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    child.stdin.end(JSON.stringify({ source, declarations, maxBytes, typeScriptPath, libDir }));
  });
}

/** Runs inside the bounded worker. */
export async function typecheckCodeModeLocal(
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
  const userFile = program.getSourceFile('user.ts');
  let detachedAsyncIife: import('typescript').CallExpression | undefined;
  const unwrapExpression = (node: import('typescript').Expression): import('typescript').Expression => {
    while (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node)
      || ts.isSatisfiesExpression(node)
    ) node = node.expression;
    return node;
  };
  const findDetachedAsyncIife = (node: import('typescript').Node): void => {
    if (detachedAsyncIife) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (
        (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee))
        && callee.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        let current: import('typescript').Node = node;
        let parent = current.parent;
        while (
          parent
          && (
            ts.isParenthesizedExpression(parent)
            || ts.isAsExpression(parent)
            || ts.isTypeAssertionExpression(parent)
            || ts.isNonNullExpression(parent)
            || ts.isSatisfiesExpression(parent)
          )
        ) {
          current = parent;
          parent = parent.parent;
        }
        if (parent && (ts.isVoidExpression(parent) || ts.isExpressionStatement(parent))) {
          detachedAsyncIife = node;
          return;
        }
      }
    }
    ts.forEachChild(node, findDetachedAsyncIife);
  };
  if (userFile) findDetachedAsyncIife(userFile);
  if (detachedAsyncIife && userFile) {
    const point = userFile.getLineAndCharacterOfPosition(detachedAsyncIife.getStart(userFile));
    throw new Error(
      `Code Mode TypeScript preflight failed: agentuse-code-mode:user.ts:${Math.max(1, point.line)}:${point.character + 1}: `
      + 'Detached async work can hide tool failures; await or return this async call.'
    );
  }
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
