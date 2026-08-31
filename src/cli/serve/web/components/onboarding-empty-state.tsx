import { useEffect } from 'preact/hooks';
import type { SessionRow } from '../lib/api';
import { reportOnboardingTelemetry } from '../lib/api';
import { ProjectAgentDiscovery } from './project-agent-discovery';

export function OnboardingEmptyState(props: {
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  session?: SessionRow;
  compact?: boolean;
}) {
  useEffect(() => {
    reportOnboardingTelemetry({ event: 'onboarding_started' });
  }, []);
  if (!props.projectId || !props.projectPath) return null;
  return <ProjectAgentDiscovery projectId={props.projectId} {...(props.projectName ? { projectName: props.projectName } : {})} projectPath={props.projectPath} {...(props.compact ? { compact: true } : {})} />;
}
