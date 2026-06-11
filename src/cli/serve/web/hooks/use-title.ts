import { useEffect } from 'preact/hooks';

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
