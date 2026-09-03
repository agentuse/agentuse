import { join } from 'path';
import { tmpdir } from 'os';

// Tests must not discover credentials, plugins, or other durable state from the
// developer's real AgentUse profile. Individual tests may replace this data
// root with their own fixtures and restore it afterward.
process.env.AGENTUSE_DATA_DIR = join(tmpdir(), `agentuse-test-data-${process.pid}`);
