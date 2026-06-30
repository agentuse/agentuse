import { ErrorBoundary, LocationProvider, Router, Route, lazy } from 'preact-iso';
import { Topbar } from './components/topbar';
import { AgentPalette } from './components/agent-palette';

const Home = lazy(() => import('./routes/home'));
const Agents = lazy(() => import('./routes/agents'));
const AgentDetail = lazy(() => import('./routes/agent-detail'));
const Schedules = lazy(() => import('./routes/schedules'));
const SessionsList = lazy(() => import('./routes/sessions-list'));
const SessionDetail = lazy(() => import('./routes/session-detail'));
const ApprovalsList = lazy(() => import('./routes/approvals-list'));
const StoresIndex = lazy(() => import('./routes/stores-index'));
const StoreItems = lazy(() => import('./routes/store-items'));
const StoreItemDetail = lazy(() => import('./routes/store-item-detail'));

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
      <ErrorBoundary>
        <AgentPalette />
        <Router>
          <Route path="/" component={Home} />
          <Route path="/agents" component={Agents} />
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
