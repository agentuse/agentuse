import { z } from 'zod';

/**
 * Simple date/time tool
 * Returns current date and time in various formats
 */
export default {
  description: 'Get current date and time in various formats',
  parameters: z.object({
    format: z.enum(['iso', 'locale', 'unix', 'utc']).optional()
      .describe('Date format: iso (ISO 8601), locale (local string), unix (timestamp), utc (UTC string). Default: iso')
  }),
  execute: ({ format = 'iso' }) => {
    const now = new Date();

    switch (format) {
      case 'locale':
        return now.toLocaleString();
      case 'unix':
        return now.getTime().toString();
      case 'utc':
        return now.toUTCString();
      case 'iso':
      default:
        return now.toISOString();
    }
  }
};