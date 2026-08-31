import matter from 'gray-matter';
import { z } from 'zod';
import { REASONING_LEVELS } from './model-compatibility';
import { readFile } from 'fs/promises';
import { resolve, basename } from 'path';
import { logger } from './utils/logger';
import { durationSecondsSchema, parseDurationMs } from './utils/duration';
import {
  MODEL_DEFAULT_ENV,
  ModelAliasError,
  resolveAgentModel,
  type ModelResolutionSource,
} from './utils/model-alias';
import { ToolsConfigSchema } from './tools/index.js';
import { ScheduleConfigSchema } from './scheduler/index.js';
import { StoreConfigSchema } from './store/index.js';
import { LearningConfigSchema, legacyLearningConfigNotices } from './learning/index.js';
import { VerifyConfigSchema } from './verify/types.js';
import { SandboxConfigSchema } from './sandbox.js';
import { SkillsConfigSchema, defaultSkillsConfig } from './skill/config.js';

const warnedParserMessages = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedParserMessages.has(key)) return;
  warnedParserMessages.add(key);
  logger.warn(message);
}

function warnExperimentalOnce(key: string, label: string): void {
  warnOnce(
    `experimental:${key}`,
    `[Experimental] ${label} is experimental and may change in future versions.`
  );
}

/**
 * Error thrown when agent configuration is invalid
 * Used for telemetry to track common config issues without exposing sensitive data
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    public field: string,  // e.g., "model", "mcpServers.foo" (for telemetry)
    public issue: string   // Zod error code: "invalid_type", "unrecognized_keys", etc. (for telemetry)
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Schema for MCP server configuration
const MCPServerSchema = z.union([
  // Stdio configuration (has command)
  z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    requiredEnvVars: z.array(z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    toolTimeout: durationSecondsSchema('mcpServers.toolTimeout').optional(),
    connectTimeout: durationSecondsSchema('mcpServers.connectTimeout').optional()
  }),
  // HTTP configuration (has url)
  z.object({
    url: z.string().url().refine(
      (url) => url.startsWith('http://') || url.startsWith('https://'),
      { message: 'URL must use http:// or https:// protocol' }
    ),
    sessionId: z.string().optional(),
    auth: z.object({
      type: z.enum(['bearer']).optional(),
      token: z.string().optional()
    }).optional(),
    headers: z.record(z.string()).optional(),
    requiredEnvVars: z.array(z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    toolTimeout: durationSecondsSchema('mcpServers.toolTimeout').optional(),
    connectTimeout: durationSecondsSchema('mcpServers.connectTimeout').optional()
  })
]);

const ApprovalConfigSchema = z.union([
  z.boolean(),
  z.object({
    // Duration until an unanswered gate expires: bare number = SECONDS, or a
    // suffixed string ("30m", "24h"). Validated here so a typo fails at parse
    // time instead of silently creating a gate that expires in milliseconds.
    timeout: z.union([z.number(), z.string()]).superRefine((value, ctx) => {
      try {
        parseDurationMs(value, { bareUnit: 'seconds', field: 'approval.timeout' });
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }).optional(),
  }).strict()
]);

const CHANNEL_EVENTS = ['approval', 'completion', 'failure'] as const;
const DEFAULT_CHANNEL_EVENTS = [...CHANNEL_EVENTS];
const ChannelEventSchema = z.enum(CHANNEL_EVENTS);
const ChannelEventListSchema = z.union([
  ChannelEventSchema.transform((event) => [event]),
  z.array(ChannelEventSchema).min(1)
]);

const NormalizedSlackChannelSchema = z.object({
  enabled: z.boolean(),
  events: z.array(ChannelEventSchema).min(1),
  channelId: z.string().optional()
}).strict();

const SlackChannelConfigSchema = z.union([
  z.boolean().transform((enabled) => ({
    enabled,
    events: [...DEFAULT_CHANNEL_EVENTS]
  })),
  z.object({
    enabled: z.boolean().optional(),
    events: ChannelEventListSchema.optional(),
    channel_id: z.string().optional()
  }).strict().transform((config) => ({
    enabled: config.enabled ?? true,
    events: config.events ?? [...DEFAULT_CHANNEL_EVENTS],
    ...(config.channel_id && { channelId: config.channel_id })
  }))
]).pipe(NormalizedSlackChannelSchema);

const ChannelsConfigSchema = z.union([
  z.array(z.literal('slack')).min(1).superRefine((providers, ctx) => {
    if (new Set(providers).size !== providers.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channels list must not contain duplicate providers'
      });
    }
  }).transform(() => ({
    slack: {
      enabled: true,
      events: [...DEFAULT_CHANNEL_EVENTS]
    }
  })),
  z.object({
    slack: SlackChannelConfigSchema.optional()
  }).strict().superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channels must enable at least one provider'
      });
    }
  })
]).transform((channels) => channels);

// Schema for agent configuration as per spec
// Supports both mcp_servers (deprecated) and mcpServers (preferred)
const AgentSchema = z.object({
  name: z.string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, 'Name must be alphanumeric with spaces, hyphens, or underscores')
    .optional(),
  // Optional in the schema only: parseAgentContent falls back to the configured
  // default (`models.default` / AGENTUSE_MODEL) and fails with a config error
  // when neither is set, so every parsed agent still carries a concrete model.
  // May be written as an alias (`anthropic:claude-sonnet`, `@fast`), which is
  // resolved at parse time.
  model: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  notes: z.string().optional(),
  // Free-form annotations for developers/tooling (e.g. draft, owner, team).
  // The framework never interprets these keys, it only preserves and surfaces
  // them. This is the sanctioned home for custom keys, which are otherwise
  // stripped from frontmatter.
  metadata: z.record(z.unknown()).optional(),
  // Run timeout: bare number = SECONDS (unchanged), or a suffixed duration
  // string like "10m" / "900s". Normalized to whole seconds at parse time.
  timeout: durationSecondsSchema('timeout').optional(),
  maxSteps: z.number().positive().int().optional(),
  // Per-response output-token ceiling (max_tokens). Optional: unset, first-class
  // Anthropic models default to their real registry limit capped at 32000, other
  // providers use the SDK default. Raise this for an agent that must emit a large
  // single response or write a big file in one tool call; it's clamped to the
  // model's real output limit when known.
  maxOutputTokens: z.number().positive().int().optional(),
  // Provider-agnostic reasoning effort (preferred). Named to match the AI SDK's
  // top-level `reasoning` param, and to stay distinct from the nested
  // `openai.reasoningEffort` escape hatch. The SDK maps one level to each
  // provider's native control: Anthropic -> a thinking budget (a % of
  // maxOutputTokens), OpenAI -> its own reasoningEffort. Prefer this over the
  // provider-specific `anthropic.thinking` / `openai.reasoningEffort` below.
  // It engages (and bills) reasoning tokens at output rates. `none` explicitly
  // disables reasoning; omit the key to use the model default.
  reasoning: z.enum(REASONING_LEVELS).optional(),
  openai: z.object({
    reasoningEffort: z.enum(REASONING_LEVELS).optional(),
    // Request a streamed natural-language summary of the model's reasoning
    // (Responses API). Without it, reasoning is encrypted and never surfaces as
    // text — so this is what makes reasoning visible in the session trace.
    reasoningSummary: z.enum(['auto', 'detailed']).optional(),
    textVerbosity: z.enum(['low', 'medium', 'high']).optional(),
    promptCacheKey: z.string().min(1).max(64).optional(),
    promptCacheRetention: z.enum(['in_memory', '24h']).optional()
  }).strict().optional(),
  anthropic: z.object({
    // Claude extended thinking. Off by default: enabling it generates new
    // thinking tokens billed at OUTPUT rates (min budget 1024), a real cost
    // increase — so it's an explicit opt-in. When set, Claude streams its
    // reasoning, which shows up inline in the session trace.
    thinking: z.object({
      budgetTokens: z.number().int().min(1024)
    }).strict().optional()
  }).strict().optional(),
  mcp_servers: z.record(MCPServerSchema).optional(),  // Deprecated: use mcpServers
  mcpServers: z.record(MCPServerSchema).optional(),   // Preferred: camelCase
  subagents: z.array(z.object({
    path: z.string(),
    name: z.string().optional(),
    maxSteps: z.number().optional()
  })).optional(),
  // Advisory cross-run ordering: agents whose output this one consumes
  // (typically via a shared store). Display/graph metadata only — the runner
  // and scheduler never act on it. Paths resolve relative to this agent file.
  dependsOn: z.union([
    z.string().min(1),
    z.array(z.string().min(1))
  ]).optional(),
  tools: ToolsConfigSchema.optional(),
  // Tool-call intent phrases: an optional `intent` parameter is injected into
  // every tool schema so the model states what each call is trying to achieve;
  // the CLI and web session views show it as the call's activity label. On by
  // default; `intent: false` keeps tool schemas pristine (e.g. for providers or
  // third-party tools that are sensitive to extra parameters).
  intent: z.boolean().optional(),
  schedule: ScheduleConfigSchema.optional(),
  // Store configuration: true for isolated store, string for shared store
  store: StoreConfigSchema.optional(),
  // Agent type: currently only 'manager' is supported
  type: z.enum(['manager']).optional(),
  // Learning configuration: extract and apply learnings from execution
  learning: LearningConfigSchema.optional(),
  // Verify configuration: judge the final output before it ships; on fail,
  // redo it in-session with the judge's critique (up to maxRedos)
  verify: VerifyConfigSchema.optional(),
  // Sandbox configuration: isolated cloud VM for command execution
  sandbox: SandboxConfigSchema.optional(),
  // Skill configuration: auto discovery by default, explicit keys preload skills
  skills: SkillsConfigSchema.optional(),
  // Declarative suspension gate. Enables hidden await_human tooling and
  // injects an approval step so markdown instructions can stay business-only.
  approval: ApprovalConfigSchema.optional(),
  // External collaboration channels. Web approvals are built in; channels
  // configure optional external surfaces such as Slack.
  channels: ChannelsConfigSchema.optional()
}).transform((data) => {
  // Handle backward compatibility: support both mcp_servers and mcpServers.
  // Use ConfigError (not a bare Error) so the outer catch treats it like every
  // other config failure: sanitized field/issue for telemetry rather than an
  // untracked raw Error.
  if (data.mcp_servers && data.mcpServers) {
    throw new ConfigError(
      'Cannot specify both "mcp_servers" and "mcpServers". Use "mcpServers" (camelCase) only.',
      'mcpServers',
      'conflict'
    );
  }

  // A gated command needs an approval gate to derive its lease from. Rather than
  // erroring (the pre-#169 behavior for the old top-level `effects:`), derive it:
  // declaring `tools.bash.gated` implies the approval machinery. An explicit
  // `tools.await_human: true` already provides the gate, so leave that path alone.
  const gatedImpliesApproval =
    (data.tools?.bash?.gated?.length ?? 0) > 0 &&
    !data.approval &&
    data.tools?.await_human !== true;

  // Experimental feature warnings (emit once per feature per process to avoid
  // log spam when the same or many agents are parsed repeatedly, e.g. in serve).
  // These run before the deprecated-key early return so a config using the old
  // mcp_servers key still gets manager/store/learning/sandbox notices.
  if (data.type === 'manager') warnExperimentalOnce('manager', 'Manager agent configuration and orchestration behavior');
  if (data.store) warnExperimentalOnce('store', 'Store configuration and on-disk format');
  if (data.learning) warnExperimentalOnce('learning', 'Learning configuration, capture behavior, and corrections format');
  if (data.verify) warnExperimentalOnce('verify', 'Verify configuration, verdict contract, and redo behavior');
  if (data.sandbox) warnExperimentalOnce('sandbox', 'Sandbox configuration and container execution contract');

  // Normalize the string shorthand so consumers always see an array.
  const dependsOn = data.dependsOn === undefined
    ? undefined
    : Array.isArray(data.dependsOn) ? data.dependsOn : [data.dependsOn];

  // Normalize to mcpServers and warn about deprecation
  if (data.mcp_servers && !data.mcpServers) {
    warnOnce('deprecated:mcp_servers', 'The "mcp_servers" field is deprecated. Please use "mcpServers" (camelCase) instead.');
    return {
      ...data,
      dependsOn,
      mcpServers: data.mcp_servers,
      mcp_servers: undefined,  // Remove deprecated field
      skills: data.skills ?? defaultSkillsConfig(),
      ...(gatedImpliesApproval && { approval: true as const }),
    };
  }

  return {
    ...data,
    dependsOn,
    skills: data.skills ?? defaultSkillsConfig(),
    ...(gatedImpliesApproval && { approval: true as const }),
  };
});

export type AgentConfig = z.infer<typeof AgentSchema> & {
  /**
   * Always a concrete `provider:model[:env]` id: aliases and the configured
   * default are resolved once, at parse time, so nothing downstream (registry
   * limits, cost, session records, provider clients) has to know about aliases.
   */
  model: string;
  /** What the agent file wrote, when `model` came from an alias or a default. */
  modelAlias?: string;
  /** How `model` was determined, when it was not written as a concrete id. */
  modelSource?: ModelResolutionSource;
  /** Ordered concrete candidates carried by an object-form user alias. */
  modelCandidates?: string[];
  /** Process-local cooldown for transient pre-output candidate failures. */
  modelFallbackCooldownMs?: number;
};

/**
 * Resolve the agent's model (alias or configured default) into the concrete id
 * the rest of the codebase expects, reporting failures as config errors so they
 * carry the same field/telemetry framing as any other frontmatter problem.
 */
function withResolvedModel(parsed: z.infer<typeof AgentSchema>): AgentConfig {
  let resolved: ReturnType<typeof resolveAgentModel>;
  try {
    resolved = resolveAgentModel(parsed.model);
  } catch (error) {
    if (error instanceof ModelAliasError) {
      throw new ConfigError(`Invalid agent configuration: ${error.message}`, 'model', 'invalid_alias');
    }
    throw error;
  }

  if (!resolved) {
    throw new ConfigError(
      'Invalid agent configuration: model: no model specified and no default configured. ' +
        'Add `model:` to the agent file, set `models.default` in ~/.agentuse/config.json, ' +
        `or set ${MODEL_DEFAULT_ENV}.`,
      'model',
      'missing'
    );
  }

  return {
    ...parsed,
    model: resolved.model,
    ...(resolved.alias !== undefined &&
      resolved.alias !== resolved.model && { modelAlias: resolved.alias }),
    ...(resolved.source !== 'literal' && { modelSource: resolved.source }),
    ...(resolved.candidates !== undefined && { modelCandidates: resolved.candidates }),
    ...(resolved.cooldownMs !== undefined && { modelFallbackCooldownMs: resolved.cooldownMs }),
  };
}

export interface ParsedAgent {
  name: string;
  config: AgentConfig;
  instructions: string;
  description?: string;
  /** One-time upgrade notices for legacy config forms that still parse with a
   *  narrowed meaning (e.g. `learning: true`). Warned once per agent at parse
   *  time; `agentuse doctor` echoes them so the mapping stays discoverable. */
  configNotices?: string[];
}

/**
 * Parse agent from markdown content with YAML frontmatter
 * @param content The markdown content with YAML frontmatter
 * @param name The name of the agent
 * @returns Parsed agent configuration and instructions
 */
export function parseAgentContent(content: string, name: string): ParsedAgent {
  try {
    // Parse YAML frontmatter. The {} matters: with no options, gray-matter
    // memoizes every result in a module-level cache keyed by the full file
    // content, so long-lived processes retain every version of every file
    // ever parsed. Same rule applies to every matter() call in this repo.
    const { data, content: instructions } = matter(content, {});

    if (data && typeof data === 'object' && 'notifications' in data) {
      throw new ConfigError(
        'Invalid agent configuration: "notifications" has been replaced by "channels". Use channels: [slack] or channels.slack instead.',
        'notifications',
        'deprecated'
      );
    }
    
    // Validate configuration with Zod, then settle the model (alias or default)
    // so every consumer sees a concrete provider:model id.
    const config = withResolvedModel(AgentSchema.parse(data));

    // Legacy learning forms that still parse but with a narrowed (strictly
    // safer) meaning. Detected on the RAW frontmatter — the schema has already
    // normalized the sugar away by now — and warned once per agent, not once
    // per process: a fleet upgrade needs every affected agent named.
    const configNotices = legacyLearningConfigNotices(
      data && typeof data === 'object' ? (data as { learning?: unknown }).learning : undefined,
    );
    for (const notice of configNotices) {
      warnOnce(`learning-legacy:${name}:${notice.slice(0, 40)}`, `${name}: ${notice}`);
    }

    // Return parsed agent (prefer frontmatter name over filename)
    return {
      name: config.name || name,
      config,
      instructions: instructions.trim(),
      ...(config.description && { description: config.description }),
      ...(configNotices.length > 0 && { configNotices })
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Unwrap union failures to the branch that actually says something. A
      // union's own issue is "Invalid input", which hides the named-key or
      // custom message the failing object branch produced (e.g. a mistyped
      // learning.capture addon); surface that branch's issues instead.
      const issues = error.errors.flatMap((issue) => {
        if (issue.code !== z.ZodIssueCode.invalid_union) return [issue];
        const specific = issue.unionErrors.find((branch) =>
          branch.issues.some((i) => i.code !== z.ZodIssueCode.invalid_literal && i.code !== z.ZodIssueCode.invalid_type)
        );
        return specific
          ? specific.issues.map((i) => ({ ...i, path: [...issue.path, ...i.path] }))
          : [issue];
      });
      const firstError = issues[0]!;
      const message = issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      // Sanitize field path: only include top-level field name to avoid exposing user-defined keys
      // e.g., "mcpServers.my-secret-server.command" -> "mcpServers"
      const topLevelField = String(firstError.path[0] ?? 'root');
      throw new ConfigError(
        `Invalid agent configuration: ${message}`,
        topLevelField,
        firstError.code
      );
    }
    throw error;
  }
}

/**
 * Parse agent from markdown file with YAML frontmatter
 * @param filePath Path to the agent markdown file
 * @returns Parsed agent configuration and instructions
 */
export async function parseAgent(filePath: string): Promise<ParsedAgent> {
  try {
    // Validate file extension
    if (!filePath.endsWith('.agentuse')) {
      throw new Error(`Invalid file extension. Agent files must use .agentuse extension (got: ${filePath})`);
    }
    
    // Resolve to absolute path
    const absolutePath = resolve(filePath);
    
    // Read file content
    const content = await readFile(absolutePath, 'utf-8');
    
    // Extract agent name from filename (without .agentuse extension)
    const name = basename(filePath).replace(/\.agentuse$/, '');
    
    // Parse using the content parser
    return parseAgentContent(content, name);
  } catch (error) {
    if ((error as unknown as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }
}
