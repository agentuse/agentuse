/**
 * Fuzzy string replacement strategies for edit tool
 *
 * These replacers try progressively fuzzier matching strategies to find
 * the old_string in the content. This helps recover from common LLM errors
 * like whitespace differences, indentation issues, etc.
 *
 * Inspired by opencode's edit.ts implementation.
 */

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

/**
 * Levenshtein distance for fuzzy matching
 */
function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') {
    return Math.max(a.length, b.length);
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3;

/**
 * Exact match - tries to find the exact string
 */
export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

/**
 * Line-trimmed matching - matches lines with trimmed whitespace
 */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim();
      const searchTrimmed = searchLines[j].trim();

      if (originalTrimmed !== searchTrimmed) {
        matches = false;
        break;
      }
    }

    if (matches) {
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1;
      }

      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length;
        if (k < searchLines.length - 1) {
          matchEndIndex += 1; // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex);
    }
  }
};

/**
 * Block anchor matching - uses first and last lines as anchors with similarity matching
 */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');

  if (searchLines.length < 3) {
    return;
  }

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();
  const searchBlockSize = searchLines.length;

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue;
    }

    // Look for the matching last line after this first line
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j });
        break; // Only match the first occurrence of the last line
      }
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return;
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0];
    const actualBlockSize = endLine - startLine + 1;

    let similarity = 0;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2); // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim();
        const searchLine = searchLines[j].trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) {
          continue;
        }
        const distance = levenshtein(originalLine, searchLine);
        similarity += (1 - distance / maxLen) / linesToCheck;

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break;
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0;
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0;
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1;
      }
      let matchEndIndex = matchStartIndex;
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length;
        if (k < endLine) {
          matchEndIndex += 1; // Add newline character except for the last line
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex);
    }
    return;
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate;
    const actualBlockSize = endLine - startLine + 1;

    let similarity = 0;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2); // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim();
        const searchLine = searchLines[j].trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) {
          continue;
        }
        const distance = levenshtein(originalLine, searchLine);
        similarity += 1 - distance / maxLen;
      }
      similarity /= linesToCheck; // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0;
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch;
    let matchStartIndex = 0;
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1;
    }
    let matchEndIndex = matchStartIndex;
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length;
      if (k < endLine) {
        matchEndIndex += 1;
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex);
  }
};

/**
 * Whitespace normalized matching - normalizes all whitespace to single spaces
 */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();
  const normalizedFind = normalizeWhitespace(find);

  // Handle single line matches
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
    } else {
      // Only check for substring matches if the full line doesn't match
      const normalizedLine = normalizeWhitespace(line);
      if (normalizedLine.includes(normalizedFind)) {
        // Find the actual substring in the original line that matches
        const words = find.trim().split(/\s+/);
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
          try {
            const regex = new RegExp(pattern);
            const match = line.match(regex);
            if (match) {
              yield match[0];
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split('\n');
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length);
      if (normalizeWhitespace(block.join('\n')) === normalizedFind) {
        yield block.join('\n');
      }
    }
  }
};

/**
 * Indentation flexible matching - ignores leading indentation differences
 */
export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split('\n');
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) return text;

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
      }),
    );

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n');
  };

  const normalizedFind = removeIndentation(find);
  const contentLines = content.split('\n');
  const findLines = find.split('\n');

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n');
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

/**
 * Trimmed boundary matching - tries matching with trimmed leading/trailing whitespace
 */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return;
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split('\n');
  const findLines = find.split('\n');

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');

    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
};

/**
 * Line ending normalized - handles \r\n vs \n differences
 */
export const LineEndingNormalizedReplacer: Replacer = function* (content, find) {
  // Normalize line endings in both
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const normalizedFind = find.replace(/\r\n/g, '\n');

  if (normalizedFind !== find && normalizedContent.includes(normalizedFind)) {
    // Find the actual match in original content
    const index = normalizedContent.indexOf(normalizedFind);
    if (index !== -1) {
      // Map back to original content position
      let originalIndex = 0;
      let normalizedIndex = 0;
      while (normalizedIndex < index) {
        if (content[originalIndex] === '\r' && content[originalIndex + 1] === '\n') {
          originalIndex += 2;
          normalizedIndex += 1;
        } else {
          originalIndex++;
          normalizedIndex++;
        }
      }
      // Calculate original length
      let length = 0;
      let normalizedLength = 0;
      while (normalizedLength < normalizedFind.length) {
        if (content[originalIndex + length] === '\r' && content[originalIndex + length + 1] === '\n') {
          length += 2;
          normalizedLength += 1;
        } else {
          length++;
          normalizedLength++;
        }
      }
      yield content.substring(originalIndex, originalIndex + length);
    }
  }
};

/**
 * All replacers in order of preference (exact to fuzzy)
 */
export const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  TrimmedBoundaryReplacer,
  LineEndingNormalizedReplacer,
];

export interface ReplaceResult {
  success: true;
  matchedString: string;
  newContent: string;
  replacerUsed: string;
}

export interface ReplaceError {
  success: false;
  error: string;
}

/**
 * Try to replace old_string with new_string in content using fuzzy matching
 *
 * Returns the matched string from content and the new content with replacement applied.
 * Tries exact match first, then falls back to progressively fuzzier strategies.
 */
export function fuzzyReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false
): ReplaceResult | ReplaceError {
  if (oldString === newString) {
    return { success: false, error: 'oldString and newString must be different' };
  }

  const replacerNames = [
    'exact',
    'line-trimmed',
    'block-anchor',
    'whitespace-normalized',
    'indentation-flexible',
    'trimmed-boundary',
    'line-ending-normalized',
  ];

  for (let i = 0; i < REPLACERS.length; i++) {
    const replacer = REPLACERS[i];
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) continue;

      if (replaceAll) {
        return {
          success: true,
          matchedString: search,
          newContent: content.split(search).join(newString),
          replacerUsed: replacerNames[i],
        };
      }

      // For single replacement, check for ambiguity
      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) {
        // Multiple matches found - ambiguous
        continue;
      }

      return {
        success: true,
        matchedString: search,
        newContent: content.substring(0, index) + newString + content.substring(index + search.length),
        replacerUsed: replacerNames[i],
      };
    }
  }

  // Check if we found matches but they were all ambiguous
  for (const replacer of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      if (content.indexOf(search) !== -1) {
        const occurrences = content.split(search).length - 1;
        return {
          success: false,
          error: `Found ${occurrences} matches for oldString. Use replace_all=true or provide more context in old_string.`,
        };
      }
    }
  }

  return { success: false, error: 'oldString not found in content' };
}
