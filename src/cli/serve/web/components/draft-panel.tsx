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
export type DraftFileTab = 'changes' | 'diff' | 'source';

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

export function DraftPanel(props: {
  /** Row 1, left: the file this page is about, its version, and its state. */
  filePath: string;
  versionLabel: string;
  pill: ComponentChildren;
  /** Row 1, right: the accepting and discarding actions. */
  actions: ComponentChildren;
  /** Row 1, right of the actions: quiet links out. */
  links?: ComponentChildren;
  /** Row 2, left: the standing facts this page is working from. */
  meta: ComponentChildren;
  /** Row 2, right: the session's context and cost. */
  tokens?: ComponentChildren;
  /** Row 2, full width: capability changes, when this revision has any. */
  capabilityNote?: ComponentChildren;
  /** Row 2, full width: something the operator has to act on, e.g. a question
   *  the author stopped to ask. */
  notice?: ComponentChildren;
  /** Badge on the Diff tab, e.g. "+3 −1". */
  diffBadge?: ComponentChildren;
  /** Short note beside the tabs, e.g. "no capability changes". */
  headerNote?: ComponentChildren;
  baseSource?: string | undefined;
  source: string;
  tab: DraftFileTab;
  onTab: (tab: DraftFileTab) => void;
  /** A turn is producing steps right now; Changes carries a live dot. */
  running?: boolean;
  exchange: ComponentChildren;
  composer: ComponentChildren;
  error?: string | null | undefined;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The Changes tab manages its own scroll: it pins to the newest turn, and
    // resetting to the top here would fight it.
    if (props.tab !== 'changes' && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [props.source, props.tab]);

  // This page is a workspace, not a document: it claims the space the shell has
  // left and scrolls inside itself. The flag turns the whole chain above it
  // (root, app, shell, route) into height-constrained flex boxes for as long as
  // this page is mounted, so the panel adapts to whatever chrome sits above it
  // rather than assuming a height. Every other route keeps document scroll.
  useEffect(() => {
    document.documentElement.setAttribute('data-page', 'draft-panel');
    return () => document.documentElement.removeAttribute('data-page');
  }, []);

  const tabButton = (id: DraftFileTab, label: string, badge?: ComponentChildren) => (
    <button
      type="button"
      role="tab"
      aria-selected={props.tab === id}
      class={props.tab === id ? 'is-active' : ''}
      onClick={() => props.onTab(id)}
    >
      {label}
      {badge !== undefined && badge !== false && <span class="draft-tab-badge">{badge}</span>}
    </button>
  );

  return (
    <div class="page-draft">
      <header class="draft-header">
        <div class="draft-header-row">
          <div class="draft-identity">
            <code>{props.filePath}</code>
            <span class="draft-file-version">{props.versionLabel}</span>
            {props.pill}
          </div>
          <div class="draft-header-actions">
            {props.links}
            {props.actions}
          </div>
        </div>
        <div class="draft-header-row is-meta">
          <div class="draft-meta">{props.meta}</div>
          {props.tokens}
        </div>
        {props.capabilityNote && <p class="draft-capability-note">{props.capabilityNote}</p>}
        {props.notice && <p class="draft-waiting" role="status">{props.notice}</p>}
      </header>
      <div class="draft-tabs" role="tablist" aria-label="Draft view">
        {tabButton('changes', 'Changes', props.running ? <span class="draft-tab-dot" aria-label="running" /> : undefined)}
        {tabButton('diff', 'Diff', props.diffBadge)}
        {tabButton('source', 'Source')}
        {/* A Test run tab sat here. Disabled pending an MCP-aware mock scope:
            today's scopes only ground bash-fenced agents, and an MCP-first
            agent would either be fully fabricated or fire a real send. The
            server route and the shared mock helpers are still in place. */}
        {props.headerNote && <span class="draft-tabs-note">{props.headerNote}</span>}
      </div>
      <div class={`draft-file-scroll${props.tab === 'changes' ? ' is-changes' : ''}`} ref={bodyRef}>
        {props.tab === 'source'
          ? <pre class="draft-file-body" aria-label="Agent source">{props.source}</pre>
          : props.tab === 'changes'
            ? props.exchange
            : <DraftDiff baseSource={props.baseSource} source={props.source} />}
      </div>
      {props.error && <p class="draft-error" role="alert">{props.error}</p>}
      {props.composer}
    </div>
  );
}
