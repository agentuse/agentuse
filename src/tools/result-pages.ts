import { createHash } from 'node:crypto';

/** Stateless UTF-8 pages over an immutable result (or stable jq projection). */
export interface ResultPageRequest {
  action: 'read' | 'jq';
  resultId: string;
  expression?: string | undefined;
  limit?: number | undefined;
  page?: number | undefined;
  pageSizeBytes?: number | undefined;
  contentHash?: string | undefined;
}

export function resultPage(text: string, request: ResultPageRequest, responseLimit: number) {
  const page = request.page ?? 1;
  const requestedSize = request.pageSizeBytes ?? 16_384;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(requestedSize) || requestedSize < 4) {
    throw new Error('RESULT_PAGE_INPUT: page must be positive and pageSizeBytes must be at least 4');
  }
  const totalBytes = Buffer.byteLength(text);
  const contentHash = request.action === 'jq' ? createHash('sha256').update(text).digest('hex') : undefined;
  if (request.contentHash !== undefined && request.contentHash !== contentHash) {
    throw new Error('RESULT_PAGE_CHANGED: query output changed; restart at page 1 with a deterministic expression');
  }
  const base = { action: request.action, resultId: request.resultId,
    ...(request.expression !== undefined && { expression: request.expression }),
    ...(request.limit !== undefined && { limit: request.limit }),
    ...(contentHash !== undefined && { contentHash }) };
  const envelope = (content: string, current: number, total: number, size: number) => ({
    ...base, content,
    pagination: { page: current, totalPages: total, pageSizeBytes: size, totalBytes, hasMore: current < total },
    next: current < total ? { ...base, page: current + 1, pageSizeBytes: size } : null,
  });
  // Reserve worst-case decimal widths and continuation metadata, then account
  // for actual JSON escaping per Unicode code point when cutting each page.
  const metadata = Buffer.byteLength(JSON.stringify(envelope('', Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER, requestedSize)));
  const withNext = Buffer.byteLength(JSON.stringify({ ...envelope('', 1, 2, requestedSize),
    next: { ...base, page: Number.MAX_SAFE_INTEGER, pageSizeBytes: requestedSize } }));
  const wireBudget = responseLimit - Math.max(metadata, withNext) - 64;
  if (wireBudget < 6) throw new Error('RESULT_PAGE_METADATA_TOO_LARGE: query metadata leaves no room for content');
  const size = Math.min(requestedSize, wireBudget);
  const chunks: string[] = [];
  let chunk = '', bytes = 0, wireBytes = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character);
    const wireLength = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + length > size || wireBytes + wireLength > Math.max(size, 6)) {
      chunks.push(chunk); chunk = ''; bytes = 0; wireBytes = 0;
    }
    chunk += character; bytes += length; wireBytes += wireLength;
  }
  chunks.push(chunk);
  if (page > chunks.length) throw new Error(`RESULT_PAGE_RANGE: requested page ${page}, total ${chunks.length}`);
  const result = envelope(chunks[page - 1]!, page, chunks.length, size);
  if (Buffer.byteLength(JSON.stringify(result)) > responseLimit) throw new Error('RESULT_PAGE_METADATA_TOO_LARGE');
  return result;
}
