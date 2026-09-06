import { join } from 'path';
import { tmpdir } from 'os';

// Tests must not discover credentials, plugins, or other durable state from the
// developer's real AgentUse profile. Sandbox through XDG_DATA_HOME rather than
// AGENTUSE_DATA_DIR: the direct override wins over XDG, so tests that point
// XDG_DATA_HOME at their own fixture (the learning suites) would otherwise be
// silently ignored. Tests that need the direct override set it themselves and
// restore it afterward.
delete process.env.AGENTUSE_DATA_DIR;
process.env.XDG_DATA_HOME = join(tmpdir(), `agentuse-test-data-${process.pid}`);
