import type { ComponentChildren } from 'preact';

export function ErrorBanner(props: { errors: Array<{ projectId: string; storeName?: string; message: string }> }) {
  if (props.errors.length === 0) return null;
  return (
    <InlineError>
      {props.errors.map((err, index) => (
        <div key={index}>
          {err.projectId}{err.storeName ? `/${err.storeName}` : ''}: {err.message}
        </div>
      ))}
    </InlineError>
  );
}

/**
 * One-off failure banner. Every inline "failed to load" message goes through
 * this so the role="alert" is never forgotten; `class` picks the page-scoped
 * style the call site already used. A div, not a p, because some banners wrap
 * a list of per-project failures.
 */
export function InlineError(props: { class?: string; children: ComponentChildren }) {
  return <div class={props.class ?? 'errors'} role="alert">{props.children}</div>;
}
