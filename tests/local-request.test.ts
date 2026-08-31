import { describe, expect, it } from 'bun:test';
import { canUseHostFolderPicker, isLoopbackAddress, isLoopbackHostHeader } from '../src/utils/local-request';

describe('local browser capability detection', () => {
  it('recognizes IPv4, IPv6, and mapped loopback connections', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.12.0.4')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('does not expose the host picker to remote clients or exposed binds', () => {
    expect(canUseHostFolderPicker('127.0.0.1', '192.168.1.20')).toBe(false);
    expect(canUseHostFolderPicker('0.0.0.0', '127.0.0.1')).toBe(false);
    expect(canUseHostFolderPicker('192.168.1.5', '192.168.1.20')).toBe(false);
    expect(canUseHostFolderPicker('127.0.0.1', '127.0.0.1', 'agents.example.com')).toBe(false);
  });

  it('enables the host picker only for a loopback bind and connection', () => {
    expect(canUseHostFolderPicker('127.0.0.1', '127.0.0.1', '127.0.0.1:13000')).toBe(true);
    expect(canUseHostFolderPicker('localhost', '::1', 'localhost:13000')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:13000')).toBe(true);
  });
});
