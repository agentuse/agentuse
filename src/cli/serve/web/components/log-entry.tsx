import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import { useSmoothText } from '../hooks/use-smooth-text';
import type { ApprovalChange, ApprovalLogDetails, ApprovalLogEntry, ApprovalOption, ApprovalReference, LogSubagentSession } from '../../types';
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
    : typeof payload.id === 'string' && payload.id
      ? payload.id
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
            {storeItemPreview(item) && <div class="store-event-preview">{storeItemPreview(item)}</div>}
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

function toolArtifactHref(sessionId: string, artifactPath: string, token: string | undefined): string {
  const encoded = artifactPath.split('/').map(encodeURIComponent).join('/');
  const base = `/sessions/${encodeURIComponent(sessionId)}/tool-artifacts/${encoded}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function artifactName(artifactPath: string): string {
  const parts = artifactPath.split('/');
  return parts[parts.length - 1] || artifactPath;
}

/** Viewable tile for a deliverable saved via `tools__artifact_save`. Shown inline
 *  (not behind the expand toggle) since the link is the whole point of the call. */
function SavedArtifactCard(props: { artifact: NonNullable<ApprovalLogDetails['savedArtifact']>; sessionId: string; token: string | undefined }) {
  const { artifact } = props;
  return (
    <div class="artifact-tiles saved-artifact">
      <a
        class="artifact-open"
        href={artifactHref(props.sessionId, artifact.path, props.token)}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span class="artifact-open-name">{artifact.title || artifactName(artifact.path)}</span>
        <span class="artifact-open-hint">open</span>
      </a>
    </div>
  );
}

function CopyButton(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      class="approval-copy"
      type="button"
      title="Copy to clipboard"
      aria-live="polite"
      onClick={() => {
        navigator.clipboard?.writeText(props.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
    >{copied ? 'copied' : 'copy'}</button>
  );
}

/** The original being responded to, quoted above the changes so the reviewer
 *  reads original → reply in natural order. */
function ReferenceBlock(props: { reference: ApprovalReference }) {
  const ref = props.reference;
  return (
    <section class="approval-section approval-reference">
      <div class="approval-section-title">{ref.label || 'In reply to'}</div>
      <div class="approval-section-body">
        <div class="approval-reference-quote">
          {(ref.author || ref.title) && (
            <div class="approval-reference-head">
              {ref.author && <span class="approval-reference-author">{ref.author}</span>}
              {ref.title && <span class="approval-reference-title">{ref.title}</span>}
            </div>
          )}
          {ref.excerpt && <div class="approval-reference-excerpt"><LogContent value={ref.excerpt} forceMarkdown /></div>}
          {ref.url && <a class="approval-link" href={ref.url} target="_blank" rel="noopener noreferrer">Open original</a>}
        </div>
      </div>
    </section>
  );
}

/** The verbatim actions taken on approval: the first thing a reviewer skims. */
function ChangesBlock(props: { changes: ApprovalChange[] }) {
  return (
    <section class="approval-section approval-changes">
      <div class="approval-section-title">On approval</div>
      <div class="approval-section-body">
        {props.changes.map((change, index) => (
          <div class="approval-change" key={index}>
            <div class="approval-change-head">
              <span class="approval-change-label">{change.label || `Action ${index + 1}`}</span>
              <span class="approval-change-meta">{change.content.length} chars</span>
              <CopyButton text={change.content} />
            </div>
            <div class="approval-change-content"><LogContent value={change.content} forceMarkdown /></div>
          </div>
        ))}
      </div>
    </section>
  );
}

const IMAGE_ARTIFACT_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const HTML_ARTIFACT_RE = /\.(html?)$/i;
const PDF_ARTIFACT_RE = /\.pdf$/i;

/** Image-file path tokens inside gate payload prose. */
const PAYLOAD_IMAGE_PATH_RE = /[\w.~@/-]+\.(?:png|jpe?g|gif|webp|avif)\b/gi;

/**
 * Project-relative image paths mentioned anywhere in the gate payload text.
 * Agents routinely name the media a gate covers (a generated diagram, a
 * downloaded repost image) without filling artifact_paths; surfacing those
 * mentions gives the reviewer the actual image with zero agent cooperation.
 * Authorization stays server-side (serveSessionArtifact containment +
 * denylist); a path that 403s/404s simply hides its tile via onError. SVG is
 * deliberately excluded here: only explicitly declared artifact_paths get the
 * script-capable branches.
 */
function detectPayloadImagePaths(details: ApprovalLogDetails, explicit: string[]): string[] {
  const texts = [
    details.summary,
    details.draft,
    details.context,
    details.risk,
    ...(details.changes ?? []).map((c) => c.content),
  ].filter((v): v is string => typeof v === 'string');
  const seen = new Set(explicit.map((p) => p.replace(/^\.\//, '')));
  const out: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(PAYLOAD_IMAGE_PATH_RE)) {
      const raw = match[0];
      // URL, not a local path: token starting at the //host part, or preceded by a scheme colon.
      if (raw.startsWith('//') || (match.index !== undefined && text[match.index - 1] === ':')) continue;
      const path = raw.replace(/^\.\//, '');
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * Artifact tile + inline image preview for a payload-detected path. Unlike
 * explicit artifact_paths, a detected mention may be stale or a false
 * positive, so the whole item removes itself when the image fails to load.
 */
function DetectedImageItem(props: { path: string; href: string }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div class="artifact-item">
      <div class="artifact-tiles">
        <a class="artifact-open" href={props.href} target="_blank" rel="noopener noreferrer">
          <span class="artifact-open-name">{artifactName(props.path)}</span>
          <span class="artifact-open-hint">open</span>
        </a>
      </div>
      <a class="artifact-preview" href={props.href} target="_blank" rel="noopener noreferrer">
        <img
          class="artifact-preview-img"
          src={props.href}
          alt={artifactName(props.path)}
          loading="lazy"
          onError={() => setHidden(true)}
        />
      </a>
    </div>
  );
}

/** Inline preview widget under an artifact tile: images render directly, HTML
 *  and PDF embed in a height-capped frame. Anything else keeps just the tile. */
function ArtifactPreview(props: { path: string; href: string }) {
  if (IMAGE_ARTIFACT_RE.test(props.path)) {
    return (
      <a class="artifact-preview" href={props.href} target="_blank" rel="noopener noreferrer">
        <img class="artifact-preview-img" src={props.href} alt={artifactName(props.path)} loading="lazy" />
      </a>
    );
  }
  if (HTML_ARTIFACT_RE.test(props.path)) {
    // No allow-same-origin: scripts run against an opaque origin, so the frame
    // cannot read the session token or call the API with the viewer's cookies.
    return <iframe class="artifact-preview-frame" src={props.href} title={artifactName(props.path)} loading="lazy" sandbox="allow-scripts" />;
  }
  if (PDF_ARTIFACT_RE.test(props.path)) {
    // Chrome's built-in PDF viewer does not render inside a sandboxed frame.
    return <iframe class="artifact-preview-frame" src={props.href} title={artifactName(props.path)} loading="lazy" />;
  }
  return null;
}

/**
 * Pick-among-options menu on an approval gate. Interactive (radio cards) while
 * the gate is pending and actionable; a static list afterwards, with the
 * decided option marked. The recommended option is preselected by the page.
 */
function OptionsBlock(props: {
  options: ApprovalOption[];
  selected?: string | undefined;
  decided?: string | undefined;
  onSelect?: ((id: string) => void) | undefined;
}) {
  const interactive = Boolean(props.onSelect);
  return (
    <section class="approval-section approval-options">
      <div class="approval-section-title">Pick one</div>
      <div class="approval-options-list" role={interactive ? 'radiogroup' : 'list'} aria-label="Options to pick from">
        {props.options.map((opt) => {
          const isDecided = props.decided === opt.id;
          const isSelected = interactive ? props.selected === opt.id : isDecided;
          const body = (
            <span class="approval-option-main">
              <span class="approval-option-label">
                {opt.label}
                {opt.recommended && <span class="approval-option-badge">recommended</span>}
                {isDecided && <span class="approval-option-badge picked">picked</span>}
              </span>
              {opt.description && <span class="approval-option-desc"><InlineMarkdown value={opt.description} /></span>}
            </span>
          );
          return interactive ? (
            <label class={`approval-option${isSelected ? ' selected' : ''}`} key={opt.id}>
              <input
                type="radio"
                name="approval-option-pick"
                value={opt.id}
                checked={isSelected}
                onChange={() => props.onSelect!(opt.id)}
              />
              {body}
            </label>
          ) : (
            <div class={`approval-option static${isSelected ? ' selected' : ''}`} role="listitem" key={opt.id}>
              {body}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ApprovalDetailCard(props: {
  details: ApprovalLogDetails;
  sessionId: string;
  token: string | undefined;
  selectedChoice?: string | undefined;
  onSelectChoice?: ((id: string) => void) | undefined;
}) {
  const details = props.details;
  const artifactPaths = details.artifactPaths ?? [];
  const detectedImagePaths = detectPayloadImagePaths(details, artifactPaths);
  const changes = details.changes ?? [];
  const options = details.options ?? [];
  const decidedOptionLabel = details.decisionChoice
    ? options.find((o) => o.id === details.decisionChoice)?.label ?? details.decisionChoice
    : undefined;
  const decisionLabel = details.decisionStatus
    ? `${details.decisionStatus}${decidedOptionLabel ? `: picked "${decidedOptionLabel}"` : ''}${details.decisionReviewer ? ` by ${details.decisionReviewer}` : ''}`
    : '';
  const primary = details.draft
    ? { title: 'Draft', body: <LogContent value={details.draft} forceMarkdown /> }
    : details.artifactUrl
      ? { title: 'Artifact', body: <a class="approval-link" href={details.artifactUrl} target="_blank" rel="noopener noreferrer">{details.artifactUrl}</a> }
      : details.draftUrl
        ? { title: 'Draft', body: <a class="approval-link" href={details.draftUrl} target="_blank" rel="noopener noreferrer">{details.draftUrl}</a> }
        : details.summary && changes.length === 0
          ? { title: 'Review', body: <LogContent value={details.summary} forceMarkdown /> }
          : undefined;
  const showSummary = Boolean(details.summary) && primary?.title !== 'Review';
  // With structured changes present, the draft is supporting detail, not the
  // thing under review: collapse it so the change boxes stay the focal point.
  // An options menu does NOT demote the draft: on a pick gate the draft is the
  // evidence the reviewer reads before choosing.
  const demotePrimary = changes.length > 0 && Boolean(primary);
  const links = [
    details.draftUrl ? <a class="approval-link" href={details.draftUrl} target="_blank" rel="noopener noreferrer">Open draft</a> : null,
    details.artifactUrl ? <a class="approval-link" href={details.artifactUrl} target="_blank" rel="noopener noreferrer">Open artifact</a> : null,
  ].filter(Boolean);
  const hasContent = details.prompt || primary || changes.length > 0 || options.length > 0 || details.reference || details.risk || showSummary || details.context || links.length > 0 || artifactPaths.length > 0 || detectedImagePaths.length > 0 || decisionLabel || details.decisionComment || details.errorMessage;
  if (!hasContent) return null;

  return (
    <div class="approval-card">
      {details.prompt && <div class="approval-question"><InlineMarkdown value={details.prompt} /></div>}
      {details.reference && <ReferenceBlock reference={details.reference} />}
      {changes.length > 0 && <ChangesBlock changes={changes} />}
      {(artifactPaths.length > 0 || detectedImagePaths.length > 0) && (
        <section class="approval-section approval-artifact">
          <div class="approval-section-title">{artifactPaths.length + detectedImagePaths.length > 1 ? 'Artifacts' : 'Artifact'}</div>
          <div class="approval-section-body approval-artifact-body">
            {artifactPaths.map((path) => {
              const href = artifactHref(props.sessionId, path, props.token);
              return (
                <div class="artifact-item" key={path}>
                  <div class="artifact-tiles">
                    <a class="artifact-open" href={href} target="_blank" rel="noopener noreferrer">
                      <span class="artifact-open-name">{artifactName(path)}</span>
                      <span class="artifact-open-hint">open</span>
                    </a>
                  </div>
                  <ArtifactPreview path={path} href={href} />
                </div>
              );
            })}
            {detectedImagePaths.map((path) => (
              <DetectedImageItem key={path} path={path} href={artifactHref(props.sessionId, path, props.token)} />
            ))}
          </div>
        </section>
      )}
      {primary && (demotePrimary
        ? (
          <details class="approval-section approval-context">
            <summary>{primary.title}</summary>
            <div class="approval-section-body">{primary.body}</div>
          </details>
        )
        : (
          <section class="approval-section approval-primary">
            <div class="approval-section-title">{primary.title}</div>
            <div class="approval-section-body">{primary.body}</div>
          </section>
        ))}
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
      {details.context && (
        <details class={`approval-section approval-context${changes.length === 0 ? ' approval-context-open' : ''}`} open={changes.length === 0}>
          <summary>Source context</summary>
          <div class="approval-section-body"><LogContent value={details.context} forceMarkdown /></div>
        </details>
      )}
      {details.risk && (
        <section class="approval-section approval-risk">
          <div class="approval-section-title">Risk / consequence</div>
          <div class="approval-section-body"><LogContent value={details.risk} forceMarkdown /></div>
        </section>
      )}
      {options.length > 0 && (
        // Last content section by design: the feed auto-scrolls to the end, so
        // the reviewer lands here, and the pick sits directly above the
        // Approve/Reject/Comment row it feeds. Evidence above, decision below.
        <OptionsBlock
          options={options}
          selected={props.selectedChoice}
          decided={details.decisionChoice}
          onSelect={props.onSelectChoice}
        />
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
  const name = s.agent.name || s.agent.id;
  const inner = (
    <>
      <span class={`chip status ${s.displayStatus}`}>{s.displayStatus}</span>
      <span class="subagent-name">{name}</span>
      <code class="subagent-id">{s.sessionId}</code>
      {s.command && <span class="subagent-command">{s.command}</span>}
    </>
  );
  return s.href
    ? (
      <a class="subagent-event" href={s.href} aria-label={`Open subagent session ${name || s.sessionId}`}>
        {inner}
        <span class="subagent-open-cue" aria-hidden="true">open ›</span>
      </a>
    )
    : <div class="subagent-event">{inner}</div>;
}

const toolTokenFmt = new Intl.NumberFormat('en-US');

function ToolTokenUsageStrip(props: { usage: NonNullable<ApprovalLogDetails['tokenUsage']> }) {
  const cached = Math.max(0, props.usage.cachedInput);
  const input = Math.max(0, props.usage.input - cached);
  const output = Math.max(0, props.usage.output);
  const metrics = [
    { label: 'input', value: toolTokenFmt.format(input) },
    { label: 'output', value: toolTokenFmt.format(output) },
    { label: 'cached', value: `+${toolTokenFmt.format(cached)}` },
  ];
  const sharedCalls = props.usage.sharedCalls ?? 1;

  return (
    <div class="tool-token-usage" aria-label="Model step token usage">
      {metrics.map((metric) => (
        <span class="tool-token-metric" key={metric.label}>
          <span class="tool-token-label">{metric.label}</span>
          <span class="tool-token-value">{metric.value}</span>
        </span>
      ))}
      {sharedCalls > 1 && (
        <span
          class="tool-token-shared"
          title="These counters cover the model step that emitted all of these tool calls; they are not charged once per tool."
        >shared across {sharedCalls} calls</span>
      )}
    </div>
  );
}

function ToolDetails(props: { details: ApprovalLogDetails; sessionId: string; token: string | undefined }) {
  const details = props.details;
  const rows = [
    details.input ? { label: 'Input', value: details.input } : undefined,
    details.output ? { label: 'Output', value: details.output } : undefined,
    details.errorMessage ? { label: 'Error', value: details.errorMessage } : undefined,
  ].filter((row): row is { label: string; value: string } => Boolean(row));
  const artifact = details.toolOutputArtifact;
  if (rows.length === 0 && !artifact && !details.tokenUsage) return null;
  return (
    <div class="log-details">
      {details.tokenUsage && <ToolTokenUsageStrip usage={details.tokenUsage} />}
      {rows.map((row) => (
        <div class="log-detail" key={row.label}>
          <div class="log-detail-label">{row.label}</div>
          <div class="log-detail-value"><LogContent value={row.value} /></div>
        </div>
      ))}
      {artifact && (
        <div class="log-detail">
          <div class="log-detail-label">Full output</div>
          <div class="log-detail-value">
            <div class="artifact-tiles">
              <a
                class="artifact-open"
                href={toolArtifactHref(props.sessionId, artifact.path, props.token)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span class="artifact-open-name">{artifactName(artifact.path)}</span>
                {typeof artifact.bytes === 'number' && <span class="artifact-size">{Math.ceil(artifact.bytes / 1024)} KB</span>}
                <span class="artifact-open-hint">open</span>
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Glyph for an operational log line, by severity. Mirrors the muted log aesthetic. */
function logLevelMarker(level: string | undefined): string {
  switch (level) {
    case 'error': return '✗';
    case 'warn': return '▲';
    case 'debug': return '·';
    case 'system': return '◆';
    default: return '›'; // info
  }
}

function isApprovalDetails(entry: ApprovalLogEntry): boolean {
  if (entry.tool === 'await_human' || entry.type === 'approval') return true;
  const details = entry.details;
  return Boolean(details && (
    details.resumeToken ||
    details.prompt ||
    details.draft ||
    details.draftUrl ||
    details.artifactUrl ||
    details.artifactPaths?.length ||
    details.decisionStatus ||
    details.decisionComment
  ));
}

export interface LogEntryProps {
  entry: ApprovalLogEntry;
  /** Operational warnings about this tool call, nested under it instead of
   *  shown as standalone "failed" lines in the flat stream. */
  warnings?: ApprovalLogEntry[] | undefined;
  /** Entry arrived over the live stream after the initial snapshot; animates in. */
  isNew?: boolean | undefined;
  /** Number of consecutive identical operational log lines collapsed into this
   *  row (>1 renders an xN badge). Undefined/1 renders no badge. */
  repeatCount?: number | undefined;
  expanded: boolean;
  showActions: boolean;
  actionsDisabled: boolean;
  /** The decision currently being submitted; renders a specific pending label
   *  ("approving…") in place of the keyboard hint. */
  pendingAction?: 'approve' | 'reject' | 'comment' | null;
  /** On a view-only sub-agent page, the pending gate has no local controls —
   *  this links to the parent run where the decision is actually made. */
  parentApproveHref?: string | undefined;
  parentApproveLabel?: string | undefined;
  projectId: string | undefined;
  sessionId: string;
  token: string | undefined;
  /** Currently selected option id on an actionable pick-among-options gate.
   *  Only passed to the entry that owns the pending gate. */
  selectedChoice?: string | undefined;
  onSelectChoice?: ((id: string) => void) | undefined;
  onToggle: (id: string) => void;
  onAction: (action: 'approve' | 'reject' | 'comment') => void;
}

function LogWarnings(props: { warnings: ApprovalLogEntry[] }) {
  return (
    <div class="log-warnings">
      <div class="log-warnings-title">{props.warnings.length === 1 ? 'Warning' : `Warnings (${props.warnings.length})`}</div>
      {props.warnings.map((w) => (
        <div class="log-warning" key={w.id}>
          <div class="log-warning-line">{w.title}</div>
          {w.message && <div class="log-warning-detail"><LogContent value={w.message} /></div>}
        </div>
      ))}
    </div>
  );
}

/**
 * Human-readable chip text for a raw tool id: strip the `tools__` namespace and
 * join the remaining segments ("tools__skill_load" → "skill_load",
 * "sandbox__exec" → "sandbox · exec"). The raw id stays on the chip's tooltip.
 */
function toolChipLabel(tool: string): string {
  const segments = tool.split('__').filter(Boolean);
  if (segments.length > 1 && segments[0] === 'tools') segments.shift();
  return segments.join(' · ');
}

function LogEntryImpl(props: LogEntryProps) {
  const { entry } = props;
  const warnings = props.warnings ?? [];
  const isApprovalEntry = isApprovalDetails(entry);
  const savedArtifact = entry.details?.savedArtifact;
  // A saved-artifact row shows its tile inline; there's nothing to expand into.
  const expandable = entry.type === 'tool' && !isApprovalEntry && !savedArtifact;
  const expanded = !expandable || entry.status === 'running' || props.expanded;
  const storeEvent = storeToolEvent(entry, props.projectId);
  const spinning = entry.status === 'streaming' || entry.status === 'running';
  // A failed tool call must read as failure without relying on color alone.
  const failed = entry.status === 'error' || entry.status === 'failed';
  // Streaming prose reveals progressively (typing effect); everything else
  // renders its message as-is. The hook is a pass-through when not streaming.
  const prose = entry.type === 'text' || entry.type === 'reasoning';
  const typing = prose && entry.status === 'streaming' && Boolean(entry.message);
  const message = useSmoothText(entry.message ?? '', typing);
  // Model-declared intent phrase: promoted to the row's primary text, with the
  // tool chip demoted to trailing metadata. Rows without one keep the chip-only
  // layout, so mixed sessions (older runs, models that skip the param) align.
  const toolIntent = entry.type === 'tool' && !isApprovalEntry && entry.details?.intent
    ? entry.details.intent
    : undefined;
  // On a pick-among-options gate the approve button names the selection, so the
  // reviewer sees exactly what a click commits to.
  const selectedOptionLabel = props.showActions && props.selectedChoice
    ? entry.details?.options?.find((o) => o.id === props.selectedChoice)?.label
    : undefined;

  const classes = [
    'log-item',
    entry.status ?? '',
    entry.type === 'log' ? `log-level-${entry.level ?? 'info'}` : '',
    props.showActions ? 'is-actionable' : '',
    expandable ? 'expandable' : '',
    expanded ? 'expanded' : '',
    props.isNew ? 'is-new' : '',
  ].filter(Boolean).join(' ');

  const toggle = () => {
    if (expandable) props.onToggle(entry.id);
  };

  return (
    <li
      class={classes}
      data-log-id={entry.id}
      data-log-type={entry.type}
      role={expandable ? 'button' : undefined}
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
      <div class="log-head">
        <span class="log-time">{formatLogTime(entry.time)}</span>
        <span
          class="log-marker"
          {...(spinning
            ? {}
            : entry.type === 'log'
              ? { 'aria-label': `${entry.level ?? 'info'} log`, title: entry.level ?? 'info', role: 'img' }
              : { 'aria-hidden': 'true' })}
        >{spinning ? <span class="log-spinner" aria-label="streaming" /> : (entry.type === 'compaction' ? '⇲' : entry.type === 'learning' ? '✦' : entry.type === 'verify' ? (entry.status === 'completed' ? '✓' : '⚖') : entry.type === 'error' ? '✗' : entry.type === 'reasoning' ? '✻' : entry.type === 'log' ? logLevelMarker(entry.level) : failed ? '✗' : entry.type === 'tool' && entry.status === 'completed' ? '✓' : '⋮')}</span>
        <span class="log-title">
          {entry.type === 'tool' && entry.tool && !isApprovalEntry
            ? (
              <>
                {toolIntent && <span class="log-intent" title={toolIntent}>{toolIntent}</span>}
                <span class={`tool-chip${toolIntent ? ' has-intent' : ''}`} title={entry.title} aria-label={entry.title}>{toolChipLabel(entry.tool)}</span>
              </>
            )
            : entry.title}
          {props.repeatCount !== undefined && props.repeatCount > 1 && (
            <span class="log-count-badge">x{props.repeatCount}</span>
          )}
          {warnings.length > 0 && (
            <span class="log-warn-badge" title={`${warnings.length} warning${warnings.length === 1 ? '' : 's'} about this tool call`}>⚠ {warnings.length}</span>
          )}
        </span>
      </div>
      <div class="log-main">
        {/* The sub-agent card carries status + a link to the child run, so keep
            it visible even when the row is collapsed; only the tool input/output
            below stays behind the expand toggle. */}
        {entry.subagentSession && <SubagentCard session={entry.subagentSession} />}
        {savedArtifact && <SavedArtifactCard artifact={savedArtifact} sessionId={props.sessionId} token={props.token} />}
        <div class="log-content">
          {storeEvent && <StoreEventBlock event={storeEvent} />}
          {entry.details && (isApprovalEntry
            ? <ApprovalDetailCard
                details={entry.details}
                sessionId={props.sessionId}
                token={props.token}
                selectedChoice={props.selectedChoice}
                onSelectChoice={props.showActions ? props.onSelectChoice : undefined}
              />
            : <ToolDetails details={entry.details} sessionId={props.sessionId} token={props.token} />)}
          {message && !storeEvent && !entry.subagentSession && <LogContent value={message} forceMarkdown={prose} />}
          {warnings.length > 0 && <LogWarnings warnings={warnings} />}
        </div>
        {props.showActions && (
          <div class="log-actions" data-actions-row>
            {props.actionsDisabled ? (
              // No role="status": this mounts inside the role="log" list and the
              // page's persistent notice announces the same event; a third live
              // region would make screen readers repeat it.
              <span class="log-actions-pending">
                <span class="btn-spinner" aria-hidden="true" />
                {props.pendingAction === 'approve' ? 'approving…' : props.pendingAction === 'reject' ? 'rejecting…' : props.pendingAction === 'comment' ? 'sending comment…' : 'submitting decision…'}
              </span>
            ) : (
              <div class="log-actions-hint log-actions-hint-kbd">
                <span class="kbd">⌘⏎</span> approve <span class="kbd">esc</span> reject <span class="kbd">c</span> comment
              </div>
            )}
            <div class="log-actions-buttons">
              <button class="primary" disabled={props.actionsDisabled} onClick={() => props.onAction('approve')}>
                {selectedOptionLabel ? <>Approve<span class="approve-choice-label">“{selectedOptionLabel}”</span></> : 'Approve'}
              </button>
              <button class="danger" disabled={props.actionsDisabled} onClick={() => props.onAction('reject')}>Reject</button>
              <button disabled={props.actionsDisabled} onClick={() => props.onAction('comment')}>Comment</button>
            </div>
          </div>
        )}
        {!props.showActions && props.parentApproveHref && isApprovalEntry && entry.status === 'pending' && (
          <div class="log-actions" data-actions-row>
            <div class="log-actions-hint">The decision is made on the parent run.</div>
            <a class="log-parent-approve" href={props.parentApproveHref}>
              <span>Approve on {props.parentApproveLabel ?? 'the parent run'}</span>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </a>
          </div>
        )}
      </div>
    </li>
  );
}

/** Re-render only when the entry content or interactive surface changes. */
const warningsSignature = (warnings: ApprovalLogEntry[] | undefined): string =>
  (warnings ?? []).map(logEntrySignature).join('|');

export const LogEntry = memo(LogEntryImpl, (prev, next) =>
  logEntrySignature(prev.entry) === logEntrySignature(next.entry) &&
  warningsSignature(prev.warnings) === warningsSignature(next.warnings) &&
  prev.isNew === next.isNew &&
  prev.repeatCount === next.repeatCount &&
  prev.expanded === next.expanded &&
  prev.showActions === next.showActions &&
  prev.actionsDisabled === next.actionsDisabled &&
  prev.pendingAction === next.pendingAction &&
  prev.parentApproveHref === next.parentApproveHref &&
  prev.parentApproveLabel === next.parentApproveLabel &&
  prev.projectId === next.projectId &&
  prev.sessionId === next.sessionId &&
  prev.token === next.token &&
  prev.selectedChoice === next.selectedChoice
);
