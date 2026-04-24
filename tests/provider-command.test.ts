import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createProviderCommand } from '../src/cli/auth';
import { logger } from '../src/utils/logger';

describe('createProviderCommand', () => {
  let errorSpy: ReturnType<typeof spyOn> | undefined;
  let exitSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
  });

  it('rejects bedrock as a reserved custom provider name', async () => {
    const command = createProviderCommand();
    errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as any);

    await expect(
      command.parseAsync(['add', 'bedrock', '--url', 'http://localhost:11434/v1'], { from: 'user' })
    ).rejects.toThrow('process.exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      "Cannot use reserved provider name 'bedrock'. Reserved: anthropic, openai, openrouter, demo, bedrock"
    );
  });
});