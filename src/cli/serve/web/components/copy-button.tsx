import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { writeClipboardText } from '../lib/clipboard';

function CopyIcon(props: { copied: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {props.copied ? <path d="m5 12 4 4 10-10" /> : <>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V5h10" />
      </>}
    </svg>
  );
}

/**
 * Copy-to-clipboard control. `label` names what gets copied, so a page with
 * several of these does not read as a list of identical "copy" buttons.
 * The icon variant sits inside a table cell; the button variant is a toolbar
 * action with visible text.
 */
export function CopyButton(props: {
  text: string;
  label: string;
  variant?: 'icon' | 'button';
  /** Extra class, when the surrounding layout styles its own copy control. */
  class?: string;
  onCopied?: () => void;
  children?: ComponentChildren;
}) {
  const [copied, setCopied] = useState(false);
  const what = `Copy ${props.label} to clipboard`;
  const variant = props.variant ?? 'icon';
  return (
    <button
      type="button"
      class={`copy-btn ${variant}${copied ? ' copied' : ''}${props.class ? ` ${props.class}` : ''}`}
      title={copied ? 'Copied' : what}
      aria-label={copied ? `${what} — copied` : what}
      onClick={(event) => {
        event.stopPropagation();
        void writeClipboardText(props.text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          props.onCopied?.();
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <CopyIcon copied={copied} />
      {props.children && <span>{copied ? 'Copied' : props.children}</span>}
    </button>
  );
}
