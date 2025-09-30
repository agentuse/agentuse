import { z } from 'zod';
import axios from 'axios';

/**
 * Example tool that demonstrates:
 * - Using external dependencies (axios)
 * - Async operations
 * - Tool context usage
 * - Error handling
 */
export default {
  description: 'Fetch data from a URL and return the response',
  parameters: z.object({
    url: z.string().url().describe('The URL to fetch'),
    method: z.enum(['GET', 'POST']).optional().describe('HTTP method to use (default: GET)')
  }),
  execute: async ({ url, method = 'GET' }, context?) => {
    // Report progress if context is available
    if (context) {
      context.metadata({
        title: 'Fetching URL',
        progress: 0,
        metadata: { url, method }
      });
    }

    try {
      const response = await axios({
        method,
        url,
        timeout: 5000
      });

      // Report completion
      if (context) {
        context.metadata({
          title: 'Fetch complete',
          progress: 100,
          metadata: { status: response.status }
        });
      }

      return JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: response.data
      }, null, 2);

    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`HTTP error: ${error.response?.status} ${error.message}`);
      }
      throw error;
    }
  }
};