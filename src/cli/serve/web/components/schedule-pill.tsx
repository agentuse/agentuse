import { createPortal } from 'preact/compat';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

interface TooltipPosition {
  left: number;
  top: number;
  below: boolean;
}

/**
 * Compact schedule treatment used throughout the serve UI.
 *
 * Keep the cron expression visible so schedule-heavy lists stay scannable;
 * the expanded wording appears in a real hover/focus tooltip instead of
 * relying on the browser's inconsistent native `title` treatment.
 */
export function SchedulePill(props: {
  schedule: string;
  human?: string | undefined;
  enabled?: boolean | undefined;
  class?: string | undefined;
}) {
  const explanation = props.human ?? props.schedule;
  const paused = props.enabled === false;
  const pillRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const scheduleLabel = explanation === props.schedule
    ? props.schedule
    : `${props.schedule} — ${explanation}`;
  const accessibleLabel = paused ? `Paused schedule — ${scheduleLabel}` : scheduleLabel;

  const showTooltip = () => {
    const rect = pillRef.current?.getBoundingClientRect();
    if (!rect) return;

    const maxWidth = Math.min(320, window.innerWidth - 24);
    const halfWidth = maxWidth / 2;
    const center = rect.left + rect.width / 2;
    const left = Math.min(
      Math.max(center, 12 + halfWidth),
      window.innerWidth - 12 - halfWidth
    );
    const below = rect.top < 64;
    setPosition({ left, top: below ? rect.bottom + 8 : rect.top - 8, below });
  };

  useEffect(() => {
    if (!position) return;
    const hideTooltip = () => setPosition(null);
    window.addEventListener('scroll', hideTooltip, true);
    window.addEventListener('resize', hideTooltip);
    return () => {
      window.removeEventListener('scroll', hideTooltip, true);
      window.removeEventListener('resize', hideTooltip);
    };
  }, [position]);

  return (
    <>
      <span
        ref={pillRef}
        class={`schedule-pill${paused ? ' is-paused' : ''}${props.class ? ` ${props.class}` : ''}`}
        tabIndex={0}
        aria-label={accessibleLabel}
        aria-describedby={position ? tooltipId : undefined}
        onMouseEnter={showTooltip}
        onMouseLeave={() => setPosition(null)}
        onFocus={showTooltip}
        onBlur={() => setPosition(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setPosition(null);
        }}
      >
        {paused && <span class="schedule-pill-state">Paused</span>}
        <span>{props.schedule}</span>
      </span>
      {position && createPortal(
        <span
          id={tooltipId}
          class={`schedule-tooltip${position.below ? ' below' : ''}`}
          role="tooltip"
          style={{ left: `${position.left}px`, top: `${position.top}px` }}
        >
          {paused ? `Paused · ${explanation}` : explanation}
        </span>,
        document.body
      )}
    </>
  );
}
