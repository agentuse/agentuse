/** Disposable OpenAI-compatible streaming server for dashboard creation E2E. */
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) throw new Error('Pass a valid port');

let requests = 0;

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/requests') {
      return Response.json({ requests });
    }
    if (url.pathname !== '/v1/chat/completions') return new Response('Not found', { status: 404 });

    requests += 1;
    const body = await request.json() as { messages?: Array<{ role?: string; content?: unknown; name?: string }> };
    const submittedSource = (body.messages ?? []).some((message) => message.role === 'tool');
    const prompt = (body.messages ?? [])
      .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
      .join('\n');
    const runtimeBlock = /<available_runtime_models>\s*([\s\S]*?)\s*<\/available_runtime_models>/i.exec(prompt)?.[1] ?? '';
    const runtimeModels = runtimeBlock.split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
    // Mechanical summarization/review should not inherit the stronger model
    // used to author the file. This also proves the two choices stay separate.
    const model = runtimeModels.find((candidate) => candidate === 'openai:gpt-5.4-mini')
      ?? runtimeModels[0]
      ?? 'openai:gpt-5.4-mini';
    const review = prompt.includes('Review yesterday');
    const name = review ? 'Review Yesterday Work' : 'Summarize New Support Tickets Every Morning';
    const description = review
      ? 'Review recent work and identify important follow-up'
      : 'Summarize support tickets and highlight urgent replies';
    const task = review
      ? 'Review yesterday’s work and identify the most important follow-up.'
      : 'Summarize new support tickets every morning and highlight urgent replies.';
    const content = `---\nname: ${name}\nmodel: ${model}\ndescription: ${description}\n---\n\n## Task\n\n${task}\n\n## Output\n\nReturn a concise result with the most urgent or important item first.\n`;
    const created = Math.floor(Date.now() / 1000);
    const responseText = 'Created the agent';
    const contentParts = responseText.match(/[\s\S]{1,80}/g) ?? [responseText];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        if (!submittedSource) {
          const toolCall = {
            id: 'author-e2e',
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{
                  index: 0,
                  id: `submit-agent-source-${requests}`,
                  type: 'function',
                  function: {
                    name: 'submit_agent_source',
                    arguments: JSON.stringify({
                      name,
                      filename: review ? 'review-yesterday-work.agentuse' : 'summarize-new-support-tickets-every-morning.agentuse',
                      source: content,
                    }),
                  },
                }],
              },
              finish_reason: null,
            }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolCall)}\n\n`));
          await Bun.sleep(150);
          const finishToolCall = {
            id: 'author-e2e',
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishToolCall)}\n\ndata: [DONE]\n\n`));
          controller.close();
          return;
        }
        for (const part of contentParts) {
          const chunk = { id: 'author-e2e', object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: part }, finish_reason: null }] };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          await Bun.sleep(150);
        }
        const finish = {
          id: 'author-e2e',
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  },
});

console.log(`author server ready on ${port}`);
