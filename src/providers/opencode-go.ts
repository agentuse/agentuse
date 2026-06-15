export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_DISPLAY_NAME = 'OpenCode Go';
export const OPENCODE_GO_API_KEY_ENV = 'OPENCODE_GO_API_KEY';
export const OPENCODE_GO_BASE_URL_ENV = 'OPENCODE_GO_BASE_URL';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

export type OpenCodeGoProtocol = 'anthropic' | 'openai-compatible';

export interface OpenCodeGoModel {
  id: string;
  name: string;
  protocol: OpenCodeGoProtocol;
}

export const OPENCODE_GO_MODELS: OpenCodeGoModel[] = [
  { id: 'glm-5.1', name: 'GLM-5.1', protocol: 'openai-compatible' },
  { id: 'glm-5', name: 'GLM-5', protocol: 'openai-compatible' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', protocol: 'openai-compatible' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', protocol: 'openai-compatible' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', protocol: 'openai-compatible' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', protocol: 'openai-compatible' },
  { id: 'mimo-v2.5', name: 'MiMo-V2.5', protocol: 'openai-compatible' },
  { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', protocol: 'openai-compatible' },
  { id: 'minimax-m3', name: 'MiniMax M3', protocol: 'anthropic' },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', protocol: 'anthropic' },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', protocol: 'anthropic' },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max', protocol: 'anthropic' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', protocol: 'anthropic' },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', protocol: 'anthropic' },
];

const OPENCODE_GO_ANTHROPIC_COMPATIBLE_MODELS = new Set(
  OPENCODE_GO_MODELS.filter((model) => model.protocol === 'anthropic').map((model) => model.id)
);

export function getOpenCodeGoProtocol(modelName: string): OpenCodeGoProtocol {
  if (
    OPENCODE_GO_ANTHROPIC_COMPATIBLE_MODELS.has(modelName) ||
    modelName.startsWith('minimax-') ||
    /^qwen\d/.test(modelName)
  ) {
    return 'anthropic';
  }

  return 'openai-compatible';
}

function readEnv(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const value = process.env[name];
  return value && value.trim() !== '' ? value : undefined;
}

export function resolveOpenCodeGoBaseURL(config: { envVar?: string; envSuffix?: string }): string {
  if (config.envVar) {
    const envVarBase = readEnv(`${config.envVar}_BASE_URL`);
    if (envVarBase) return envVarBase;
  }

  if (config.envSuffix) {
    const suffixBase = readEnv(`${OPENCODE_GO_BASE_URL_ENV}_${config.envSuffix}`);
    if (suffixBase) return suffixBase;
  }

  return readEnv(OPENCODE_GO_BASE_URL_ENV) || OPENCODE_GO_BASE_URL;
}
