import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadGlobalConfig,
  getGlobalConfigPath,
  getGlobalEnvPath,
  loadGlobalEnv,
  expandHome,
} from '../src/utils/global-config';

function makeTmpConfig(content: string | object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentuse-cfg-'));
  const file = path.join(dir, 'config.json');
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(file, body);
  return file;
}

describe('getGlobalConfigPath', () => {
  const originalConfig = process.env.AGENTUSE_CONFIG;
  const originalEnv = process.env.AGENTUSE_ENV;
  afterEach(() => {
    if (originalConfig === undefined) delete process.env.AGENTUSE_CONFIG;
    else process.env.AGENTUSE_CONFIG = originalConfig;
    if (originalEnv === undefined) delete process.env.AGENTUSE_ENV;
    else process.env.AGENTUSE_ENV = originalEnv;
  });

  it('returns ~/.agentuse/config.json by default', () => {
    delete process.env.AGENTUSE_CONFIG;
    expect(getGlobalConfigPath()).toBe(path.join(os.homedir(), '.agentuse', 'config.json'));
  });

  it('honors AGENTUSE_CONFIG override', () => {
    process.env.AGENTUSE_CONFIG = '/tmp/custom-config.json';
    expect(getGlobalConfigPath()).toBe('/tmp/custom-config.json');
  });

  it('resolves relative AGENTUSE_CONFIG to absolute', () => {
    process.env.AGENTUSE_CONFIG = './relative.json';
    expect(path.isAbsolute(getGlobalConfigPath())).toBe(true);
  });

  it('returns ~/.agentuse/.env by default for server env', () => {
    delete process.env.AGENTUSE_ENV;
    expect(getGlobalEnvPath()).toBe(path.join(os.homedir(), '.agentuse', '.env'));
  });

  it('honors AGENTUSE_ENV override', () => {
    process.env.AGENTUSE_ENV = '/tmp/custom-agentuse.env';
    expect(getGlobalEnvPath()).toBe('/tmp/custom-agentuse.env');
  });
});

describe('loadGlobalEnv', () => {
  const originalAgentuseEnv = process.env.AGENTUSE_ENV;
  const originalValue = process.env.AGENTUSE_TEST_GLOBAL_ENV;

  afterEach(() => {
    if (originalAgentuseEnv === undefined) delete process.env.AGENTUSE_ENV;
    else process.env.AGENTUSE_ENV = originalAgentuseEnv;
    if (originalValue === undefined) delete process.env.AGENTUSE_TEST_GLOBAL_ENV;
    else process.env.AGENTUSE_TEST_GLOBAL_ENV = originalValue;
  });

  it('loads variables from AGENTUSE_ENV without overriding existing env by default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentuse-env-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'AGENTUSE_TEST_GLOBAL_ENV=from-file\n');
    process.env.AGENTUSE_ENV = file;
    process.env.AGENTUSE_TEST_GLOBAL_ENV = 'already-set';

    expect(loadGlobalEnv()).toBe(file);
    expect(process.env.AGENTUSE_TEST_GLOBAL_ENV).toBe('already-set');
  });

  it('returns undefined when the global env file does not exist', () => {
    const file = path.join(os.tmpdir(), `missing-agentuse-env-${Date.now()}`);
    process.env.AGENTUSE_ENV = file;
    delete process.env.AGENTUSE_TEST_GLOBAL_ENV;

    expect(loadGlobalEnv()).toBeUndefined();
    expect(process.env.AGENTUSE_TEST_GLOBAL_ENV).toBeUndefined();
  });
});

describe('expandHome', () => {
  it('expands leading ~/', () => {
    expect(expandHome('~/foo/bar')).toBe(path.join(os.homedir(), 'foo/bar'));
  });
  it('expands bare ~', () => {
    expect(expandHome('~')).toBe(os.homedir());
  });
  it('leaves absolute paths alone', () => {
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });
  it('leaves paths that merely contain ~ alone', () => {
    expect(expandHome('/foo~/bar')).toBe('/foo~/bar');
  });
});

describe('loadGlobalConfig', () => {
  it('returns null when file does not exist', () => {
    const file = path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`);
    expect(loadGlobalConfig(file)).toBeNull();
  });

  it('loads a valid minimal config', () => {
    const file = makeTmpConfig({
      serve: {
        projects: [{ path: '~/work/a' }, { id: 'docs', path: '/tmp/docs' }],
        default: 'docs',
      },
    });
    const cfg = loadGlobalConfig(file);
    expect(cfg?.serve?.projects).toHaveLength(2);
    expect(cfg?.serve?.projects?.[0]).toEqual({ path: '~/work/a' });
    expect(cfg?.serve?.projects?.[1]).toEqual({ id: 'docs', path: '/tmp/docs' });
    expect(cfg?.serve?.default).toBe('docs');
  });

  it('loads all serve fields', () => {
    const file = makeTmpConfig({
      serve: {
        port: 8080,
        host: '0.0.0.0',
        publicUrl: 'https://agentuse.example.com',
        auth: false,
        logFile: false,
      },
    });
    const cfg = loadGlobalConfig(file);
    expect(cfg?.serve?.port).toBe(8080);
    expect(cfg?.serve?.host).toBe('0.0.0.0');
    expect(cfg?.serve?.publicUrl).toBe('https://agentuse.example.com');
    expect(cfg?.serve?.auth).toBe(false);
    expect(cfg?.serve?.logFile).toBe(false);
  });

  it('returns empty object when file has no serve section', () => {
    const file = makeTmpConfig({});
    expect(loadGlobalConfig(file)).toEqual({});
  });

  it('throws on invalid JSON', () => {
    const file = makeTmpConfig('{ not json');
    expect(() => loadGlobalConfig(file)).toThrow(/Invalid JSON/);
  });

  it('throws when root is not an object', () => {
    const file = makeTmpConfig('[]');
    expect(() => loadGlobalConfig(file)).toThrow(/root must be a JSON object/);
  });

  it('throws when serve is not an object', () => {
    const file = makeTmpConfig({ serve: 'oops' });
    expect(() => loadGlobalConfig(file)).toThrow(/`serve` must be an object/);
  });

  it('throws when projects is not an array', () => {
    const file = makeTmpConfig({ serve: { projects: {} } });
    expect(() => loadGlobalConfig(file)).toThrow(/`serve.projects` must be an array/);
  });

  it('throws when a project is missing path', () => {
    const file = makeTmpConfig({ serve: { projects: [{ id: 'x' }] } });
    expect(() => loadGlobalConfig(file)).toThrow(/serve.projects\[0\].path is required/);
  });

  it('throws when a project id is empty', () => {
    const file = makeTmpConfig({ serve: { projects: [{ id: '', path: '/tmp' }] } });
    expect(() => loadGlobalConfig(file)).toThrow(/serve.projects\[0\].id/);
  });

  it('throws on invalid port', () => {
    const file = makeTmpConfig({ serve: { port: 70000 } });
    expect(() => loadGlobalConfig(file)).toThrow(/serve.port/);
  });

  it('throws on non-integer port', () => {
    const file = makeTmpConfig({ serve: { port: 3.14 } });
    expect(() => loadGlobalConfig(file)).toThrow(/serve.port/);
  });

  it('throws on non-boolean auth', () => {
    const file = makeTmpConfig({ serve: { auth: 'yes' } });
    expect(() => loadGlobalConfig(file)).toThrow(/serve.auth/);
  });

  it('throws on invalid publicUrl', () => {
    const file = makeTmpConfig({ serve: { publicUrl: 'not a url' } });
    expect(() => loadGlobalConfig(file)).toThrow(/serve.publicUrl/);
  });

  it('throws on empty default string', () => {
    const file = makeTmpConfig({ serve: { default: '' } });
    expect(() => loadGlobalConfig(file)).toThrow(/serve.default/);
  });
});

describe('loadGlobalConfig honors AGENTUSE_CONFIG when no path arg', () => {
  const original = process.env.AGENTUSE_CONFIG;
  let file: string;

  beforeEach(() => {
    file = makeTmpConfig({ serve: { port: 9999 } });
    process.env.AGENTUSE_CONFIG = file;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AGENTUSE_CONFIG;
    else process.env.AGENTUSE_CONFIG = original;
  });

  it('reads from AGENTUSE_CONFIG when no explicit path passed', () => {
    expect(loadGlobalConfig()?.serve?.port).toBe(9999);
  });
});
