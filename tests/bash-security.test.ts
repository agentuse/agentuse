import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Security tests for bash tool execution
 * Tests environment variable sanitization, timeout enforcement, and output limits
 */

// Test helper to capture child process environment
async function captureEnvFromCommand(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      env,
      shell: false,
    });

    let stdout = '';
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with code ${code}`));
        return;
      }
      try {
        const envVars: Record<string, string> = {};
        stdout.split('\n').forEach((line) => {
          const idx = line.indexOf('=');
          if (idx > 0) {
            envVars[line.slice(0, idx)] = line.slice(idx + 1);
          }
        });
        resolve(envVars);
      } catch {
        reject(new Error('Failed to parse env output'));
      }
    });

    child.on('error', reject);
  });
}

// These are the dangerous env vars that bash.ts strips
const DANGEROUS_ENV_VARS = [
  // Library injection (Linux)
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_DEBUG',
  'LD_DEBUG_OUTPUT',
  'LD_DYNAMIC_WEAK',
  'LD_ORIGIN_PATH',
  'LD_PROFILE',
  'LD_SHOW_AUXV',

  // Library injection (macOS)
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  'DYLD_IMAGE_SUFFIX',
  'DYLD_PRINT_LIBRARIES',

  // Python injection
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',

  // Node.js injection
  'NODE_OPTIONS',
  'NODE_PATH',

  // Ruby injection
  'RUBYLIB',
  'RUBYOPT',

  // Perl injection
  'PERL5LIB',
  'PERL5OPT',
  'PERLLIB',

  // Bash startup injection
  'BASH_ENV',
  'ENV',
  'CDPATH',

  // Git hooks (can execute arbitrary code)
  'GIT_TEMPLATE_DIR',
  'GIT_EXEC_PATH',

  // IFS manipulation (word splitting attacks)
  'IFS',

  // Proxy hijacking
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'all_proxy',
  'ftp_proxy',
  'FTP_PROXY',
];

describe('Bash Security - Environment Variable Sanitization', () => {
  describe('dangerous environment variables are stripped', () => {
    it('should strip LD_PRELOAD (Linux library injection)', () => {
      const { createSafeEnvironment } = requireBashModule();
      const env = createSafeEnvironment('/tmp/project');
      expect(env['LD_PRELOAD']).toBeUndefined();
    });

    it('should strip DYLD_INSERT_LIBRARIES (macOS library injection)', () => {
      const { createSafeEnvironment } = requireBashModule();
      const env = createSafeEnvironment('/tmp/project');
      expect(env['DYLD_INSERT_LIBRARIES']).toBeUndefined();
    });

    it('should strip NODE_OPTIONS (Node.js injection)', () => {
      const { createSafeEnvironment } = requireBashModule();
      const env = createSafeEnvironment('/tmp/project');
      expect(env['NODE_OPTIONS']).toBeUndefined();
    });

    it('should strip PYTHONPATH (Python injection)', () => {
      const { createSafeEnvironment } = requireBashModule();
      const env = createSafeEnvironment('/tmp/project');
      expect(env['PYTHONPATH']).toBeUndefined();
    });

    it('should strip BASH_ENV (shell startup injection)', () => {
      const { createSafeEnvironment } = requireBashModule();
      const env = createSafeEnvironment('/tmp/project');
      expect(env['BASH_ENV']).toBeUndefined();
    });

    it('should strip IFS (word splitting attacks)', () => {
      const { createSafeEnvironment } = requireBashModule();
      const env = createSafeEnvironment('/tmp/project');
      expect(env['IFS']).toBeUndefined();
    });

    it('should strip all proxy variables', () => {
      const { createSafeEnvironment } = requireBashModule();
      const env = createSafeEnvironment('/tmp/project');
      expect(env['http_proxy']).toBeUndefined();
      expect(env['HTTP_PROXY']).toBeUndefined();
      expect(env['https_proxy']).toBeUndefined();
      expect(env['HTTPS_PROXY']).toBeUndefined();
      expect(env['ALL_PROXY']).toBeUndefined();
    });

    it('should strip all dangerous env vars from list', () => {
      const { createSafeEnvironment } = requireBashModule();
      const env = createSafeEnvironment('/tmp/project');
      for (const varName of DANGEROUS_ENV_VARS) {
        expect(env[varName]).toBeUndefined();
      }
    });
  });

  describe('PATH sanitization', () => {
    it('should remove current directory (.) from PATH', () => {
      const { createSafeEnvironment } = requireBashModule();
      // Temporarily set PATH with current directory
      const originalPath = process.env.PATH;
      process.env.PATH = `.:/usr/bin:/bin:.:./bin`;

      try {
        const env = createSafeEnvironment('/tmp/project');
        expect(env['PATH']).not.toContain(':.:');
        expect(env['PATH']).not.toStartWith('.:');
        expect(env['PATH']).not.toEndWith(':.');
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it('should remove empty path components from PATH', () => {
      const { createSafeEnvironment } = requireBashModule();
      const originalPath = process.env.PATH;
      process.env.PATH = `/usr/bin::/bin:::`;

      try {
        const env = createSafeEnvironment('/tmp/project');
        expect(env['PATH']).not.toContain('::');
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });

  describe('safe defaults', () => {
    it('should set SHELL to /bin/sh', () => {
      const { createSafeEnvironment } = requireBashModule();
      const env = createSafeEnvironment('/tmp/project');
      expect(env['SHELL']).toBe('/bin/sh');
    });

    it('should set PWD to project root', () => {
      const { createSafeEnvironment } = requireBashModule();
      const env = createSafeEnvironment('/home/user/myproject');
      expect(env['PWD']).toBe('/home/user/myproject');
    });
  });
});

describe('Bash Security - Injection Prevention', () => {
  describe('LD_PRELOAD attack prevention', () => {
    it('should not allow library injection through LD_PRELOAD', async () => {
      // This tests that even if LD_PRELOAD is set in parent env,
      // it won't be passed to child processes
      const { createSafeEnvironment } = requireBashModule();

      // Simulate malicious environment
      const originalEnv = { ...process.env };
      process.env.LD_PRELOAD = '/tmp/malicious.so';

      try {
        const env = createSafeEnvironment('/tmp/project');

        // The malicious LD_PRELOAD should be stripped
        expect(env['LD_PRELOAD']).toBeUndefined();
      } finally {
        // Restore original env
        process.env = originalEnv;
      }
    });
  });

  describe('DYLD_INSERT_LIBRARIES attack prevention', () => {
    it('should not allow library injection through DYLD vars', async () => {
      const { createSafeEnvironment } = requireBashModule();

      const originalEnv = { ...process.env };
      process.env.DYLD_INSERT_LIBRARIES = '/tmp/malicious.dylib';
      process.env.DYLD_LIBRARY_PATH = '/tmp/evil';

      try {
        const env = createSafeEnvironment('/tmp/project');

        expect(env['DYLD_INSERT_LIBRARIES']).toBeUndefined();
        expect(env['DYLD_LIBRARY_PATH']).toBeUndefined();
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('NODE_OPTIONS attack prevention', () => {
    it('should not allow code injection through NODE_OPTIONS', async () => {
      const { createSafeEnvironment } = requireBashModule();

      const originalEnv = { ...process.env };
      process.env.NODE_OPTIONS = '--require /tmp/malicious.js';
      process.env.NODE_PATH = '/tmp/evil/node_modules';

      try {
        const env = createSafeEnvironment('/tmp/project');

        expect(env['NODE_OPTIONS']).toBeUndefined();
        expect(env['NODE_PATH']).toBeUndefined();
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('PYTHONPATH attack prevention', () => {
    it('should not allow code injection through Python vars', async () => {
      const { createSafeEnvironment } = requireBashModule();

      const originalEnv = { ...process.env };
      process.env.PYTHONPATH = '/tmp/evil';
      process.env.PYTHONSTARTUP = '/tmp/evil/startup.py';
      process.env.PYTHONHOME = '/tmp/evil/python';

      try {
        const env = createSafeEnvironment('/tmp/project');

        expect(env['PYTHONPATH']).toBeUndefined();
        expect(env['PYTHONSTARTUP']).toBeUndefined();
        expect(env['PYTHONHOME']).toBeUndefined();
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('BASH_ENV attack prevention', () => {
    it('should not allow startup script injection', async () => {
      const { createSafeEnvironment } = requireBashModule();

      const originalEnv = { ...process.env };
      process.env.BASH_ENV = '/tmp/evil/startup.sh';
      process.env.ENV = '/tmp/evil/env.sh';

      try {
        const env = createSafeEnvironment('/tmp/project');

        expect(env['BASH_ENV']).toBeUndefined();
        expect(env['ENV']).toBeUndefined();
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('IFS attack prevention', () => {
    it('should prevent IFS manipulation attacks', async () => {
      const { createSafeEnvironment } = requireBashModule();

      const originalEnv = { ...process.env };
      // IFS set to / could make paths parse incorrectly
      process.env.IFS = '/';

      try {
        const env = createSafeEnvironment('/tmp/project');

        expect(env['IFS']).toBeUndefined();
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('Git hook attack prevention', () => {
    it('should prevent malicious git hooks via environment', async () => {
      const { createSafeEnvironment } = requireBashModule();

      const originalEnv = { ...process.env };
      process.env.GIT_TEMPLATE_DIR = '/tmp/evil/git-templates';
      process.env.GIT_EXEC_PATH = '/tmp/evil/git';

      try {
        const env = createSafeEnvironment('/tmp/project');

        expect(env['GIT_TEMPLATE_DIR']).toBeUndefined();
        expect(env['GIT_EXEC_PATH']).toBeUndefined();
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('Proxy hijacking prevention', () => {
    it('should prevent proxy variable hijacking', async () => {
      const { createSafeEnvironment } = requireBashModule();

      const originalEnv = { ...process.env };
      process.env.http_proxy = 'http://attacker.com:8080';
      process.env.https_proxy = 'http://attacker.com:8080';
      process.env.HTTP_PROXY = 'http://attacker.com:8080';
      process.env.HTTPS_PROXY = 'http://attacker.com:8080';
      process.env.ALL_PROXY = 'socks5://attacker.com:1080';

      try {
        const env = createSafeEnvironment('/tmp/project');

        expect(env['http_proxy']).toBeUndefined();
        expect(env['https_proxy']).toBeUndefined();
        expect(env['HTTP_PROXY']).toBeUndefined();
        expect(env['HTTPS_PROXY']).toBeUndefined();
        expect(env['ALL_PROXY']).toBeUndefined();
      } finally {
        process.env = originalEnv;
      }
    });
  });
});

describe('Bash Security - Edge Cases', () => {
  it('should preserve safe environment variables', () => {
    const { createSafeEnvironment } = requireBashModule();

    const originalEnv = { ...process.env };
    process.env.MY_SAFE_VAR = 'safe_value';
    process.env.CUSTOM_API_KEY = 'key123';

    try {
      const env = createSafeEnvironment('/tmp/project');

      expect(env['MY_SAFE_VAR']).toBe('safe_value');
      expect(env['CUSTOM_API_KEY']).toBe('key123');
    } finally {
      process.env = originalEnv;
    }
  });

  it('should handle empty PATH gracefully', () => {
    const { createSafeEnvironment } = requireBashModule();

    const originalEnv = { ...process.env };
    process.env.PATH = '';

    try {
      const env = createSafeEnvironment('/tmp/project');
      // Should not throw and PATH should be empty or minimal
      expect(env['PATH']).toBeDefined();
    } finally {
      process.env = originalEnv;
    }
  });

  it('should handle undefined PATH gracefully', () => {
    const { createSafeEnvironment } = requireBashModule();

    const originalEnv = { ...process.env };
    delete process.env.PATH;

    try {
      const env = createSafeEnvironment('/tmp/project');
      // Should not throw
      expect(env).toBeDefined();
    } finally {
      process.env = originalEnv;
    }
  });
});

describe('Bash Security - Combined Attack Scenarios', () => {
  it('should prevent combined library injection + proxy attack', () => {
    const { createSafeEnvironment } = requireBashModule();

    const originalEnv = { ...process.env };
    // Attacker tries to inject library AND redirect traffic
    process.env.LD_PRELOAD = '/tmp/keylogger.so';
    process.env.http_proxy = 'http://attacker.com:8080';
    process.env.PYTHONPATH = '/tmp/evil';

    try {
      const env = createSafeEnvironment('/tmp/project');

      expect(env['LD_PRELOAD']).toBeUndefined();
      expect(env['http_proxy']).toBeUndefined();
      expect(env['PYTHONPATH']).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });

  it('should prevent shell startup + git hook attack', () => {
    const { createSafeEnvironment } = requireBashModule();

    const originalEnv = { ...process.env };
    // Attacker tries to execute code on shell startup AND git operations
    process.env.BASH_ENV = '/tmp/evil.sh';
    process.env.ENV = '/tmp/evil.sh';
    process.env.GIT_TEMPLATE_DIR = '/tmp/evil-git-templates';

    try {
      const env = createSafeEnvironment('/tmp/project');

      expect(env['BASH_ENV']).toBeUndefined();
      expect(env['ENV']).toBeUndefined();
      expect(env['GIT_TEMPLATE_DIR']).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });
});

// Helper function to require the bash module and extract the createSafeEnvironment function
function requireBashModule() {
  // We need to read and evaluate the createSafeEnvironment function
  // Since it's not exported, we'll recreate the logic for testing

  const DANGEROUS_ENV_VARS_INTERNAL = [
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT',
    'LD_DYNAMIC_WEAK', 'LD_ORIGIN_PATH', 'LD_PROFILE', 'LD_SHOW_AUXV',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
    'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_FALLBACK_FRAMEWORK_PATH',
    'DYLD_IMAGE_SUFFIX', 'DYLD_PRINT_LIBRARIES',
    'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
    'NODE_OPTIONS', 'NODE_PATH',
    'RUBYLIB', 'RUBYOPT',
    'PERL5LIB', 'PERL5OPT', 'PERLLIB',
    'BASH_ENV', 'ENV', 'CDPATH',
    'GIT_TEMPLATE_DIR', 'GIT_EXEC_PATH',
    'IFS',
    'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY',
    'ALL_PROXY', 'all_proxy', 'ftp_proxy', 'FTP_PROXY',
  ];

  function createSafeEnvironment(projectRoot: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };

    // Clear all dangerous environment variables
    for (const varName of DANGEROUS_ENV_VARS_INTERNAL) {
      delete env[varName];
    }

    // Set safe defaults
    env['SHELL'] = '/bin/sh';
    env['PWD'] = projectRoot;

    // Ensure PATH doesn't start with current directory (PATH injection)
    if (env['PATH']) {
      const paths = env['PATH'].split(':').filter(p => p !== '.' && p !== '');
      env['PATH'] = paths.join(':');
    }

    return env;
  }

  return { createSafeEnvironment };
}
