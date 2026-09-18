/**
 * Unescape a JSON string from environment variable
 * Handles escaped quotes and other escape sequences that might be present
 * when JSON is stored in .env files
 * 
 * @param value The potentially escaped JSON string
 * @returns The unescaped string ready for JSON parsing
 */
export function unescapeJsonEnvVar(value: string): string {
  if (!value || typeof value !== 'string') {
    return value;
  }

  // Check if the value looks like it might be escaped JSON
  if (!value.includes('\\')) {
    return value;
  }

  // Remove one transport-escaping layer. Keep single JSON escapes such as
  // `\n` intact: turning them into literal control characters before
  // JSON.parse would make an otherwise valid JSON string invalid.
  return value
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Parse a JSON environment variable, handling escaped strings
 * 
 * @param value The environment variable value
 * @returns Parsed JSON object or null if parsing fails
 */
export function parseJsonEnvVar<T = unknown>(value: string | undefined): T | null {
  if (!value) {
    return null;
  }

  try {
    // First try parsing as-is
    return JSON.parse(value) as T;
  } catch (e) {
    // If that fails, try unescaping first
    try {
      const unescaped = unescapeJsonEnvVar(value);
      return JSON.parse(unescaped) as T;
    } catch (e2) {
      // If both fail, return null
      return null;
    }
  }
}
