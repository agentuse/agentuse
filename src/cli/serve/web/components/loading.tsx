/**
 * Shared loading indicator: a small spinner beside a label, announced to
 * screen readers as a status. `wrapClass` picks the container class so the
 * indicator inherits each surface's existing spacing (`empty`, `notice`,
 * `palette-empty`, `learnings-empty`, …).
 */
export function Loading(props: { label: string; wrapClass?: string }) {
  return (
    <div class={`${props.wrapClass ?? 'empty'} loading`} role="status">
      <span class="loading-spinner" aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  );
}
