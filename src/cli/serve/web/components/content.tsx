import { useMemo } from 'preact/hooks';
import { renderInlineMarkdown, renderLogContentValue } from '../lib/content-html';

/**
 * Where a streamed message can be split so the settled head renders once and
 * only the growing tail is re-parsed per frame: the last paragraph break that
 * is not inside an open code fence. Returns 0 when there is no safe split.
 */
export function settledMarkdownSplit(value: string): number {
  let split = value.lastIndexOf('\n\n');
  while (split > 0) {
    const head = value.slice(0, split);
    const fences = head.split('```').length - 1;
    if (fences % 2 === 0) return split + 2;
    split = value.lastIndexOf('\n\n', split - 1);
  }
  return 0;
}

/**
 * Renders pre-escaped markup from lib/content-html. That module escapes every
 * dynamic value before adding markup, so this is the single sanctioned
 * dangerouslySetInnerHTML choke point.
 *
 * While a message streams in, the typing reveal re-renders this on nearly
 * every animation frame with a slightly longer value. Re-parsing the whole
 * message each time is O(n²) over the stream, so the settled head (everything
 * before the last paragraph break) is parsed once and memoized on its own
 * text; only the short tail is parsed per frame.
 */
export function LogContent(props: { value: string; forceMarkdown?: boolean; streaming?: boolean }) {
  const options = props.forceMarkdown ? { forceMarkdown: true } : undefined;
  const split = props.streaming && props.forceMarkdown ? settledMarkdownSplit(props.value) : 0;
  const head = split > 0 ? props.value.slice(0, split) : '';
  const tail = split > 0 ? props.value.slice(split) : props.value;
  const headHtml = useMemo(() => (head ? renderLogContentValue(head, options) : ''), [head, props.forceMarkdown]);
  const tailHtml = useMemo(() => (tail.trim() ? renderLogContentValue(tail, options) : ''), [tail, props.forceMarkdown]);
  // eslint-disable-next-line react/no-danger
  return <div class="content-render" dangerouslySetInnerHTML={{ __html: headHtml + tailHtml }} />;
}

export function InlineMarkdown(props: { value: string; class?: string }) {
  return <span class={props.class} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(props.value) }} />;
}
