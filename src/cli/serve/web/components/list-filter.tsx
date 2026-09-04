/** Text filter above a list. Same shape as the agents page filter, shared so
 *  the stores pages do not grow a second one that drifts from it. */
export function ListFilter(props: {
  value: string;
  onInput: (value: string) => void;
  placeholder: string;
  label: string;
  wide?: boolean;
}) {
  return (
    <div class={`list-filter${props.wide ? ' wide' : ''}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label}
        onInput={(event) => props.onInput((event.currentTarget as HTMLInputElement).value)}
      />
      {props.value && (
        <button type="button" class="list-filter-clear" aria-label="Clear filter" onClick={() => props.onInput('')}>×</button>
      )}
    </div>
  );
}
