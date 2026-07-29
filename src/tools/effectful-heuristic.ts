/**
 * Heuristic: does a bash command PATTERN look like it performs an irreversible,
 * outward action (posting, sending, deleting, deploying)?
 *
 * This only DRIVES DEFAULTS and WARNINGS - it never enforces. Enforcement is
 * always an explicit `tools.bash.gated` declaration; a keyword guess must not
 * silently change what runs (a deploy agent that legitimately pushes should not
 * be force-gated). It is deliberately conservative: false negatives are fine (the
 * author still declares `gated`), false positives are just a suggestion the author
 * can ignore. Shared by `agentuse doctor`, the capability card, and (later) the
 * interactive unknown-command default.
 */

// Whole-word verb tokens whose presence suggests an outward, hard-to-undo effect.
const EFFECTFUL_VERBS = [
  'reply', 'tweet', 'post', 'send', 'publish', 'deploy', 'release',
  'delete', 'destroy', 'purge',
];

// Specific command shapes that are effectful regardless of surrounding words.
const EFFECTFUL_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i,                                        // rm -r / rm -rf / rm -f
  /\bgit\s+push\b/i,                                            // git push (incl. --force)
  /\bnpm\s+publish\b/i,
  /\bgh\s+release\s+(create|delete|upload)\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bcurl\b.*(-X\s*(POST|PUT|DELETE|PATCH)|--request\s*(POST|PUT|DELETE|PATCH)|--data\b|\s-d\b)/i,
  /\bwget\b.*--post/i,
  /\bkubectl\s+(delete|apply)\b/i,
  /\bterraform\s+(apply|destroy)\b/i,
];

/**
 * True when a command pattern looks like an irreversible action. `commandPattern`
 * is a `tools.bash.commands`-style entry (may contain `*` wildcards).
 */
export function looksEffectful(commandPattern: string): boolean {
  const cmd = commandPattern.trim();
  if (!cmd) return false;
  if (EFFECTFUL_PATTERNS.some((re) => re.test(cmd))) return true;
  const lower = cmd.toLowerCase();
  return EFFECTFUL_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`).test(lower));
}

// Heads whose subcommands are all reads, so a wildcard grant of them carries no
// hidden effect. Deliberately short: this list only suppresses noise, and a head
// missing from it costs one advisory line, never a false block.
const READ_ONLY_HEADS = new Set([
  'ls', 'cat', 'date', 'echo', 'pwd', 'which', 'sleep', 'mkdir', 'head', 'tail',
  'grep', 'rg', 'find', 'wc', 'sort', 'uniq', 'diff', 'stat', 'file', 'jq',
  'basename', 'dirname', 'realpath', 'printf', 'true', 'false', 'cd',
]);

// Programs whose first argument is NOT a subcommand: interpreters take a script,
// coreutils take operands. A wildcard there is still a broad grant but it is a
// different failure mode than an unnamed subcommand (see grantsArbitraryCode),
// and the unnamed-subcommand wording would misdescribe it.
const NO_SUBCOMMAND_HEADS = new Set([
  'python', 'python3', 'node', 'npx', 'bun', 'deno', 'ruby', 'perl',
  'sh', 'bash', 'zsh', 'osascript', 'cp', 'mv', 'ln', 'chmod', 'chown', 'dd', 'tee',
]);

// Interpreters and package runners: what follows is CODE, not a subcommand.
const INTERPRETER_HEADS = new Set([
  'python', 'python3', 'node', 'npx', 'bun', 'deno', 'ruby', 'perl',
  'sh', 'bash', 'zsh', 'osascript', 'uv', 'uvx',
]);

// Flags whose operand is inline code rather than a script path.
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '--command']);

// Runners that fetch and execute a named package.
const PACKAGE_RUNNERS = new Set(['uv', 'uvx', 'npx', 'bunx']);
const RUNNER_SUBCOMMANDS = new Set(['run', 'tool', 'x', 'exec']);

/** A concrete (non-wildcard) script the grant pins execution to. */
function looksLikeScriptPath(token: string): boolean {
  if (token.includes('*')) return false;
  return token.includes('/') || /\.(py|js|mjs|cjs|ts|rb|pl|sh|scpt)$/i.test(token);
}

/**
 * True when an interpreter grant does not pin what it executes, so it authorizes
 * ARBITRARY code: `python3 *`, `uv run *`, `bash -c *`.
 *
 * This is the one grant that silently voids the rest of the allowlist. Enumerating
 * commands only means something if the agent cannot write its own: `python3 *` can
 * POST, delete, or spawn anything the allowlist carefully withheld. Pinning the
 * script (`python3 scripts/report.py *`) restores the ceiling, which is why the
 * distinction here is pinned-vs-unpinned rather than interpreter-vs-not.
 */
export function grantsArbitraryCode(commandPattern: string): boolean {
  const tokens = commandPattern.trim().split(/\s+/).filter(Boolean);
  const head = effectiveHead(tokens);
  if (!head || head.includes('*')) return false;
  const program = head.replace(/.*\//, '');
  if (!INTERPRETER_HEADS.has(program)) return false;

  let rest = tokens.slice(tokens.indexOf(head) + 1);
  if (rest.length === 0) return false;
  if (rest.some((tok) => INLINE_CODE_FLAGS.has(tok))) return true;

  // Package runners name a PACKAGE, not a script path (`uvx ruff *`), so a bare
  // concrete operand pins them. Drop the runner's own subcommand first, or
  // `uv run *` would look pinned by the word "run".
  if (PACKAGE_RUNNERS.has(program)) {
    if (rest[0] && RUNNER_SUBCOMMANDS.has(rest[0])) rest = rest.slice(1);
    // A concrete token that FOLLOWS a flag is that flag's value (`--python 3.13`),
    // not the thing being run.
    return !rest.some((tok, i) =>
      !tok.startsWith('-') && !tok.includes('*') && !(i > 0 && rest[i - 1].startsWith('-')));
  }

  return !rest.some(looksLikeScriptPath);
}

// Wrappers that prefix a real command without changing what it does. The head
// that matters is the first token past them (`env -u AUTH_TOKEN birdc *` is a
// birdc grant, not an env one).
const WRAPPERS = new Set(['env', 'sudo', 'nice', 'nohup', 'time', 'command', 'xargs']);

/**
 * The token that actually names the program in a command pattern, seeing through
 * wrappers. `undefined` when the pattern does not name one (a leading `*`, i.e. a
 * substring matcher that could target any command).
 */
export function commandHead(commandPattern: string): string | undefined {
  const tokens = commandPattern.trim().split(/\s+/).filter(Boolean);
  const head = effectiveHead(tokens);
  return head && !head.includes('*') ? head.replace(/.*\//, '') : undefined;
}

/** The token that actually names the program, seeing through wrappers. */
function effectiveHead(tokens: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (WRAPPERS.has(tok)) {
      // Skip the wrapper's own flags and VAR=value assignments.
      while (i + 1 < tokens.length && (tokens[i + 1].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i + 1]))) {
        // `env -u NAME` takes an argument; step over it too.
        if (tokens[i + 1] === '-u' && i + 2 < tokens.length) i++;
        i++;
      }
      continue;
    }
    return tok;
  }
  return undefined;
}

/**
 * True when a pattern leaves the SUBCOMMAND position wildcarded, so it grants
 * verbs its own text never names: `birdc *` grants `birdc reply`, `gh *` grants
 * `gh release delete`.
 *
 * This is the blind spot in `looksEffectful`, which reads the literal pattern
 * text: it flags the narrow `birdc reply *` while staying silent on the strictly
 * broader `birdc *`, so the wider grant drew the weaker warning. Reported
 * separately (not folded into `looksEffectful`) because the honest claim is "we
 * cannot tell what this grants", not "this looks irreversible".
 */
export function grantsUnnamedSubcommands(commandPattern: string): boolean {
  const tokens = commandPattern.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const head = effectiveHead(tokens);
  if (!head || head.includes('*')) return false;
  const program = head.replace(/.*\//, '');
  if (READ_ONLY_HEADS.has(program) || NO_SUBCOMMAND_HEADS.has(program)) return false;
  // Only the first argument matters: once a subcommand is named (`git ... log *`),
  // the trailing wildcard just widens that subcommand's arguments, not the verb.
  const firstArg = tokens[tokens.indexOf(head) + 1];
  return firstArg === '*';
}
