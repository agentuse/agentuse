import { describe, it, expect } from 'bun:test';
import { resolveTimeout, resolveMaxSteps } from '../src/utils/config';

describe('Timeout precedence', () => {
  describe('resolveTimeout', () => {
    it('uses CLI timeout when explicitly set (precedence 1)', () => {
      const result = resolveTimeout(600, true, 900);
      expect(result).toBe(600);
    });

    it('uses CLI timeout even if agent YAML has different value', () => {
      const result = resolveTimeout(120, true, 300);
      expect(result).toBe(120);
    });

    it('uses CLI timeout even if agent YAML is not set', () => {
      const result = resolveTimeout(450, true, undefined);
      expect(result).toBe(450);
    });

    it('uses agent YAML timeout when CLI not explicit (precedence 2)', () => {
      const result = resolveTimeout(300, false, 900);
      expect(result).toBe(900);
    });

    it('uses default timeout when CLI not explicit and no agent YAML (precedence 3)', () => {
      const result = resolveTimeout(300, false, undefined);
      expect(result).toBe(300); // DEFAULT_TIMEOUT
    });

    it('handles edge case: CLI timeout = 0 when explicit', () => {
      // This would be caught by validation, but test the function behavior
      const result = resolveTimeout(0, true, 600);
      expect(result).toBe(0);
    });

    it('handles large timeout values', () => {
      const result = resolveTimeout(3600, true, 1800);
      expect(result).toBe(3600);
    });
  });
});

describe('MaxSteps precedence', () => {
  describe('resolveMaxSteps', () => {
    it('uses CLI maxSteps when set (precedence 1)', () => {
      const result = resolveMaxSteps(200, 150);
      expect(result).toBe(200);
    });

    it('uses CLI maxSteps even if agent YAML has different value', () => {
      const result = resolveMaxSteps(50, 300);
      expect(result).toBe(50);
    });

    it('uses agent YAML maxSteps when CLI not set (precedence 2)', () => {
      const result = resolveMaxSteps(undefined, 250);
      expect(result).toBe(250);
    });

    it('uses default maxSteps when neither CLI nor agent YAML set (precedence 3)', () => {
      const result = resolveMaxSteps(undefined, undefined);
      expect(result).toBe(100); // DEFAULT_MAX_STEPS
    });

    it('handles CLI maxSteps = 0', () => {
      // This would be caught by validation, but test the function behavior
      const result = resolveMaxSteps(0, 150);
      expect(result).toBe(0);
    });

    it('handles very large maxSteps values', () => {
      const result = resolveMaxSteps(10000, 5000);
      expect(result).toBe(10000);
    });

    it('treats 0 as falsy and falls back to next precedence', () => {
      const result = resolveMaxSteps(undefined, undefined);
      expect(result).toBe(100);
    });

    it('handles agent YAML maxSteps without CLI override', () => {
      const result = resolveMaxSteps(undefined, 75);
      expect(result).toBe(75);
    });
  });
});
