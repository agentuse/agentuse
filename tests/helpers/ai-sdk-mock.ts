type AiSdkErrorExports = Pick<
  typeof import('ai'),
  'APICallError' | 'InvalidToolInputError' | 'RetryError'
>;

/**
 * Runtime error exports pulled in transitively by the runner.
 *
 * Keep these in one typed factory so isolated tests that replace the `ai`
 * module cannot drift behind new runner imports.
 */
export function aiSdkErrorMocks(): AiSdkErrorExports {
  const neverMatches = { isInstance: () => false };
  return {
    APICallError: neverMatches,
    InvalidToolInputError: neverMatches,
    RetryError: neverMatches,
  } as unknown as AiSdkErrorExports;
}
