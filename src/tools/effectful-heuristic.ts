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
