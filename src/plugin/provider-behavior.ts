import { resolveModelProvider } from '../utils/model-utils';
import { createProviderPluginContext, getProviderPlugin } from './provider-runtime';
import type { PromptContribution } from './types';

function modelId(model: string): string {
  const colon = model.indexOf(':');
  return colon === -1 ? model : model.slice(colon + 1);
}

export interface ProviderSystemMessage {
  role: string;
  content: string;
  providerContribution?: { providerId: string; id: string; portable: boolean };
}

async function systemContributions(providerId: string, model: string): Promise<PromptContribution[]> {
  const provider = await getProviderPlugin(providerId);
  if (!provider?.prompts?.system) return [];
  return provider.prompts.system(createProviderPluginContext(provider, modelId(model)));
}

export async function applyProviderSystemMessages<T extends { role: string; content: string }>(
  messages: T[],
  model: string,
): Promise<Array<T | ProviderSystemMessage>> {
  const neutral = messages.filter((message) => {
    const owned = (message as T & ProviderSystemMessage).providerContribution;
    return !owned || owned.portable;
  });
  const providerId = resolveModelProvider(model);
  const additions = await systemContributions(providerId, model);
  const tagged = additions.map((contribution): ProviderSystemMessage => ({
    role: 'system',
    content: contribution.content,
    providerContribution: {
      providerId,
      id: contribution.id,
      portable: contribution.portable ?? false,
    },
  }));
  const prepend = tagged.filter((_, index) => (additions[index]?.position ?? 'prepend') === 'prepend');
  const append = tagged.filter((_, index) => additions[index]?.position === 'append');
  return [...prepend, ...neutral, ...append];
}

export interface HelperSystemPrompt {
  instructions: string;
  extraSystem?: string | undefined;
}

export async function providerHelperSystemPrompt(model: string, role: string): Promise<HelperSystemPrompt> {
  const provider = await getProviderPlugin(resolveModelProvider(model));
  if (!provider?.prompts?.helper) return { instructions: role };
  const contributions = await provider.prompts.helper({
    ...createProviderPluginContext(provider, modelId(model)),
    role,
  });
  if (contributions.length === 0) return { instructions: role };
  const [instructions, ...extra] = contributions;
  return {
    instructions: instructions!.content,
    ...(extra.length > 0 && { extraSystem: extra.map((item) => item.content).join('\n\n') }),
  };
}

export async function providerMediaSupport(model: string): Promise<{ image: boolean; pdf: boolean } | undefined> {
  return (await getProviderPlugin(resolveModelProvider(model)))?.media;
}

export async function providerUsesAnthropicProtocol(model: string): Promise<boolean> {
  return (await getProviderPlugin(resolveModelProvider(model)))?.transport.kind === 'anthropic-messages';
}
