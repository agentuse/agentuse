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

  // Common escape sequences that might appear in .env files
  // Handle double-escaped sequences first (\\n -> \n in the JSON string)
  let result = value
    .replace(/\\"/g, '"');      // Unescape quotes first
  
  // Check if we have double-escaped sequences (e.g., \\\\n)
  if (result.includes('\\\\')) {
    // This means we have double escaping, handle it carefully
    result = result
      .replace(/\\\\n/g, '\\n')   // \\n -> \n (literal backslash-n in JSON)
      .replace(/\\\\r/g, '\\r')   // \\r -> \r
      .replace(/\\\\t/g, '\\t')   // \\t -> \t
      .replace(/\\\\/g, '\\');     // \\ -> \ (do this last)
  } else {
    // Single escaping
    result = result
      .replace(/\\n/g, '\n')      // \n -> newline character
      .replace(/\\r/g, '\r')      // \r -> carriage return
      .replace(/\\t/g, '\t')      // \t -> tab
      .replace(/\\\\/g, '\\');     // \\ -> \
  }
  
  return result;
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

/**
 * Get and parse a JSON environment variable
 * 
 * @param name The environment variable name
 * @returns Parsed JSON object or null if not found or parsing fails
 */
export function getJsonEnvVar<T = unknown>(name: string): T | null {
  return parseJsonEnvVar<T>(process.env[name]);
}