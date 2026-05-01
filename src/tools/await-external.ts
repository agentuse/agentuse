import type { Tool } from 'ai';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { SuspendSignal } from '../runner/suspend';

const DEFAULT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

function parseTimeout(value?: string): number {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const match = value.match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!match) return DEFAULT_TIMEOUT_MS;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };
  return amount * multipliers[unit];
}

function getResumeUrl(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  const base = process.env.AGENTUSE_RESUME_PUBLIC_URL ?? process.env.AGENTUSE_SERVE_URL ?? 'http://127.0.0.1:12233';
  return `${base.replace(/\/$/, '')}/resume/${sessionId}`;
}

export function createAwaitExternalTool(sessionId?: string): Tool {
  return {
    description: 'Suspend the current agent run until an external system posts a result back to the resume endpoint.',
    inputSchema: z.object({
      prompt: z.string().describe('Human-readable description of what external event or decision is needed'),
      notify: z.object({
        url: z.string().url().describe('Webhook URL to notify when the run suspends'),
        method: z.enum(['POST', 'PUT']).optional().describe('HTTP method for the notification webhook'),
        headers: z.record(z.string()).optional().describe('Optional notification headers'),
        bodyTemplate: z.unknown().optional().describe('Optional JSON body fields merged into the suspension envelope')
      }),
      payload: z.unknown().optional().describe('Optional context for the external receiver'),
      timeout: z.string().optional().describe('Suspension timeout like 24h or 7d')
    }),
    execute: async ({ prompt, notify, payload, timeout }: {
      prompt: string;
      notify: {
        url: string;
        method?: 'POST' | 'PUT';
        headers?: Record<string, string>;
        bodyTemplate?: unknown;
      };
      payload?: unknown;
      timeout?: string;
    }) => {
      const expiresAt = Date.now() + parseTimeout(timeout);
      const resumeToken = randomBytes(24).toString('base64url');
      const resumeUrl = getResumeUrl(sessionId);
      const envelope = {
        ...(typeof notify.bodyTemplate === 'object' && notify.bodyTemplate !== null ? notify.bodyTemplate : {}),
        type: 'agentuse.suspend',
        sessionId,
        prompt,
        payload,
        resumeUrl,
        resumeToken,
        expiresAt: new Date(expiresAt).toISOString()
      };

      const response = await fetch(notify.url, {
        method: notify.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(notify.headers ?? {})
        },
        body: JSON.stringify(envelope)
      });

      if (!response.ok) {
        throw new Error(`await_external notifier failed: ${response.status} ${response.statusText}`);
      }

      throw new SuspendSignal({
        kind: 'await_external',
        prompt,
        channel: 'webhook',
        expiresAt,
        resumeToken,
        notification: {
          type: 'webhook',
          url: notify.url
        }
      });
    }
  };
}
