import { ErrorBoundary, LocationProvider, Router, Route, lazy } from 'preact-iso';
import { Topbar } from './components/topbar';
import { AgentPalette } from './components/agent-palette';
import { NavTracker } from './hooks/use-smart-back';
import { reloadOnChunkError } from './lib/lazy-route';

const Home = lazy(reloadOnChunkError(() => import('./routes/home')));
const Agents = lazy(reloadOnChunkError(() => import('./routes/agents')));
const AgentDetail = lazy(reloadOnChunkError(() => import('./routes/agent-detail')));
const Schedules = lazy(reloadOnChunkError(() => import('./routes/schedules')));
const SessionsList = lazy(reloadOnChunkError(() => import('./routes/sessions-list')));
const SessionDetail = lazy(reloadOnChunkError(() => import('./routes/session-detail')));
const ApprovalsList = lazy(reloadOnChunkError(() => import('./routes/approvals-list')));
const StoresIndex = lazy(reloadOnChunkError(() => import('./routes/stores-index')));
const StoreItems = lazy(reloadOnChunkError(() => import('./routes/store-items')));
const StoreItemDetail = lazy(reloadOnChunkError(() => import('./routes/store-item-detail')));

function NotFound() {
  return (
    <div class="page-home">
      <Topbar />
      <main>
        <h1>Not found</h1>
        <p class="empty">This page does not exist. Try <a href="/sessions">sessions</a> or <a href="/stores">stores</a>.</p>
      </main>
    </div>
  );
}

export function App() {
  return (
    <LocationProvider>
      <NavTracker />
      <ErrorBoundary>
        <AgentPalette />
        <Router>
          <Route path="/" component={Home} />
          <Route path="/agents" component={Agents} />
          <Route path="/agents/:project" component={Agents} />
          <Route path="/agents/:project/:agent*" component={AgentDetail} />
          <Route path="/schedules" component={Schedules} />
          <Route path="/sessions" component={SessionsList} />
          <Route path="/sessions/:sessionId" component={SessionDetail} />
          <Route path="/approvals" component={ApprovalsList} />
          <Route path="/stores" component={StoresIndex} />
          <Route path="/stores/:store" component={StoreItems} />
          <Route path="/stores/:store/:item" component={StoreItemDetail} />
          <Route default component={NotFound} />
        </Router>
      </ErrorBoundary>
    </LocationProvider>
  );
}
