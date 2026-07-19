import { render } from 'preact';
import { App } from './app';
import { initPushNavigation } from './lib/push-nav';
import { initSystemThemeSync } from './hooks/use-theme';
import './styles/app.css';

initPushNavigation();
initSystemThemeSync();

// Register the service worker eagerly (not only on push opt-in) so its
// cache-first asset handler makes repeat opens instant and offline-capable.
// register('/sw.js') is idempotent — the push flow reuses this registration.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
