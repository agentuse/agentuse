import { join } from 'path';
import { tmpdir } from 'os';

// Tests must not discover and execute plugins installed in the developer's
// real AgentUse profile. Individual plugin tests replace this path with their
// own fixtures and restore it afterward.
process.env.AGENTUSE_PLUGIN_HOME = join(tmpdir(), `agentuse-test-plugins-${process.pid}`);
