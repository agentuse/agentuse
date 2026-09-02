import type { ComponentChildren } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useSmoothText } from '../hooks/use-smooth-text';
import { useSessionTail } from '../hooks/use-session-tail';
import { useTailSlot } from '../hooks/use-tail-slot';
import type { ApprovalChange, ApprovalLogDetails, ApprovalLogEntry, ApprovalOption, ApprovalReference, LogSubagentEvent, LogSubagentSession } from '../../types';
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

/** `label` names what gets copied: a card can hold several of these, and
 *  without it a screen reader offers a list of identical "copy" buttons. */
function CopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const what = props.label ? `Copy ${props.label} to clipboard` : 'Copy to clipboard';
  return (
    <button
      class="approval-copy"
      type="button"
      title={what}
      aria-label={copied ? `${what} — copied` : what}
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
  // Folded: the command usually repeats the text shown above it verbatim, and
  // the reviewer only needs it to copy or to check the exact target.
  return (
    <details class="approval-command-detail">
      <summary class="approval-command-summary">
        <span class="approval-command-label">Command</span>
        {/* Scrolls horizontally when the command overflows, so it needs to be
            focusable or the tail is keyboard-unreachable. */}
        <code class="approval-command-content" tabIndex={0}>{props.change.content}</code>
        <CopyButton text={props.change.content} label="command" />
      </summary>
      <code class="approval-command-full">{props.change.content}</code>
    </details>
  );
}

/** Agents wrap fetched third-party text in an `<untrusted_input>` tag so the
 *  model treats it as data. The tag is for the model; the reviewer already
 *  knows the quote is someone else's post, so the wrapper is only noise here. */
function stripUntrustedWrapper(text: string): string {
  return text.replace(/<\/?untrusted_input(?:\s[^>]*)?>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Loose match for "these two strings say the same thing": case, surrounding
 *  punctuation and Markdown heading marks are all noise for this comparison. */
function sameText(a: string | undefined, b: string | undefined): boolean {
  const norm = (v: string) => v.replace(/^#{1,6}\s*/, '').replace(/[\s*_`#:.–—-]+/g, ' ').trim().toLowerCase();
  return Boolean(a && b && norm(a) === norm(b));
}

/**
 * Agents routinely restate a section's own heading as the first line of that
 * section's body — "Source context", "Why this request", "Draft notes" are the
 * card's hardcoded labels, not the author's, so an agent that writes one is
 * echoing the UI back at itself and the reviewer reads it twice. The schema
 * tells agents not to; they do it anyway, and stripping it here fixes every
 * gate already recorded rather than only the ones written after the next
 * prompt change.
 */
function stripEchoedHeading(text: string, title: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first === -1 || !sameText(lines[first], title)) return text;
  // Drop the echoed line plus the blank line that followed it, so the body
  // does not start on a stray gap.
  const rest = lines.slice(first + 1);
  while (rest.length > 0 && rest[0]!.trim() === '') rest.shift();
  return rest.join('\n');
}

/** The original being responded to, quoted beside (or above, when narrow) the
 *  changes so the reviewer judges original ↔ reply without leaving the card. */
function ReferenceBlock(props: { reference: ApprovalReference }) {
  const ref = props.reference;
  const excerpt = ref.excerpt ? stripUntrustedWrapper(ref.excerpt) : undefined;
  // A one-line original (a question, a subject) makes title and excerpt the
  // same sentence, and the card printed it twice in a row. Keep the excerpt,
  // since that is the field the reviewer is told to judge against.
  const title = sameText(ref.title, excerpt) ? undefined : ref.title;
  return (
    <section class="approval-section approval-reference">
      <h4 class="approval-section-title">{ref.label || 'In reply to'}</h4>
      <div class="approval-section-body">
        <div class="approval-reference-quote">
          {(ref.author || title) && (
            <div class="approval-reference-head">
              {ref.author && <span class="approval-reference-author">{ref.author}</span>}
              {title && <span class="approval-reference-title">{title}</span>}
            </div>
          )}
          {/* tabIndex: this box clips at 26em and scrolls, so without it the
              hidden tail of a long original is unreachable by keyboard. */}
          {excerpt && <div class="approval-reference-excerpt" tabIndex={0} role="group" aria-label="Original being responded to"><LogContent value={excerpt} forceMarkdown /></div>}
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
      <h4 class="approval-section-title">On approval</h4>
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
              <CopyButton text={changeDisplayContent(change)} label={change.label || `action ${index + 1}`} />
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
 * The selected candidate is the one that renders in full, which on a long
 * draft (a post, an answer, an email) pushes every other option a screen
 * below: the reviewer never learns the alternatives exist, so a "pick one"
 * gate degrades into a rubber stamp on whatever was recommended. Cap it at a
 * readable slab and let the reviewer open the rest deliberately. Measured
 * rather than counted, so a short candidate shows no control at all.
 */
function SelectedOptionActions(props: { children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    // Only while collapsed: expanded, scrollHeight equals clientHeight, and
    // re-measuring would drop the control that collapses it again.
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    setClipped(el.scrollHeight > el.clientHeight + 4);
  });
  return (
    <div class={`approval-option-body${expanded ? ' expanded' : ''}${clipped && !expanded ? ' is-clipped' : ''}`}>
      <div class="approval-option-clamp" ref={ref}>{props.children}</div>
      {(clipped || expanded) && (
        <button
          class="approval-option-more"
          type="button"
          aria-expanded={expanded}
          onClick={(event) => {
            // The card is a <label>, so a bare click here would also drive the
            // radio; opening the text must not read as re-picking the option.
            event.preventDefault();
            event.stopPropagation();
            setExpanded(!expanded);
          }}
        >{expanded ? 'Show less' : 'Show full'}</button>
      )}
    </div>
  );
}

/**
 * Pick-among-options menu on an approval gate. Interactive (radio cards) while
 * the gate is pending and actionable; a static list afterwards, with the
 * decided option marked. The recommended option is preselected by the page.
 */
function OptionsBlock(props: {
  /** Radio group name, scoped to the owning gate (see ApprovalDetailCard). */
  groupName: string;
  options: ApprovalOption[];
  changes: ApprovalChange[];
  selected?: string | undefined;
  decided?: string | undefined;
  onSelect?: ((id: string) => void) | undefined;
}) {
  const interactive = Boolean(props.onSelect);
  return (
    <section class="approval-section approval-options">
      <h4 class="approval-section-title">Pick one</h4>
      <div class="approval-options-list" role={interactive ? 'radiogroup' : 'list'} aria-label="Options to pick from">
        {props.options.map((opt) => {
          const isDecided = props.decided === opt.id;
          const isSelected = interactive ? props.selected === opt.id : isDecided;
          const changes = props.changes.filter((change) => change.optionId === opt.id);
          const actions = changes.map((change, index) => (
            <div class="approval-option-action" key={index}>
              {changes.length > 1 && (
                <div class="approval-option-action-label">{change.label || `Action ${index + 1}`}</div>
              )}
              <LogContent value={changeDisplayContent(change)} forceMarkdown />
            </div>
          ));
          const body = (
            <div class="approval-option-main">
              <div class="approval-option-label">
                {opt.label}
                {opt.recommended && <span class="approval-option-badge">recommended</span>}
                {isDecided && <span class="approval-option-badge picked">picked</span>}
              </div>
              {opt.description && <div class="approval-option-desc"><InlineMarkdown value={opt.description} /></div>}
              {/* Unselected candidates keep their 3-line CSS clamp: they are
                  there to stay comparable, not to be read end to end. */}
              {isSelected && actions.length > 0
                ? <SelectedOptionActions>{actions}</SelectedOptionActions>
                : actions}
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
                  name={props.groupName}
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
  /** Log entry id. Scopes this card's element ids and its radio group name:
   *  a session can render several gates, and a module-constant radio name
   *  would silently merge them into one group where picking in one clears
   *  the other. */
  entryId: string;
  sessionId: string;
  token: string | undefined;
  selectedChoice?: string | undefined;
  onSelectChoice?: ((id: string) => void) | undefined;
}) {
  const details = props.details;
  // Non-alphanumerics out: an entry id ends up in an id/`for` pair and a radio
  // group name, and a stray quote or space breaks the association silently.
  const idBase = `gate-${props.entryId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
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
  // Same on a pick gate whose options carry their own text: the cards already
  // show every candidate, so the prose draft would make the reviewer read each
  // one twice. A pick gate with bare options (no per-option change) keeps the
  // draft open, since then it is the only place the candidates live.
  const optionsCarryText = options.length > 0 && options.every((o) => optionChanges.some((c) => c.optionId === o.id));
  const demotePrimary = Boolean(primary) && (optionsCarryText || (options.length === 0 && standaloneChanges.length > 0));
  const primaryTitle = primary && demotePrimary && optionsCarryText ? `${primary.title} notes` : primary?.title;
  const links = [
    details.draftUrl ? <a class="approval-link" href={details.draftUrl} target="_blank" rel="noopener noreferrer">Open draft</a> : null,
    details.artifactUrl ? <a class="approval-link" href={details.artifactUrl} target="_blank" rel="noopener noreferrer">Open artifact</a> : null,
  ].filter(Boolean);
  const hasContent = details.prompt || primary || changes.length > 0 || options.length > 0 || details.reference || details.risk || showSummary || details.context || links.length > 0 || artifactPaths.length > 0 || snapshotOnlyPaths.length > 0 || detectedImagePaths.length > 0 || decisionLabel || details.decisionComment || details.errorMessage;
  if (!hasContent) return null;

  return (
    <div class="approval-card">
      {/* A heading, not a div: it is the actual ask, so heading navigation has
          to land on it. Without this a screen-reader user tabbing by heading
          skipped straight past the question the whole card exists to pose. */}
      {details.prompt && <h3 class="approval-question"><InlineMarkdown value={details.prompt} /></h3>}
      {/* What approving does in the world comes first: the reviewer needs it
          before reading any candidate, not after scrolling past all of them.
          role="note" so the warning survives without the amber wash, which is
          otherwise the only thing marking this section as different in kind. */}
      {details.risk && (
        <section class="approval-section approval-risk" role="note" aria-labelledby={`${idBase}-risk`}>
          <h4 class="approval-section-title" id={`${idBase}-risk`}>Risk / consequence</h4>
          <div class="approval-section-body"><LogContent value={stripEchoedHeading(details.risk, 'Risk / consequence')} forceMarkdown /></div>
        </section>
      )}
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
          <h4 class="approval-section-title">{artifactPaths.length + snapshotOnlyPaths.length + detectedImagePaths.length > 1 ? 'Artifacts' : 'Artifact'}</h4>
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
            <summary>{primaryTitle}</summary>
            <div class="approval-section-body">{primary.body}</div>
          </details>
        )
        : (
          <section class="approval-section approval-primary">
            <h4 class="approval-section-title">{primary.title}</h4>
            <div class="approval-section-body">{primary.body}</div>
          </section>
        ))}
      {links.length > 0 && (
        <section class="approval-section approval-links">
          <h4 class="approval-section-title">Links</h4>
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
            <div class="approval-section-body"><LogContent value={stripEchoedHeading(details.summary!, 'Why this request')} forceMarkdown /></div>
          </details>
        )
        : (
          <section class="approval-section approval-secondary">
            <h4 class="approval-section-title">Why this request</h4>
            <div class="approval-section-body"><LogContent value={stripEchoedHeading(details.summary!, 'Why this request')} forceMarkdown /></div>
          </section>
        ))}
      {details.context && (
        <details class={`approval-section approval-context${changes.length === 0 ? ' approval-context-open' : ''}`} open={changes.length === 0}>
          <summary>Source context</summary>
          <div class="approval-section-body"><LogContent value={stripEchoedHeading(details.context, 'Source context')} forceMarkdown /></div>
        </details>
      )}
      {options.length > 0 && (
        // Last content section by design: the feed auto-scrolls to the end, so
        // the reviewer lands here, and the pick sits directly above the
        // Approve/Reject/Comment row it feeds. Evidence above, decision below.
        <OptionsBlock
          groupName={`${idBase}-pick`}
          options={options}
          changes={optionChanges}
          selected={props.selectedChoice}
          decided={details.decisionChoice}
          onSelect={props.onSelectChoice}
        />
      )}
      {decisionLabel && (
        <section class="approval-section approval-decision">
          <h4 class="approval-section-title">Decision</h4>
          <div class="approval-section-body">{decisionLabel}</div>
        </section>
      )}
      {details.decisionComment && (
        <section class="approval-section approval-secondary">
          <h4 class="approval-section-title">Comment</h4>
          <div class="approval-section-body"><LogContent value={details.decisionComment} forceMarkdown /></div>
        </section>
      )}
      {details.errorMessage && (
        <section class="approval-section approval-risk">
          <h4 class="approval-section-title">Error</h4>
          <div class="approval-section-body">{details.errorMessage}</div>
        </section>
      )}
    </div>
  );
}

function formatSessionDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || durationMs < 0) return undefined;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}

/**
 * What the child is doing, on the parent's own card. A running card otherwise
 * shows only the task the child was handed, so the reader had to open the child
 * session to learn what it was working on.
 *
 * Two sources, in order of freshness: the child's own event stream when a live
 * slot is free (moves with every step the child takes), and otherwise the newest
 * tool step captured in the parent's last fetch, which only advances when the
 * parent's log refetches.
 */
function SubagentActivity(props: { session: LogSubagentSession; projectId?: string }) {
  const s = props.session;
  const activity = s.activity;
  const live = Boolean(props.projectId)
    && !s.synthetic
    && (isExecutingCardStatus(s.status) || isExecutingCardStatus(s.displayStatus));
  const slot = useTailSlot(live);
  const tail = useSessionTail(s.sessionId, props.projectId ?? '', live && slot);

  const [now, setNow] = useState(() => Date.now());
  // Each new tail line restarts the timer, so the elapsed value answers "how
  // long has it been on this step" rather than how long the card has existed.
  const [since, setSince] = useState(() => Date.now());
  useEffect(() => { setSince(Date.now()); }, [tail?.text]);
  const running = tail ? true : activity?.running === true;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, since, activity?.startedAt]);

  if (!tail && !activity) return null;
  const startedAt = tail ? since : activity!.startedAt;
  const elapsed = running ? formatSessionDuration(Math.max(0, now - startedAt)) : undefined;
  const label = tail ? 'now' : activity!.running ? 'now' : 'last';
  const tool = tail ? tail.tool && tail.text : activity!.tool;
  const detail = tail ? (tail.tool ? undefined : tail.text) : activity!.detail;
  const steps = activity?.steps;
  const meta = [steps !== undefined ? `step ${steps}` : undefined, elapsed].filter(Boolean).join(' · ');
  return (
    <span class={`subagent-activity${running ? ' is-running' : ''}`}>
      <span class="subagent-activity-label">{label}</span>
      {tool && <code class="subagent-activity-tool">{tool}</code>}
      {detail && <span class="subagent-activity-detail">{detail}</span>}
      {meta && <span class="subagent-activity-meta">{meta}</span>}
    </span>
  );
}

function VerifyEventCard(props: { event: Extract<LogSubagentEvent, { type: 'verify' }> }) {
  const event = props.event;
  const name = event.mode === 'inline' ? 'Inline criteria' : 'Judge setup';
  const breadcrumb = event.breadcrumb.map((entry) => entry.agentName).join(' › ');
  const failed = event.verdict !== 'pass';
  const statusClass = failed ? 'error' : 'completed';
  const ownerName = event.breadcrumb.at(-1)?.agentName ?? 'owning session';
  const inner = (
    <>
      <span class={`chip status ${statusClass}`}>{event.displayStatus}</span>
      <span class="subagent-identity">
        <span class="subagent-name">{name}</span>
        <span class="subagent-role judge">Judge</span>
      </span>
      <code class="subagent-id">{event.judge ?? 'inline'}</code>
      <span class="subagent-context">
        <strong>{event.attemptLabel}</strong>
        {breadcrumb && <span>{breadcrumb}</span>}
        <time dateTime={new Date(event.time).toISOString()}>{formatLogTime(event.time)}</time>
      </span>
      {event.critique && <span class="verify-event-critique">{event.critique}</span>}
    </>
  );
  const row = event.href
    ? <a class={`subagent-event verify-event${failed ? ' is-failure' : ''}`} href={event.href} aria-label={`Open inline Judge event in ${ownerName}`}>{inner}<span class="subagent-open-cue" aria-hidden="true">open ›</span></a>
    : <div class={`subagent-event verify-event${failed ? ' is-failure' : ''}`}>{inner}</div>;
  return <div class="subagent-tree-node is-important" data-event-id={event.id}>{row}</div>;
}

function ReviewerFeedbackEventCard(props: { event: Extract<LogSubagentEvent, { type: 'reviewer-feedback' }> }) {
  const event = props.event;
  const breadcrumb = event.breadcrumb.map((entry) => entry.agentName).join(' › ');
  const ownerName = event.breadcrumb.at(-1)?.agentName ?? 'owning session';
  const inner = (
    <>
      <span class="chip status commented">{event.displayStatus}</span>
      <span class="subagent-identity">
        <span class="subagent-name">Reviewer feedback</span>
        <span class="subagent-role reviewer">Human</span>
      </span>
      <span class="subagent-context">
        <strong>{event.roundLabel}</strong>
        {event.reviewer && <span>by {event.reviewer}</span>}
        {breadcrumb && <span>{breadcrumb}</span>}
        <time dateTime={new Date(event.time).toISOString()}>{formatLogTime(event.time)}</time>
      </span>
      <span class="reviewer-feedback-comment">{event.comment}</span>
    </>
  );
  const row = event.href
    ? <a class="subagent-event reviewer-feedback-event" href={event.href} aria-label={`Open reviewer feedback in ${ownerName}`}>{inner}<span class="subagent-open-cue" aria-hidden="true">open ›</span></a>
    : <div class="subagent-event reviewer-feedback-event">{inner}</div>;
  return <div class="subagent-tree-node is-important" data-event-id={event.id}>{row}</div>;
}

/** Statuses the card treats as still executing, mirroring the runtime's own
 * projection without pulling a node module into the browser bundle. */
function isExecutingCardStatus(status: string | undefined): boolean {
  return status === 'preparing' || status === 'running' || status === 'resuming'
    || status === 'continuing' || status === 'run' || status === 'revising';
}

function SubagentCard(props: { session: LogSubagentSession; projectId?: string }) {
  const s = props.session;
  const name = s.agent.name || s.agent.id;
  const judge = s.kinds?.includes('judge') === true;
  const breadcrumb = s.breadcrumb?.map((entry) => entry.agentName).join(' › ');
  const duration = formatSessionDuration(s.durationMs);
  const nested = [
    ...(s.children ?? []).map((session) => ({ type: 'session' as const, time: session.createdAt, session })),
    ...(s.events ?? []).map((event) => ({ type: 'event' as const, time: event.time, event })),
  ].sort((a, b) => a.time - b.time);
  const inner = (
    <>
      <span class={`chip status ${s.displayStatus}`}>{s.displayStatus}</span>
      <span class="subagent-identity">
        <span class="subagent-name">{name}</span>
        {judge && <span class="subagent-role judge">Judge</span>}
      </span>
      <code class="subagent-id">{s.synthetic ? `call ${s.sessionId}` : s.sessionId}</code>
      {(s.label || breadcrumb || s.createdAt) && (
        <span class="subagent-context">
          {s.label && <strong>{s.label}</strong>}
          {breadcrumb && <span>{breadcrumb}</span>}
          {s.createdAt && <time dateTime={new Date(s.createdAt).toISOString()}>{formatLogTime(s.createdAt)}</time>}
          {duration && <span>{duration}</span>}
        </span>
      )}
      <SubagentActivity session={s} {...(props.projectId && { projectId: props.projectId })} />
      {s.errorMessage && <span class="subagent-error">{s.errorMessage}</span>}
      {s.command && <span class="subagent-command">{s.command}</span>}
    </>
  );
  const row = s.href
    ? <a class="subagent-event" href={s.href} aria-label={`Open subagent session ${name || s.sessionId}`}>{inner}<span class="subagent-open-cue" aria-hidden="true">open ›</span></a>
    : <div class="subagent-event">{inner}</div>;
  return (
    <div class={`subagent-tree-node${s.important ? ' is-important' : ''}`} data-session-id={s.sessionId}>
      {row}
      {nested.length > 0 && (
        <div class="subagent-children" aria-label={`Important descendants and events of ${name}`}>
          {nested.map((item) => item.type === 'session'
            ? <SubagentCard key={item.session.sessionId} session={item.session} {...(props.projectId && { projectId: props.projectId })} />
            : item.event.type === 'reviewer-feedback'
              ? <ReviewerFeedbackEventCard key={item.event.id} event={item.event} />
              : <VerifyEventCard key={item.event.id} event={item.event} />)}
        </div>
      )}
    </div>
  );
}

/**
 * What the sub-agent actually delivered, shown on the parent's own row: the
 * child's one-line verdict and the artifacts it produced stay visible whether or
 * not the row is expanded, since they are the reason a reader scans a manager's
 * log at all. The report body expands with the row.
 *
 * Before this the row carried a status chip and a link and nothing else, so
 * reading a manager's run meant opening every child session in turn.
 */
function SubagentOutcome(props: { result: NonNullable<ApprovalLogDetails['subagentResult']> }) {
  const result = props.result;
  const verdict = result.incomplete ?? result.headline;
  const artifacts = result.artifacts ?? [];
  if (!verdict && artifacts.length === 0) return null;
  return (
    <div class={`subagent-outcome${result.incomplete ? ' is-incomplete' : ''}`}>
      {verdict && (
        <p class="subagent-verdict">
          <span class="subagent-verdict-mark" aria-hidden="true">{result.incomplete ? '⚠' : '✓'}</span>
          <InlineMarkdown value={verdict} />
        </p>
      )}
      {artifacts.length > 0 && (
        <ul class="subagent-artifacts" aria-label="Artifacts produced by this sub-agent">
          {artifacts.map((artifact) => (
            <li key={artifact}>
              {/^https?:\/\//i.test(artifact)
                ? <a href={artifact} target="_blank" rel="noopener noreferrer">{artifact}</a>
                : <code>{artifact}</code>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The run's own report, on the `report_complete` / `report_incomplete` row that
 * delivered it. Rendered outside the expand toggle on purpose: this call is the
 * run's answer rather than a step of the work, so the reader who scrolls to the
 * end of the log must land on the report itself, not on a collapsed row whose
 * raw JSON input happens to contain it. The toggle still opens the verbatim
 * input/output underneath.
 */
function RunOutcomeCard(props: { outcome: NonNullable<ApprovalLogDetails['runOutcome']> }) {
  const outcome = props.outcome;
  const incomplete = outcome.kind === 'incomplete';
  const artifacts = outcome.artifacts ?? [];
  return (
    <div class={`run-outcome${incomplete ? ' is-incomplete' : ''}`}>
      <p class="run-outcome-verdict">
        <span class="run-outcome-mark" aria-hidden="true">{incomplete ? '⚠' : '✓'}</span>
        <InlineMarkdown value={outcome.headline} />
      </p>
      {outcome.body && (
        <div class="run-outcome-body"><LogContent value={outcome.body} forceMarkdown /></div>
      )}
      {artifacts.length > 0 && (
        <ul class="subagent-artifacts" aria-label="Artifacts produced by this run">
          {artifacts.map((artifact) => (
            <li key={artifact}>
              {/^https?:\/\//i.test(artifact)
                ? <a href={artifact} target="_blank" rel="noopener noreferrer">{artifact}</a>
                : <code>{artifact}</code>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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

/** What a run's stored corrections did to it: injected, stored, and the cap. */
interface CorrectionsCounts {
  applied: number;
  active: number;
  cap: number;
}

/**
 * The numbers on a `corrections` marker. Read off the entry rather than
 * declared on ApprovalLogEntry, which is the single transport shape every part
 * type shares. Absent numbers mean a run recorded before the marker existed, and
 * the row falls back to the title the session log gave it rather than inventing
 * counts it cannot support.
 */
function correctionsCounts(entry: ApprovalLogEntry): CorrectionsCounts | undefined {
  if (entry.type !== 'corrections') return undefined;
  const { applied, active, cap } = valueAsRecord(entry);
  if (typeof applied !== 'number' || typeof active !== 'number' || typeof cap !== 'number') return undefined;
  return { applied, active, cap };
}

/**
 * The corrections row's own words: what applied, and only then what did not.
 *
 * The dormant remainder is the actionable half — those corrections are stored
 * and ranked, and had no effect on this run — so it carries the amber pill this
 * file already uses for a warning about a row, rather than a colour of its own.
 * With nothing dormant there is no second clause: "0 over the cap" is chrome.
 */
function CorrectionsSummary(props: { counts: CorrectionsCounts }) {
  const { applied, active, cap } = props.counts;
  const dormant = Math.max(active - applied, 0);
  return (
    <>
      {dormant > 0
        ? `${applied} of ${active} learnings applied`
        : `${applied} learning${applied === 1 ? '' : 's'} applied`}
      {dormant > 0 && (
        <span
          class="log-warn-badge"
          title={`Stored, but ranked below the per-run cap of ${cap}, so this run never saw them`}
        >⚠ {dormant} over the cap of {cap}</span>
      )}
    </>
  );
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
export function toolChipLabel(tool: string): string {
  const segments = tool.split('__').filter(Boolean);
  if (segments.length > 1 && segments[0] === 'tools') segments.shift();
  return segments.join(' · ');
}

function LogEntryImpl(props: LogEntryProps) {
  const { entry } = props;
  const warnings = props.warnings ?? [];
  const isApprovalEntry = isApprovalDetails(entry);
  const savedArtifact = entry.details?.savedArtifact;
  const subagentResult = entry.details?.subagentResult;
  const runOutcome = entry.details?.runOutcome;
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
  // A corrections marker states itself in one line, so the counts are the row.
  const corrections = correctionsCounts(entry);
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
      id={`log-${entry.id}`}
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
        >{spinning ? <span class="log-spinner" aria-label="streaming" /> : (entry.type === 'compaction' ? '⇲' : entry.type === 'learning' ? '✦' : entry.type === 'corrections' ? '✧' : entry.type === 'verify' ? (entry.status === 'completed' ? '✓' : '⚖') : entry.type === 'error' ? '✗' : entry.type === 'reasoning' ? '✻' : entry.type === 'log' ? logLevelMarker(entry.level) : failed ? '✗' : entry.type === 'tool' && entry.status === 'completed' ? '✓' : '⋮')}</span>
        <span class="log-title">
          {corrections
            ? <CorrectionsSummary counts={corrections} />
            : entry.type === 'tool' && entry.tool && !isApprovalEntry
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
        {entry.subagentSession && <SubagentCard session={entry.subagentSession} {...(props.projectId && { projectId: props.projectId })} />}
        {subagentResult && <SubagentOutcome result={subagentResult} />}
        {runOutcome && <RunOutcomeCard outcome={runOutcome} />}
        {savedArtifact && <SavedArtifactCard artifact={savedArtifact} sessionId={props.sessionId} token={props.token} />}
        <div class="log-content">
          {storeEvent && <StoreEventBlock event={storeEvent} />}
          {subagentResult?.body && (
            <div class="subagent-report"><LogContent value={subagentResult.body} forceMarkdown /></div>
          )}
          {entry.details && (isApprovalEntry
            ? <ApprovalDetailCard
                details={entry.details}
                entryId={entry.id}
                sessionId={props.sessionId}
                token={props.token}
                selectedChoice={props.selectedChoice}
                onSelectChoice={props.showActions ? props.onSelectChoice : undefined}
              />
            : <ToolDetails details={entry.details} sessionId={props.sessionId} token={props.token} />)}
          {/* The counts are the whole corrections row; anything the session log
              also wrote about them would restate the line above. */}
          {message && !corrections && !storeEvent && !entry.subagentSession && <LogContent value={message} forceMarkdown={prose} />}
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
            {/* Least to most committing, left to right: Approve is the last
                thing under the cursor and the last thing keyboard focus lands
                on, so neither reaches it by accident. */}
            <div class="log-actions-buttons">
              <button disabled={props.actionsDisabled} onClick={() => props.onAction('comment')}>Comment</button>
              <button class="danger" disabled={props.actionsDisabled} onClick={() => props.onAction('reject')}>Reject</button>
              <button
                class="primary"
                disabled={props.actionsDisabled || awaitingPick}
                title={awaitingPick ? 'Pick one of the options above first' : undefined}
                onClick={() => props.onAction('approve')}
              >
                {selectedOptionLabel ? <>Approve<span class="approve-choice-label">“{selectedOptionLabel}”</span></> : 'Approve'}
              </button>
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
