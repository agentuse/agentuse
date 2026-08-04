import { memo } from 'preact/compat';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
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

function artifactHref(sessionId: string, artifactPath: string, token: string | undefined, snapHash?: string): string {
  const encoded = artifactPath.split('/').map(encodeURIComponent).join('/');
  const base = `/sessions/${encodeURIComponent(sessionId)}/artifacts/${encoded}`;
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (snapHash) params.set('snap', snapHash);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
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

function changeDisplayContent(change: ApprovalChange): string {
  return change.displayContent?.trim() || change.content;
}

function hasDistinctCommand(change: ApprovalChange): boolean {
  return Boolean(change.displayContent?.trim()) && change.displayContent?.trim() !== change.content.trim();
}

/** Exact execution detail remains inspectable beside the business content, but
 *  never competes with it for the reviewer's first read. */
function CommandDetail(props: { change: ApprovalChange }) {
  if (!hasDistinctCommand(props.change)) return null;
  return (
    <div class="approval-command-detail">
      <span class="approval-command-label">Command</span>
      <code class="approval-command-content">{props.change.content}</code>
      <CopyButton text={props.change.content} />
    </div>
  );
}

/** The original being responded to, quoted beside (or above, when narrow) the
 *  changes so the reviewer judges original ↔ reply without leaving the card. */
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
function ChangesBlock(props: { changes: ApprovalChange[]; options: ApprovalOption[] }) {
  return (
    <section class="approval-section approval-changes">
      <div class="approval-section-title">On approval</div>
      <div class="approval-section-body">
        {props.changes.map((change, index) => (
          <div class="approval-change" key={index}>
            <div class="approval-change-head">
              <span class="approval-change-label">{change.label || `Action ${index + 1}`}</span>
              {change.optionId && (
                <span class="approval-change-meta">
                  Choice: {props.options.find((option) => option.id === change.optionId)?.label ?? change.optionId}
                </span>
              )}
              <CopyButton text={changeDisplayContent(change)} />
            </div>
            <div class="approval-change-content"><LogContent value={changeDisplayContent(change)} forceMarkdown /></div>
            <CommandDetail change={change} />
          </div>
        ))}
      </div>
    </section>
  );
}

const IMAGE_ARTIFACT_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const HTML_ARTIFACT_RE = /\.(html?)$/i;
const PDF_ARTIFACT_RE = /\.pdf$/i;
const VIDEO_ARTIFACT_RE = /\.(mp4|m4v|webm|mov)$/i;
const AUDIO_ARTIFACT_RE = /\.(mp3|m4a|wav|ogg)$/i;

/** Media-file path tokens inside gate payload prose (images + audio/video). */
const PAYLOAD_IMAGE_PATH_RE = /[\w.~@/-]+\.(?:png|jpe?g|gif|webp|avif|mp4|m4v|webm|mov|mp3|m4a|wav)\b/gi;

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
    ...(details.changes ?? []).map((c) => c.displayContent),
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
 * Artifact tile + inline media preview for a payload-detected path. Unlike
 * explicit artifact_paths, a detected mention may be stale or a false
 * positive, so the whole item removes itself when the media fails to load.
 * Snapshot-backed items (`snapped`) reviewed the frozen gate-time bytes and
 * keep their tile even if the live file is gone.
 */
function DetectedMediaItem(props: { path: string; href: string; snapped?: boolean }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const hide = props.snapped ? undefined : () => setHidden(true);
  const preview = VIDEO_ARTIFACT_RE.test(props.path)
    ? <video class="artifact-preview-video" src={props.href} controls preload="metadata" onError={hide} />
    : AUDIO_ARTIFACT_RE.test(props.path)
      ? <audio class="artifact-preview-audio" src={props.href} controls preload="metadata" onError={hide} />
      : (
        <a class="artifact-preview" href={props.href} target="_blank" rel="noopener noreferrer">
          <img
            class="artifact-preview-img"
            src={props.href}
            alt={artifactName(props.path)}
            loading="lazy"
            onError={hide}
          />
        </a>
      );
  return (
    <div class="artifact-item">
      <div class="artifact-tiles">
        <a class="artifact-open" href={props.href} target="_blank" rel="noopener noreferrer">
          <span class="artifact-open-name">{artifactName(props.path)}</span>
          <span class="artifact-open-hint">open</span>
        </a>
      </div>
      {preview}
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
  if (VIDEO_ARTIFACT_RE.test(props.path)) {
    return <video class="artifact-preview-video" src={props.href} controls preload="metadata" />;
  }
  if (AUDIO_ARTIFACT_RE.test(props.path)) {
    return <audio class="artifact-preview-audio" src={props.href} controls preload="metadata" />;
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
  changes: ApprovalChange[];
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
          const changes = props.changes.filter((change) => change.optionId === opt.id);
          const body = (
            <div class="approval-option-main">
              <div class="approval-option-label">
                {opt.label}
                {opt.recommended && <span class="approval-option-badge">recommended</span>}
                {isDecided && <span class="approval-option-badge picked">picked</span>}
              </div>
              {opt.description && <div class="approval-option-desc"><InlineMarkdown value={opt.description} /></div>}
              {changes.map((change, index) => (
                <div class="approval-option-action" key={index}>
                  {changes.length > 1 && (
                    <div class="approval-option-action-label">{change.label || `Action ${index + 1}`}</div>
                  )}
                  <LogContent value={changeDisplayContent(change)} forceMarkdown />
                </div>
              ))}
            </div>
          );
          const commandDetails = changes
            .filter(hasDistinctCommand)
            .map((change, index) => <CommandDetail change={change} key={index} />);
          return interactive ? (
            <div class={`approval-option interactive${isSelected ? ' selected' : ''}`} key={opt.id}>
              <label class="approval-option-choice">
                <input
                  type="radio"
                  name="approval-option-pick"
                  value={opt.id}
                  checked={isSelected}
                  onChange={() => props.onSelect!(opt.id)}
                />
                {body}
              </label>
              {commandDetails}
            </div>
          ) : (
            <div class={`approval-option static${isSelected ? ' selected' : ''}`} role="listitem" key={opt.id}>
              <div class="approval-option-static-body">{body}</div>
              {commandDetails}
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
  // Gate-time snapshots: path -> hash. Snapshot-known paths render frozen
  // bytes; when the gate recorded snapshots, they are the authoritative list
  // of payload-mentioned media and client-side sniffing only fills in for
  // older gates recorded before snapshotting existed.
  const snapshots = details.artifactSnapshots ?? [];
  const snapshotByPath = new Map(snapshots.map((s) => [s.path, s.hash]));
  const snapshotOnlyPaths = snapshots.map((s) => s.path).filter((p) => !artifactPaths.includes(p));
  const detectedImagePaths = snapshots.length > 0
    ? []
    : detectPayloadImagePaths(details, artifactPaths);
  const changes = details.changes ?? [];
  const options = details.options ?? [];
  const optionIds = new Set(options.map((option) => option.id));
  const optionChanges = changes.filter((change) => change.optionId && optionIds.has(change.optionId));
  const standaloneChanges = changes.filter((change) => !change.optionId || !optionIds.has(change.optionId));
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
  const demotePrimary = options.length === 0 && standaloneChanges.length > 0 && Boolean(primary);
  const links = [
    details.draftUrl ? <a class="approval-link" href={details.draftUrl} target="_blank" rel="noopener noreferrer">Open draft</a> : null,
    details.artifactUrl ? <a class="approval-link" href={details.artifactUrl} target="_blank" rel="noopener noreferrer">Open artifact</a> : null,
  ].filter(Boolean);
  const hasContent = details.prompt || primary || changes.length > 0 || options.length > 0 || details.reference || details.risk || showSummary || details.context || links.length > 0 || artifactPaths.length > 0 || snapshotOnlyPaths.length > 0 || detectedImagePaths.length > 0 || decisionLabel || details.decisionComment || details.errorMessage;
  if (!hasContent) return null;

  return (
    <div class="approval-card">
      {details.prompt && <div class="approval-question"><InlineMarkdown value={details.prompt} /></div>}
      {/* Reply gates are read as a comparison, not a sequence: the reviewer's
          real question is "does this answer that?". Pairing the two columns
          puts both halves in one glance. A pick gate keeps them stacked, since
          the response there lives in the options menu, not in changes. */}
      {details.reference && standaloneChanges.length > 0 && options.length === 0 ? (
        <div class="approval-compare">
          <ReferenceBlock reference={details.reference} />
          <ChangesBlock changes={standaloneChanges} options={options} />
        </div>
      ) : (
        <>
          {details.reference && <ReferenceBlock reference={details.reference} />}
          {standaloneChanges.length > 0 && <ChangesBlock changes={standaloneChanges} options={options} />}
        </>
      )}
      {(artifactPaths.length > 0 || snapshotOnlyPaths.length > 0 || detectedImagePaths.length > 0) && (
        <section class="approval-section approval-artifact">
          <div class="approval-section-title">{artifactPaths.length + snapshotOnlyPaths.length + detectedImagePaths.length > 1 ? 'Artifacts' : 'Artifact'}</div>
          <div class="approval-section-body approval-artifact-body">
            {artifactPaths.map((path) => {
              const href = artifactHref(props.sessionId, path, props.token, snapshotByPath.get(path));
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
            {snapshotOnlyPaths.map((path) => (
              <DetectedMediaItem key={path} path={path} href={artifactHref(props.sessionId, path, props.token, snapshotByPath.get(path))} snapped />
            ))}
            {detectedImagePaths.map((path) => (
              <DetectedMediaItem key={path} path={path} href={artifactHref(props.sessionId, path, props.token)} />
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
      {showSummary && (options.length > 0
        // On a pick gate the per-option descriptions already say what separates
        // the alternatives, which is the only part of the summary that changes the
        // decision; the rest tends to restate the candidates or the buttons. Start
        // it collapsed there. On a plain yes/no gate nothing else explains the ask,
        // so it stays open.
        ? (
          <details class="approval-section approval-secondary approval-summary-collapsed">
            <summary>Why this request</summary>
            <div class="approval-section-body"><LogContent value={details.summary!} forceMarkdown /></div>
          </details>
        )
        : (
          <section class="approval-section approval-secondary">
            <div class="approval-section-title">Why this request</div>
            <div class="approval-section-body"><LogContent value={details.summary!} forceMarkdown /></div>
          </section>
        ))}
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
          changes={optionChanges}
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

/**
 * Tail of a tool call still in flight. Fixed height with its own scroller: the
 * page follows the bottom of the feed while a run is live, so a block that grew
 * with the output would shove the rest of the log off-screen. Sticks to the
 * newest line unless the reader scrolls up to read something.
 */
function LiveOutput(props: { value: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const stuck = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !stuck.current) return;
    el.scrollTop = el.scrollHeight;
  }, [props.value]);

  return (
    <pre
      class="live-output"
      ref={ref}
      onScroll={() => {
        const el = ref.current;
        if (!el) return;
        // Re-stick as soon as the reader comes back to the bottom.
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >{props.value}</pre>
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
  if (rows.length === 0 && !artifact && !details.tokenUsage && !details.liveOutput) return null;
  return (
    <div class="log-details">
      {details.tokenUsage && <ToolTokenUsageStrip usage={details.tokenUsage} />}
      {rows.map((row) => (
        <div class="log-detail" key={row.label}>
          <div class="log-detail-label">{row.label}</div>
          <div class="log-detail-value"><LogContent value={row.value} /></div>
        </div>
      ))}
      {details.liveOutput && (
        <div class="log-detail log-detail-live">
          <div class="log-detail-label">Output<span class="live-tag">live</span></div>
          <div class="log-detail-value"><LiveOutput value={details.liveOutput} /></div>
        </div>
      )}
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
  /** Reviewer's explicit expand/collapse for this row. Undefined means "no
   *  opinion", which leaves the row on its default: open while the tool runs,
   *  closed once it finishes. */
  expanded: boolean | undefined;
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
  onToggle: (id: string, expanded: boolean) => void;
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
  // A running tool opens itself (its live output is the point of watching), but
  // that is a default, not a lock: the reviewer can collapse it mid-run, and a
  // row they never touched closes again when the call completes rather than
  // leaving a finished command's output wedged in the stream.
  const expanded = !expandable || (props.expanded ?? entry.status === 'running');
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
  // A pick gate with nothing selected has nothing to approve: the agent branches
  // on the choice, so approve must wait for one. Only approve is withheld —
  // reject and comment are still valid answers to "which of these?".
  const awaitingPick = props.showActions
    && (entry.details?.options?.length ?? 0) > 0
    && !props.selectedChoice;

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
    if (expandable) props.onToggle(entry.id, !expanded);
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
            ) : awaitingPick ? (
              // An explanation, not a shortcut list, so it must survive on touch
              // where the keyboard hints are hidden; only the keys are wrapped.
              <div class="log-actions-hint log-actions-awaiting-pick">
                Pick an option above to approve.
                <span class="log-actions-hint-kbd"> <span class="kbd">esc</span> reject <span class="kbd">c</span> comment</span>
              </div>
            ) : (
              <div class="log-actions-hint log-actions-hint-kbd">
                <span class="kbd">⌘⏎</span> approve <span class="kbd">esc</span> reject <span class="kbd">c</span> comment
              </div>
            )}
            <div class="log-actions-buttons">
              <button
                class="primary"
                disabled={props.actionsDisabled || awaitingPick}
                title={awaitingPick ? 'Pick one of the options above first' : undefined}
                onClick={() => props.onAction('approve')}
              >
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
