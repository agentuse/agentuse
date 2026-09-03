import { useEffect, useState } from 'preact/hooks';
import { Check, TriangleAlert } from 'lucide-preact';
import { writeClipboardText } from '../lib/clipboard';
import { COPY_PAGE_LINK_EVENT, currentPageLink, isCopyPageLinkShortcut } from '../lib/copy-page-link';

const DISMISS_AFTER_MS = 2_000;

type Notice = { kind: 'copied'; url: string } | { kind: 'failed' };

/**
 * ⌘⇧C anywhere in the app copies a shareable link to the current page. The
 * Mac app binds the key natively (Edit ▸ Copy Link to Page) and dispatches
 * COPY_PAGE_LINK_EVENT; on the web this component registers the keydown
 * itself, mirroring how the shell handles ⌘B and ⌘1-⌘6.
 */
export function CopyLinkToast() {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const copy = async () => {
      const url = await currentPageLink();
      const ok = await writeClipboardText(url);
      setNotice(ok ? { kind: 'copied', url } : { kind: 'failed' });
      clearTimeout(timer);
      timer = setTimeout(() => setNotice(null), DISMISS_AFTER_MS);
    };
    const onEvent = () => void copy();
    const onKeyDown = (event: KeyboardEvent) => {
      if (window.agentuseDesktop || !isCopyPageLinkShortcut(event)) return;
      event.preventDefault();
      void copy();
    };
    window.addEventListener(COPY_PAGE_LINK_EVENT, onEvent);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(COPY_PAGE_LINK_EVENT, onEvent);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  if (!notice) return null;
  if (notice.kind === 'failed') {
    return (
      <div class="copy-link-toast is-error" role="status" aria-live="polite">
        <TriangleAlert aria-hidden="true" strokeWidth={1.8} />
        <span>Could not copy the link</span>
      </div>
    );
  }
  return (
    <div class="copy-link-toast" role="status" aria-live="polite">
      <Check aria-hidden="true" strokeWidth={2} />
      <span>Link copied</span>
      <span class="copy-link-toast-url">{notice.url}</span>
    </div>
  );
}
