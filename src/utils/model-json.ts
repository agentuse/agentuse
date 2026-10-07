/**
 * The JSON payload of a model reply: the first fenced block when there is one,
 * otherwise the whole reply. Models often add prose before or after the fence,
 * so the fence is matched anywhere, not only as the entire reply.
 */
export function modelJsonText(reply: string): string {
  const text = reply.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text)?.[1];
  return (fenced ?? text).trim();
}
