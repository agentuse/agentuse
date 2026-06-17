import { renderInlineMarkdown, renderLogContentValue } from '../lib/content-html';

/**
 * Renders pre-escaped markup from lib/content-html. That module escapes every
 * dynamic value before adding markup, so this is the single sanctioned
 * dangerouslySetInnerHTML choke point.
 */
export function LogContent(props: { value: string; forceMarkdown?: boolean }) {
  const html = renderLogContentValue(props.value, props.forceMarkdown ? { forceMarkdown: true } : undefined);
  // eslint-disable-next-line react/no-danger
  return <div class="content-render" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function InlineMarkdown(props: { value: string; class?: string }) {
  return <span class={props.class} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(props.value) }} />;
}
