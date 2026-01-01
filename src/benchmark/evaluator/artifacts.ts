import { access, readFile } from 'fs/promises';
import { join } from 'path';
import type { ArtifactExpectation } from '../types.js';

export interface ArtifactCheckResult {
  path: string;
  exists: boolean;
  containsMatch: boolean;
  details?: string;
}

export interface ArtifactsEvalResult {
  valid: boolean;
  checked: number;
  passed: number;
  details: ArtifactCheckResult[];
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if file contains all required strings
 */
async function fileContains(
  path: string,
  values: string[]
): Promise<{ match: boolean; missing: string[] }> {
  try {
    const content = await readFile(path, 'utf-8');
    const lowerContent = content.toLowerCase();
    const missing = values.filter(
      (v) => !lowerContent.includes(v.toLowerCase())
    );
    return { match: missing.length === 0, missing };
  } catch {
    return { match: false, missing: values };
  }
}

/**
 * Evaluate a single artifact expectation
 */
async function evaluateArtifact(
  expectation: ArtifactExpectation,
  baseDir: string
): Promise<ArtifactCheckResult> {
  const fullPath = join(baseDir, expectation.path);

  // Check existence
  const exists = await fileExists(fullPath);

  // If we expect it to not exist
  if (!expectation.exists) {
    return {
      path: expectation.path,
      exists,
      containsMatch: !exists, // Pass if it doesn't exist
      details: exists
        ? 'File exists but should not'
        : 'File correctly does not exist',
    };
  }

  // If we expect it to exist but it doesn't
  if (!exists) {
    return {
      path: expectation.path,
      exists: false,
      containsMatch: false,
      details: 'File does not exist',
    };
  }

  // Check contains if specified
  if (expectation.contains && expectation.contains.length > 0) {
    const { match, missing } = await fileContains(
      fullPath,
      expectation.contains
    );

    return {
      path: expectation.path,
      exists: true,
      containsMatch: match,
      details: match
        ? `File contains all ${expectation.contains.length} required values`
        : `File missing values: ${missing.join(', ')}`,
    };
  }

  // File exists and no content check required
  return {
    path: expectation.path,
    exists: true,
    containsMatch: true,
    details: 'File exists',
  };
}

/**
 * Evaluate all artifact expectations
 */
export async function evaluateArtifacts(
  expectations: ArtifactExpectation[],
  baseDir: string
): Promise<ArtifactsEvalResult> {
  if (expectations.length === 0) {
    return {
      valid: true,
      checked: 0,
      passed: 0,
      details: [],
    };
  }

  const results: ArtifactCheckResult[] = [];

  for (const expectation of expectations) {
    const result = await evaluateArtifact(expectation, baseDir);
    results.push(result);
  }

  const passed = results.filter((r) => r.containsMatch).length;

  return {
    valid: passed === results.length,
    checked: results.length,
    passed,
    details: results,
  };
}
