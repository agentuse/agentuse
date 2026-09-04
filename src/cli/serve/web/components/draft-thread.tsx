import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ApprovalLogEntry } from '../../types';
import { LogEntry } from './log-entry';
import { isDebugLog } from '../lib/format';
import type { DraftExchangeTurn } from './draft-panel';

/**
 * The Changes thread: what was asked for, the steps that ran for it, and what
 * the author says it did, in order.
 *
 * Showing the work between the bubbles is the point. A reply that says "added
 * an early finish" is worth much more next to the skills it loaded and the
 * source it submitted than it is on its own, and the same rows the session page
 * renders are reused here so the two never describe a step differently.
 */

/**
 * A continued internal session records the operator's prompt as a "User
 * response" text entry. That entry is the only durable marker of where one turn
 * ends and the next begins, so it is what the split is keyed on.
 */
export function isTurnBoundary(entry: ApprovalLogEntry): boolean {
  return entry.type === 'text' && entry.title === 'User response';
}

export interface DraftTurnGroup {
  /** 0 for the original brief or instruction. */
  index: number;
  steps: ApprovalLogEntry[];
  turn: DraftExchangeTurn | undefined;
}

/**
 * Pair each turn's steps with its request and reply. Turn 0 is the original
 * brief, which has no request bubble of its own.
 */
export function groupDraftTurns(
  entries: readonly ApprovalLogEntry[],
  turns: readonly DraftExchangeTurn[],
): DraftTurnGroup[] {
  const steps: ApprovalLogEntry[][] = [[]];
  for (const entry of entries) {
    if (isDebugLog(entry)) continue;
    if (isTurnBoundary(entry)) {
      steps.push([]);
      continue;
    }
    steps[steps.length - 1]!.push(entry);
  }
  const count = Math.max(steps.length, turns.length);
  return Array.from({ length: count }, (_, index) => ({
    index,
    steps: steps[index] ?? [],
    turn: turns[index],
  }));
}

function stepDuration(steps: readonly ApprovalLogEntry[]): string | null {
  const times = steps.map((step) => step.time).filter((time): time is number => typeof time === 'number');
  if (times.length < 2) return null;
  const seconds = Math.round((Math.max(...times) - Math.min(...times)) / 1000);
  if (seconds <= 0) return null;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function DraftSteps(props: {
  steps: ApprovalLogEntry[];
  /** Open while the turn is still producing steps; closed once its reply lands. */
  defaultOpen: boolean;
  sessionId: string;
  projectId: string | undefined;
  token: string | undefined;
}) {
  const [open, setOpen] = useState(props.defaultOpen);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const wasDefaultOpen = useRef(props.defaultOpen);
  useEffect(() => {
    // Follow the turn's own lifecycle: open as it starts working, closed when
    // it settles. A reviewer who opened or closed it by hand after that keeps
    // their choice, because this only fires when the default itself flips.
    if (wasDefaultOpen.current !== props.defaultOpen) {
      wasDefaultOpen.current = props.defaultOpen;
      setOpen(props.defaultOpen);
    }
  }, [props.defaultOpen]);

  if (props.steps.length === 0) return null;
  const duration = stepDuration(props.steps);
  const label = `${props.steps.length} ${props.steps.length === 1 ? 'step' : 'steps'}`;

  return (
    <div class={`draft-steps${open ? ' is-open' : ''}`}>
      <button type="button" class="draft-steps-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span class="draft-steps-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>{label}{duration ? ` · ${duration}` : ''}</span>
      </button>
      {open && (
        <ul class="draft-steps-list">
          {props.steps.map((entry) => (
            <LogEntry
              key={entry.id}
              entry={entry}
              expanded={expanded[entry.id]}
              showActions={false}
              actionsDisabled
              projectId={props.projectId}
              sessionId={props.sessionId}
              token={props.token}
              onToggle={(id, next) => setExpanded((current) => ({ ...current, [id]: next }))}
              onAction={() => undefined}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function DraftThread(props: {
  turns: DraftExchangeTurn[];
  entries: ApprovalLogEntry[];
  /** The author is working right now, so the newest group stays open. */
  running: boolean;
  sessionId: string;
  projectId: string | undefined;
  token: string | undefined;
  /** The brief or instruction that started this session: turn 0's request. */
  leadRequest?: string | undefined;
  /** Extra context for turn 0, e.g. the evidence a revision was started from. */
  leadExtra?: ComponentChildren;
  emptyHint?: string;
}) {
  const groups = useMemo(() => groupDraftTurns(props.entries, props.turns), [props.entries, props.turns]);
  const ref = useRef<HTMLDivElement>(null);
  const lastGroup = groups[groups.length - 1];

  // After paint, so the measurement sees the laid-out thread. This also runs on
  // mount, which is what lands the operator at the newest turn when they switch
  // to this tab rather than at the top of an old conversation.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = ref.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [groups.length, lastGroup?.steps.length, lastGroup?.turn?.reply, props.running]);

  const hasContent = Boolean(props.leadRequest)
    || groups.some((group) => group.steps.length > 0 || group.turn?.request || group.turn?.reply);
  if (!hasContent) {
    return (
      <div class="draft-exchange is-empty" ref={ref}>
        <p>{props.emptyHint ?? 'No changes requested yet. Ask for one below and it becomes the next version.'}</p>
      </div>
    );
  }

  return (
    <div class="draft-exchange" ref={ref}>
      {groups.map((group) => {
        const isLast = group.index === groups.length - 1;
        return (
          <div class="draft-exchange-turn" key={group.index}>
            {group.index === 0 && props.leadRequest && (
              <div class="draft-exchange-request is-lead">{props.leadRequest}</div>
            )}
            {group.index === 0 && props.leadExtra}
            {group.turn?.request && <div class="draft-exchange-request">{group.turn.request}</div>}
            <DraftSteps
              steps={group.steps}
              defaultOpen={isLast && (props.running || !group.turn?.reply)}
              sessionId={props.sessionId}
              projectId={props.projectId}
              token={props.token}
            />
            {group.turn?.reply && <div class="draft-exchange-reply">{group.turn.reply}</div>}
          </div>
        );
      })}
    </div>
  );
}
