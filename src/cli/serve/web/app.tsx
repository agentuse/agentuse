import { ErrorBoundary, LocationProvider, Router, Route, lazy, useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';
import { AppShell } from './components/app-shell';
import { AgentPalette } from './components/agent-palette';
import { ApprovalToast } from './components/approval-toast';
import { NavTracker } from './hooks/use-smart-back';
import { GlobalApprovalsProvider } from './hooks/use-global-approvals';
import { reloadOnChunkError } from './lib/lazy-route';

const Home = lazy(reloadOnChunkError(() => import('./routes/home')));
const Onboarding = lazy(reloadOnChunkError(() => import('./routes/onboarding')));
const Agents = lazy(reloadOnChunkError(() => import('./routes/agents')));
const AgentDetail = lazy(reloadOnChunkError(() => import('./routes/agent-detail')));
const Schedules = lazy(reloadOnChunkError(() => import('./routes/schedules')));
const SessionsList = lazy(reloadOnChunkError(() => import('./routes/sessions-list')));
const SessionDetail = lazy(reloadOnChunkError(() => import('./routes/session-detail')));
const SessionContext = lazy(reloadOnChunkError(() => import('./routes/session-context')));
const ApprovalsList = lazy(reloadOnChunkError(() => import('./routes/approvals-list')));
const StoresIndex = lazy(reloadOnChunkError(() => import('./routes/stores-index')));
const StoreItems = lazy(reloadOnChunkError(() => import('./routes/store-items')));
const StoreItemDetail = lazy(reloadOnChunkError(() => import('./routes/store-item-detail')));
const Settings = lazy(reloadOnChunkError(() => import('./routes/settings')));
const LearningsTidy = lazy(reloadOnChunkError(() => import('./routes/learnings-tidy')));

// The shell's #boot spinner (static.ts) covers bundle download AND the first
// lazy route chunk: it lives outside #app so mounting the (route-less) app
// shell doesn't clear it. Remove it once the first route actually commits.
function dismissBootLoader() {
  document.getElementById('boot')?.remove();
}

// Drives the thin top progress bar (app.css html[data-route-loading]) while a
// lazy route chunk is in flight; preact-iso keeps the previous route on screen
// during the load, so this is the only cue that navigation is happening.
function setRouteLoading(on: boolean) {
  document.documentElement.toggleAttribute('data-route-loading', on);
}

function NotFound() {
  // The only non-lazy route: it commits synchronously, so neither Router
  // onLoadEnd (never suspended) nor onRouteChange (first commit) fires on a
  // direct load of an unmatched URL. Dismiss the boot loader here or the
  // shell overlay would sit above the 404 page forever.
  useEffect(() => {
    setRouteLoading(false);
    dismissBootLoader();
  }, []);
  return (
    <div class="page-home">
      <main>
        <h1>Not found</h1>
        <p class="empty">This page does not exist. Try <a href="/sessions">sessions</a> or <a href="/stores">stores</a>.</p>
      </main>
    </div>
  );
}

function AppRoutes() {
  return (
    <Router
      onLoadStart={() => setRouteLoading(true)}
      onLoadEnd={() => {
        setRouteLoading(false);
        dismissBootLoader();
      }}
      onRouteChange={() => {
        setRouteLoading(false);
        dismissBootLoader();
      }}
    >
      <Route path="/" component={Home} />
      <Route path="/onboarding" component={Onboarding} />
      <Route path="/agents" component={Agents} />
      <Route path="/agents/:project" component={Agents} />
      <Route path="/agents/:project/:agent*" component={AgentDetail} />
      <Route path="/schedules" component={Schedules} />
      <Route path="/sessions" component={SessionsList} />
      <Route path="/sessions/:sessionId" component={SessionDetail} />
      {/* Diagnostic subpage: what was actually loaded into this run's context window. */}
      <Route path="/sessions/:sessionId/context" component={SessionContext} />
      <Route path="/approvals" component={ApprovalsList} />
      <Route path="/stores" component={StoresIndex} />
      <Route path="/stores/:store" component={StoreItems} />
      <Route path="/stores/:store/:item" component={StoreItemDetail} />
      <Route path="/settings" component={Settings} />
      {/* Query-addressed (?project=&path=&job=): an agent path has slashes
          of its own, which would be ambiguous under /agents/:project/:agent*. */}
      <Route path="/learnings/tidy" component={LearningsTidy} />
      <Route default component={NotFound} />
    </Router>
  );
}

function RoutedApp() {
  const location = useLocation();
  const pathname = new URL(location.url, 'https://agentuse.local').pathname;
  if (pathname === '/onboarding') return <AppRoutes />;
  return <AppShell><AppRoutes /></AppShell>;
}

export function App() {
  return (
    <LocationProvider>
      <NavTracker />
      <ErrorBoundary>
        <GlobalApprovalsProvider>
          <AgentPalette />
          <ApprovalToast />
          <RoutedApp />
        </GlobalApprovalsProvider>
      </ErrorBoundary>
    </LocationProvider>
  );
}
