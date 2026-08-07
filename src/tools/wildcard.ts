export interface StructuredCommand {
  head: string;
  tail: string[];
}

/**
 * Match a string against a wildcard pattern
 * Supports * (any chars) and ? (single char)
 */
export function match(str: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special regex chars
        .replace(/\*/g, '.*') // * becomes .*
        .replace(/\?/g, '.') + // ? becomes .
      '$',
    's' // s flag enables multiline matching
  );
  return regex.test(str);
}

/**
 * Match a string against multiple patterns, returning the matching pattern
 * Patterns are sorted by length (shorter first) to allow specific overrides
 */
export function matchAny(input: string, patterns: Record<string, any>): any {
  // Sort by pattern length (ascending) then alphabetically
  const sorted = Object.entries(patterns).sort((a, b) => {
    const lenDiff = a[0].length - b[0].length;
    if (lenDiff !== 0) return lenDiff;
    return a[0].localeCompare(b[0]);
  });

  let result: any = undefined;

  for (const [pattern, value] of sorted) {
    if (match(input, pattern)) {
      result = value;
    }
  }

  return result;
}

/**
 * Match a structured command against patterns
 * Example: { head: "git", tail: ["push", "origin"] } matches "git push *"
 */
export function matchStructured(
  input: StructuredCommand,
  patterns: Record<string, any>
): any {
  // Sort by pattern length (ascending) then alphabetically
  const sorted = Object.entries(patterns).sort((a, b) => {
    const lenDiff = a[0].length - b[0].length;
    if (lenDiff !== 0) return lenDiff;
    return a[0].localeCompare(b[0]);
  });

  let result: any = undefined;

  for (const [pattern, value] of sorted) {
    const parts = pattern.split(/\s+/);

    // Match head (command name)
    if (!match(input.head, parts[0])) continue;

    // If pattern is just the command name, it matches
    if (parts.length === 1) {
      result = value;
      continue;
    }

    // Match tail (arguments) as a sequence
    if (matchSequence(input.tail, parts.slice(1))) {
      result = value;
    }
  }

  return result;
}

/**
 * Match a sequence of arguments against a sequence of patterns
 * Handles wildcards in argument patterns
 */
function matchSequence(items: string[], patterns: string[]): boolean {
  const memo = new Map<string, boolean>();

  const visit = (itemIndex: number, patternIndex: number): boolean => {
    // Patterns intentionally match a prefix; trailing argv entries are allowed.
    if (patternIndex >= patterns.length) return true;

    const key = `${itemIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    const pattern = patterns[patternIndex];
    let result: boolean;

    // A standalone * spans any number of argv items (including zero), retaining
    // patterns such as `curl * https://example.test/*`. Memoization keeps
    // multiple stars linear in the number of item/pattern states.
    if (pattern === '*') {
      result = visit(itemIndex, patternIndex + 1)
        || (itemIndex < items.length && visit(itemIndex + 1, patternIndex));
    } else {
      // Literal/wildcard-bearing argument patterns are positional. Searching
      // later argv entries widened `npm run *` to include
      // `npm --prefix /outside run ...`.
      result = itemIndex < items.length
        && match(items[itemIndex], pattern)
        && visit(itemIndex + 1, patternIndex + 1);
    }

    memo.set(key, result);
    return result;
  };

  return visit(0, 0);
}
