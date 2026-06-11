import { memo } from 'preact/compat';
import type { ApprovalLogDetails, ApprovalLogEntry, LogSubagentSession } from '../../types';
import { formatLogTime, isJsonLikeContent, logEntrySignature, storeItemPreview, storeItemTitle, valueAsRecord } from '../lib/format';
import type { StoreItem } from '../../../../store/types';
import { LogContent, InlineMarkdown } from './content';

interface StoreEvent {
  store?: string;
  itemId?: string;
  item?: StoreItem;
  href?: string;
}

function storeToolEvent(entry: ApprovalLogEntry, projectId?: string): StoreEvent | undefined {
  if (!entry.tool?.startsWith('store_')) return undefined;
  if (!entry.message || !isJsonLikeContent(entry.message)) return undefined;
  let payload: Record<string, unknown>;
  try {
    payload = valueAsRecord(JSON.parse(entry.message));
  } catch {
    return undefined;
  }
  const item = valueAsRecord(payload.item) as unknown as StoreItem;
  const store = typeof payload.store === 'string' && payload.store ? payload.store : undefined;
  const itemId = typeof payload.itemId === 'string' && payload.itemId
    ? payload.itemId
    : typeof item.id === 'string' && item.id
      ? item.id
      : undefined;
  const params = new URLSearchParams();
  if (projectId) params.set('project', projectId);
  if (itemId) params.set('highlight', itemId);
  const href = store
    ? `/stores/${encodeURIComponent(store)}${params.toString() ? `?${params.toString()}` : ''}`
    : undefined;
  return {
    ...(store ? { store } : {}),
    ...(itemId ? { itemId } : {}),
    ...(typeof item.id === 'string' ? { item } : {}),
    ...(href ? { href } : {})
  };
}

function StoreEventBlock(props: { event: StoreEvent }) {
  const { event } = props;
  const item = event.item;
  return (
    <div class="store-event">
      <div>
        {event.store && <div class="store-event-store">Store: <code>{event.store}</code></div>}
        {item ? (
          <>
            <div class="store-event-title">{storeItemTitle(item)}</div>
            <div class="store-event-meta">
              {item.type && <span>{item.type}</span>}
              {item.status && <span>{item.status}</span>}
              {event.itemId && <code>{event.itemId}</code>}
            </div>
            <div class="store-event-preview">{storeItemPreview(item)}</div>
          </>
        ) : (
          <div class="store-event-title">{event.itemId ?? 'Store operation'}</div>
        )}
      </div>
      {event.href && <a class="store-event-link" href={event.href}>Open in Store</a>}
    </div>
  );
}

function artifactHref(sessionId: string, artifactPath: string, token: string | undefined): string {
  const encoded = artifactPath.split('/').map(encodeURIComponent).join('/');
  const base = `/sessions/${encodeURIComponent(sessionId)}/artifacts/${encoded}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function artifactName(artifactPath: string): string {
  const parts = artifactPath.split('/');
  return parts[parts.length - 1] || artifactPath;
}

function ApprovalDetailCard(props: { details: ApprovalLogDetails; sessionId: string; token: string | undefined }) {
  const details = props.details;
  const artifactPaths = details.artifactPaths ?? [];
  const decisionLabel = details.decisionStatus
    ? `${details.decisionStatus}${details.decisionReviewer ? ` by ${details.decisionReviewer}` : ''}`
    : '';
  const primary = details.draft
    ? { title: 'Draft', body: <LogContent value={details.draft} forceMarkdown /> }
    : details.artifactUrl
      ? { title: 'Artifact', body: <a class="approval-link" href={details.artifactUrl} target="_blank" rel="noopener noreferrer">{details.artifactUrl}</a> }
      : details.draftUrl
        ? { title: 'Draft', body: <a class="approval-link" href={details.draftUrl} target="_blank" rel="noopener noreferrer">{details.draftUrl}</a> }
        : details.summary
          ? { title: 'Review', body: <LogContent value={details.summary} forceMarkdown /> }
          : undefined;
  const showSummary = Boolean(details.summary) && primary?.title !== 'Review';
  const links = [
    details.draftUrl ? <a class="approval-link" href={details.draftUrl} target="_blank" rel="noopener noreferrer">Open draft</a> : null,
    details.artifactUrl ? <a class="approval-link" href={details.artifactUrl} target="_blank" rel="noopener noreferrer">Open artifact</a> : null,
  ].filter(Boolean);
  const hasContent = details.prompt || primary || details.risk || showSummary || details.context || links.length > 0 || artifactPaths.length > 0 || decisionLabel || details.decisionComment || details.errorMessage;
  if (!hasContent) return null;

  return (
    <div class="approval-card">
      {details.prompt && <div class="approval-question"><InlineMarkdown value={details.prompt} /></div>}
      {artifactPaths.length > 0 && (
        <section class="approval-section approval-artifact">
          <div class="approval-section-title">{artifactPaths.length > 1 ? 'Artifacts' : 'Artifact'}</div>
          <div class="approval-section-body">
            <div class="artifact-tiles">
              {artifactPaths.map((path) => (
                <a
                  key={path}
                  class="artifact-open"
                  href={artifactHref(props.sessionId, path, props.token)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span class="artifact-open-name">{artifactName(path)}</span>
                  <span class="artifact-open-hint">open</span>
                </a>
              ))}
            </div>
          </div>
        </section>
      )}
      {details.context && (
        <section class="approval-section approval-context">
          <div class="approval-section-title">Source context</div>
          <div class="approval-section-body"><LogContent value={details.context} forceMarkdown /></div>
        </section>
      )}
      {primary && (
        <section class="approval-section approval-primary">
          <div class="approval-section-title">{primary.title}</div>
          <div class="approval-section-body">{primary.body}</div>
        </section>
      )}
      {links.length > 0 && (
        <section class="approval-section approval-links">
          <div class="approval-section-title">Links</div>
          <div class="approval-link-row">{links}</div>
        </section>
      )}
      {showSummary && (
        <section class="approval-section approval-secondary">
          <div class="approval-section-title">Why this request</div>
          <div class="approval-section-body"><LogContent value={details.summary!} forceMarkdown /></div>
        </section>
      )}
      {details.risk && (
        <section class="approval-section approval-risk">
          <div class="approval-section-title">Risk / consequence</div>
          <div class="approval-section-body"><LogContent value={details.risk} forceMarkdown /></div>
        </section>
      )}
      {decisionLabel && (
        <section class="approval-section approval-decision">
          <div class="approval-section-title">Decision</div>
          <div class="approval-section-body">{decisionLabel}</div>
        </section>
      )}
      {details.decisionComment && (
        <section class="approval-section approval-secondary">
          <div class="approval-section-title">Comment</div>
          <div class="approval-section-body"><LogContent value={details.decisionComment} forceMarkdown /></div>
        </section>
      )}
      {details.errorMessage && (
        <section class="approval-section approval-risk">
          <div class="approval-section-title">Error</div>
          <div class="approval-section-body">{details.errorMessage}</div>
        </section>
      )}
    </div>
  );
}

function SubagentCard(props: { session: LogSubagentSession }) {
  const s = props.session;
  const inner = (
    <>
      <span class={`chip status ${s.displayStatus}`}>{s.displayStatus}</span>
      <span class="subagent-name">{s.agent.name || s.agent.id}</span>
      <code class="subagent-id">{s.sessionId}</code>
      {s.command && <span class="subagent-command">{s.command}</span>}
    </>
  );
  return s.href
    ? <a class="subagent-event" href={s.href}>{inner}</a>
    : <div class="subagent-event">{inner}</div>;
}

function ToolDetails(props: { details: ApprovalLogDetails }) {
  const details = props.details;
  const rows = [
    details.input ? { label: 'Input', value: details.input } : undefined,
    details.output ? { label: 'Output', value: details.output } : undefined,
    details.errorMessage ? { label: 'Error', value: details.errorMessage } : undefined,
  ].filter((row): row is { label: string; value: string } => Boolean(row));
  if (rows.length === 0) return null;
  return (
    <div class="log-details">
      {rows.map((row) => (
        <div class="log-detail" key={row.label}>
          <div class="log-detail-label">{row.label}</div>
          <div class="log-detail-value"><LogContent value={row.value} /></div>
        </div>
      ))}
    </div>
  );
}

export interface LogEntryProps {
  entry: ApprovalLogEntry;
  expanded: boolean;
  showActions: boolean;
  actionsDisabled: boolean;
  projectId: string | undefined;
  sessionId: string;
  token: string | undefined;
  onToggle: (id: string) => void;
  onAction: (action: 'approve' | 'reject' | 'comment') => void;
}

function LogEntryImpl(props: LogEntryProps) {
  const { entry } = props;
  const isApprovalEntry = Boolean(entry.details?.resumeToken);
  const expandable = entry.type === 'tool' && !isApprovalEntry;
  const expanded = !expandable || entry.status === 'running' || props.expanded;
  const storeEvent = storeToolEvent(entry, props.projectId);
  const spinning = entry.status === 'streaming' || entry.status === 'running';

  const classes = [
    'log-item',
    entry.status ?? '',
    expandable ? 'expandable' : '',
    expanded ? 'expanded' : '',
  ].filter(Boolean).join(' ');

  const toggle = () => {
    if (expandable) props.onToggle(entry.id);
  };

  return (
    <li
      class={classes}
      data-log-id={entry.id}
      data-log-type={entry.type}
      aria-expanded={expandable ? expanded : undefined}
      tabIndex={expandable ? 0 : undefined}
      onClick={(event) => {
        const target = event.target as Element;
        if (target.closest('a') || target.closest('button')) return;
        toggle();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        toggle();
      }}
    >
      <span class="log-time">{formatLogTime(entry.time)}</span>
      <span class="log-marker">{spinning ? <span class="log-spinner" aria-label="streaming" /> : '⋮'}</span>
      <span class="log-main">
        <span class="log-title">{entry.title}</span>
        <span class="log-content">
          {entry.subagentSession && <SubagentCard session={entry.subagentSession} />}
          {storeEvent && <StoreEventBlock event={storeEvent} />}
          {entry.details && (entry.details.resumeToken
            ? <ApprovalDetailCard details={entry.details} sessionId={props.sessionId} token={props.token} />
            : <ToolDetails details={entry.details} />)}
          {entry.message && !storeEvent && !entry.subagentSession && <LogContent value={entry.message} forceMarkdown={entry.type === 'text'} />}
        </span>
        {props.showActions && (
          <div class="log-actions" data-actions-row>
            <div class="log-actions-hint">
              <span class="kbd">⌘⏎</span> approve <span class="kbd">esc</span> reject <span class="kbd">c</span> comment
            </div>
            <div class="log-actions-buttons">
              <button class="primary" disabled={props.actionsDisabled} onClick={() => props.onAction('approve')}>Approve</button>
              <button class="danger" disabled={props.actionsDisabled} onClick={() => props.onAction('reject')}>Reject</button>
              <button disabled={props.actionsDisabled} onClick={() => props.onAction('comment')}>Comment</button>
            </div>
          </div>
        )}
      </span>
    </li>
  );
}

/** Re-render only when the entry content or interactive surface changes. */
export const LogEntry = memo(LogEntryImpl, (prev, next) =>
  logEntrySignature(prev.entry) === logEntrySignature(next.entry) &&
  prev.expanded === next.expanded &&
  prev.showActions === next.showActions &&
  prev.actionsDisabled === next.actionsDisabled &&
  prev.projectId === next.projectId &&
  prev.sessionId === next.sessionId &&
  prev.token === next.token
);
