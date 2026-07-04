import { render } from 'preact';
import { App } from './app';
import { initPushNavigation } from './lib/push-nav';
import './styles/app.css';

initPushNavigation();

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
