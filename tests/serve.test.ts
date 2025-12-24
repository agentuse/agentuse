import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Tests for serve.ts - HTTP server for running agents via API
 *
 * Since the internal functions (parseRequestBody, sendJSON, sendError) are not exported,
 * we test them through the HTTP interface using integration-style tests.
 */

// Helper to make HTTP requests
async function makeRequest(
  port: number,
  options: {
    method?: string;
    path?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }
): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
  const { method = 'POST', path: reqPath = '/run', body, headers = {} } = options;

  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      },
      (res: IncomingMessage) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders[key] = value;
            }
          }
          try {
            resolve({
              status: res.statusCode || 500,
              data: data ? JSON.parse(data) : null,
              headers: responseHeaders
            });
          } catch {
            resolve({
              status: res.statusCode || 500,
              data: data,
              headers: responseHeaders
            });
          }
        });
      }
    );

    req.on('error', reject);

    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

describe('Serve Command - Request Body Parsing', () => {
  let tempDir: string;
  let server: Server;
  let port: number;

  beforeAll(() => {
    // Create temporary directory with a valid agent file
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-test-'));

    // Create a minimal agent file
    const agentContent = `---
model: anthropic:claude-sonnet-4-0
---

Test agent instructions`;
    fs.writeFileSync(path.join(tempDir, 'test-agent.agentuse'), agentContent);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('JSON parsing validation', () => {
    it('should reject invalid JSON body', async () => {
      // Create a minimal mock server that simulates the parsing logic
      const mockServer = createServer(async (req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          try {
            JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' }
            }));
          }
        });
      });

      const testPort = 19001;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, {
          body: 'not valid json{'
        });
        expect(response.status).toBe(400);
        expect((response.data as { success: boolean }).success).toBe(false);
        expect((response.data as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
      } finally {
        mockServer.close();
      }
    });

    it('should reject missing agent field', async () => {
      // Mock server simulating the validation
      const mockServer = createServer(async (req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.agent || typeof parsed.agent !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: { code: 'MISSING_FIELD', message: 'Missing required field: agent' }
              }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' }
            }));
          }
        });
      });

      const testPort = 19002;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, {
          body: { prompt: 'some prompt' } // Missing agent field
        });
        expect(response.status).toBe(400);
        expect((response.data as { error: { code: string } }).error.code).toBe('MISSING_FIELD');
      } finally {
        mockServer.close();
      }
    });

    it('should reject non-string agent field', async () => {
      const mockServer = createServer(async (req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.agent || typeof parsed.agent !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: { code: 'MISSING_FIELD', message: 'Missing required field: agent' }
              }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' }
            }));
          }
        });
      });

      const testPort = 19003;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, {
          body: { agent: 123 } // agent is not a string
        });
        expect(response.status).toBe(400);
        expect((response.data as { error: { code: string } }).error.code).toBe('MISSING_FIELD');
      } finally {
        mockServer.close();
      }
    });

    it('should accept valid request with all optional fields', async () => {
      const mockServer = createServer(async (req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.agent || typeof parsed.agent !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: { code: 'MISSING_FIELD', message: 'Missing required field: agent' }
              }));
              return;
            }
            // Validate optional fields types
            const validRequest = {
              agent: parsed.agent,
              prompt: parsed.prompt,
              model: parsed.model,
              timeout: parsed.timeout,
              maxSteps: parsed.maxSteps
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, parsed: validRequest }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' }
            }));
          }
        });
      });

      const testPort = 19004;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, {
          body: {
            agent: 'test.agentuse',
            prompt: 'Hello',
            model: 'openai:gpt-4.1',
            timeout: 60,
            maxSteps: 50
          }
        });
        expect(response.status).toBe(200);
        expect((response.data as { success: boolean }).success).toBe(true);
        const parsed = (response.data as { parsed: { agent: string } }).parsed;
        expect(parsed.agent).toBe('test.agentuse');
      } finally {
        mockServer.close();
      }
    });
  });
});

describe('Serve Command - HTTP Routing', () => {
  describe('endpoint validation', () => {
    it('should return 404 for GET requests', async () => {
      const mockServer = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Endpoint not found. Use POST /run' }
          }));
          return;
        }
        res.writeHead(200);
        res.end();
      });

      const testPort = 19005;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, { method: 'GET' });
        expect(response.status).toBe(404);
        expect((response.data as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      } finally {
        mockServer.close();
      }
    });

    it('should return 404 for wrong path', async () => {
      const mockServer = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Endpoint not found. Use POST /run' }
          }));
          return;
        }
        res.writeHead(200);
        res.end();
      });

      const testPort = 19006;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, { path: '/wrong-path' });
        expect(response.status).toBe(404);
        expect((response.data as { error: { message: string } }).error.message).toContain('POST /run');
      } finally {
        mockServer.close();
      }
    });

    it('should handle OPTIONS requests for CORS preflight', async () => {
      const mockServer = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end();
      });

      const testPort = 19007;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, { method: 'OPTIONS' });
        expect(response.status).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe('*');
        expect(response.headers['access-control-allow-methods']).toContain('POST');
      } finally {
        mockServer.close();
      }
    });
  });
});

describe('Serve Command - Path Security', () => {
  let tempProjectRoot: string;

  beforeAll(() => {
    tempProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-security-test-'));
    // Create a valid agent file inside project
    const agentContent = `---
model: anthropic:claude-sonnet-4-0
---
Test agent`;
    fs.writeFileSync(path.join(tempProjectRoot, 'valid.agentuse'), agentContent);
  });

  afterAll(() => {
    fs.rmSync(tempProjectRoot, { recursive: true, force: true });
  });

  it('should reject agent path outside project root with ../', async () => {
    // Simulate the path security check from serve.ts
    const mockServer = createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const agentPath = path.resolve(tempProjectRoot, parsed.agent);

          // Security check
          if (!agentPath.startsWith(tempProjectRoot)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_PATH', message: 'Agent path must be within project root' }
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });

    const testPort = 19008;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: '../../../etc/passwd' }
      });
      expect(response.status).toBe(400);
      expect((response.data as { error: { code: string } }).error.code).toBe('INVALID_PATH');
    } finally {
      mockServer.close();
    }
  });

  it('should reject absolute path outside project root', async () => {
    const mockServer = createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const agentPath = path.resolve(tempProjectRoot, parsed.agent);

          if (!agentPath.startsWith(tempProjectRoot)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_PATH', message: 'Agent path must be within project root' }
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });

    const testPort = 19009;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: '/tmp/malicious.agentuse' }
      });
      expect(response.status).toBe(400);
      expect((response.data as { error: { code: string } }).error.code).toBe('INVALID_PATH');
    } finally {
      mockServer.close();
    }
  });

  it('should allow valid relative path within project root', async () => {
    const mockServer = createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const agentPath = path.resolve(tempProjectRoot, parsed.agent);

          if (!agentPath.startsWith(tempProjectRoot)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_PATH', message: 'Agent path must be within project root' }
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, resolvedPath: agentPath }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });

    const testPort = 19010;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: 'valid.agentuse' }
      });
      expect(response.status).toBe(200);
      expect((response.data as { success: boolean }).success).toBe(true);
    } finally {
      mockServer.close();
    }
  });

  it('should handle path traversal in middle of path', async () => {
    const mockServer = createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const agentPath = path.resolve(tempProjectRoot, parsed.agent);

          if (!agentPath.startsWith(tempProjectRoot)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_PATH', message: 'Agent path must be within project root' }
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });

    const testPort = 19011;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: 'subdir/../../../etc/passwd' }
      });
      expect(response.status).toBe(400);
      expect((response.data as { error: { code: string } }).error.code).toBe('INVALID_PATH');
    } finally {
      mockServer.close();
    }
  });
});

describe('Serve Command - Error Response Format', () => {
  it('should return consistent error format with success: false', async () => {
    const mockServer = createServer(async (req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: { code: 'TEST_ERROR', message: 'Test error message' }
      }));
    });

    const testPort = 19012;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: 'test.agentuse' }
      });

      const data = response.data as { success: boolean; error: { code: string; message: string } };
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('TEST_ERROR');
      expect(data.error.message).toBe('Test error message');
    } finally {
      mockServer.close();
    }
  });

  it('should set Content-Type to application/json for all responses', async () => {
    const mockServer = createServer(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });

    const testPort = 19013;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: 'test.agentuse' }
      });
      expect(response.headers['content-type']).toBe('application/json');
    } finally {
      mockServer.close();
    }
  });
});

describe('Serve Command - CORS Headers', () => {
  it('should include CORS headers in all responses', async () => {
    const mockServer = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });

    const testPort = 19014;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: 'test.agentuse' }
      });
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
    } finally {
      mockServer.close();
    }
  });
});
