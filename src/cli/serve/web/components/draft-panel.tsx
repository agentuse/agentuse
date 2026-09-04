import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { revisionLineDiff } from '../lib/revision-diff';

/**
 * The draft-and-refine surface, shared by agent creation, an idea picked from
 * discovery, and a revision of an agent that already exists.
 *
 * The file is the centre of the page and the composer under it is a way to ask
 * for a change to that file, never a chat: every accepted turn produces a new
 * numbered version with a diff, and nothing reaches the project until the
 * operator presses the primary action in the top bar.
 */
export type DraftFileTab = 'diff' | 'source' | 'test';

export interface DraftExchangeTurn {
  /** What the operator asked for. Absent on the first version. */
  request?: string | undefined;
  /** The author's short reply for this version. */
  reply?: string | undefined;
}

export function DraftStatusPill(props: { label: string; tone: 'draft' | 'running' | 'done' | 'error' }) {
  return <span class={`draft-pill is-${props.tone}`}>{props.label}</span>;
}

/** Counts shown next to the version label: how much this version changed. */
export function diffChangeCounts(lines: ReturnType<typeof revisionLineDiff>): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === 'add').length,
    removed: lines.filter((line) => line.kind === 'remove').length,
  };
}

function DraftDiff(props: { baseSource: string | undefined; source: string }) {
  const lines = useMemo(
    () => (props.baseSource === undefined ? [] : revisionLineDiff(props.baseSource, props.source)),
    [props.baseSource, props.source],
  );
  if (lines.length === 0) {
    return <pre class="draft-file-body" aria-label="Agent source">{props.source}</pre>;
  }
  return (
    <pre class="draft-file-body is-diff" aria-label="Agent source changes">
      {lines.map((line, index) => (
        <span class={`is-${line.kind}`} key={`${index}-${line.text}`}>
          {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : line.kind === 'same' ? '  ' : ''}
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

export function DraftComposer(props: {
  placeholder: string;
  hint: string;
  busy: boolean;
  disabled?: boolean;
  onSend: (prompt: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const prompt = value.trim();
    if (!prompt || props.busy || props.disabled) return;
    setValue('');
    void props.onSend(prompt);
  };
  return (
    <div class="draft-composer">
      <span class="draft-composer-label">Request a change</span>
      <textarea
        ref={ref}
        value={value}
        placeholder={props.placeholder}
        disabled={props.busy || props.disabled}
        onInput={(event) => setValue((event.target as HTMLTextAreaElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div class="draft-composer-foot">
        <span class="draft-composer-hint"><kbd>⌘⏎</kbd> {props.hint}</span>
        <button
          type="button"
          class="draft-primary"
          disabled={!value.trim() || props.busy || props.disabled}
          aria-busy={props.busy}
          onClick={send}
        >
          {props.busy ? 'Working…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

export function DraftExchange(props: { turns: DraftExchangeTurn[] }) {
  const turns = props.turns.filter((turn) => turn.request || turn.reply);
  if (turns.length === 0) return null;
  return (
    <div class="draft-exchange">
      {turns.map((turn, index) => (
        <div class="draft-exchange-turn" key={index}>
          {turn.request && <div class="draft-exchange-request">{turn.request}</div>}
          {turn.reply && <div class="draft-exchange-reply">{turn.reply}</div>}
        </div>
      ))}
    </div>
  );
}

export function DraftPanel(props: {
  breadcrumb: ComponentChildren;
  pill: ComponentChildren;
  /** Top-bar actions: discard on the left, the accepting action on the right. */
  actions: ComponentChildren;
  /** Left column: the brief for a new agent, or the run evidence for a revision. */
  aside: ComponentChildren;
  filePath: string;
  versionLabel: string;
  /** Short line above the tabs, e.g. "Changes since draft 1". */
  changeLabel: ComponentChildren;
  baseSource?: string | undefined;
  source: string;
  tab: DraftFileTab;
  onTab: (tab: DraftFileTab) => void;
  /** Rendered in place of the file body when the Test run tab is active. */
  testRun?: ComponentChildren;
  /** Hidden when the surface has no mock-run support. */
  showTestTab?: boolean;
  exchange: ComponentChildren;
  composer: ComponentChildren;
  error?: string | null | undefined;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [props.source, props.tab]);

  return (
    <div class="page-draft">
      <div class="draft-topbar">
        <div class="draft-breadcrumb">{props.breadcrumb}{props.pill}</div>
        <div class="draft-topbar-actions">{props.actions}</div>
      </div>
      <div class="draft-columns">
        <aside class="draft-aside">{props.aside}</aside>
        <section class="draft-main">
          <div class="draft-file">
            <div class="draft-file-head">
              <div class="draft-file-id">
                <code>{props.filePath}</code>
                <span class="draft-file-version">{props.versionLabel}</span>
              </div>
              <div class="draft-file-meta">
                <span class="draft-file-changes">{props.changeLabel}</span>
                <div class="draft-tabs" role="tablist" aria-label="Draft view">
                  <button type="button" role="tab" aria-selected={props.tab === 'diff'} class={props.tab === 'diff' ? 'is-active' : ''} onClick={() => props.onTab('diff')}>Diff</button>
                  <button type="button" role="tab" aria-selected={props.tab === 'source'} class={props.tab === 'source' ? 'is-active' : ''} onClick={() => props.onTab('source')}>Source</button>
                  {props.showTestTab && (
                    <button type="button" role="tab" aria-selected={props.tab === 'test'} class={props.tab === 'test' ? 'is-active' : ''} onClick={() => props.onTab('test')}>Test run</button>
                  )}
                </div>
              </div>
            </div>
            <div class="draft-file-scroll" ref={bodyRef}>
              {props.tab === 'test'
                ? props.testRun
                : props.tab === 'source'
                  ? <pre class="draft-file-body" aria-label="Agent source">{props.source}</pre>
                  : <DraftDiff baseSource={props.baseSource} source={props.source} />}
            </div>
          </div>
          {props.error && <p class="draft-error" role="alert">{props.error}</p>}
          {props.exchange}
          {props.composer}
        </section>
      </div>
    </div>
  );
}
