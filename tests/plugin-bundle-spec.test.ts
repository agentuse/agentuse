import { describe, it, expect } from 'bun:test';
import { parsePluginSpec } from '../src/plugin-bundle/spec';

describe('parsePluginSpec', () => {
  it('parses local relative path', () => {
    const spec = parsePluginSpec('./plugins/foo');
    expect(spec.kind).toBe('local');
    if (spec.kind === 'local') expect(spec.path).toBe('./plugins/foo');
  });

  it('parses local parent path', () => {
    const spec = parsePluginSpec('../shared/foo');
    expect(spec.kind).toBe('local');
  });

  it('parses absolute path', () => {
    const spec = parsePluginSpec('/abs/foo');
    expect(spec.kind).toBe('local');
  });

  it('parses home-relative path', () => {
    const spec = parsePluginSpec('~/plugins/foo');
    expect(spec.kind).toBe('local');
  });

  it('parses owner/repo shorthand', () => {
    const spec = parsePluginSpec('agentuse/example');
    expect(spec.kind).toBe('git');
    if (spec.kind === 'git') {
      expect(spec.host).toBe('github');
      expect(spec.owner).toBe('agentuse');
      expect(spec.repo).toBe('example');
      expect(spec.subpath).toBeUndefined();
      expect(spec.ref).toBeUndefined();
    }
  });

  it('parses owner/repo with subpath', () => {
    const spec = parsePluginSpec('agentuse/example/.github/plugins/my-plugin');
    expect(spec.kind).toBe('git');
    if (spec.kind === 'git') {
      expect(spec.subpath).toBe('.github/plugins/my-plugin');
      expect(spec.ref).toBeUndefined();
    }
  });

  it('parses owner/repo@ref', () => {
    const spec = parsePluginSpec('agentuse/example@v1.2.3');
    expect(spec.kind).toBe('git');
    if (spec.kind === 'git') expect(spec.ref).toBe('v1.2.3');
  });

  it('parses owner/repo/subpath@ref', () => {
    const spec = parsePluginSpec('org/repo/sub/dir@main');
    expect(spec.kind).toBe('git');
    if (spec.kind === 'git') {
      expect(spec.subpath).toBe('sub/dir');
      expect(spec.ref).toBe('main');
    }
  });

  it('parses https git URL', () => {
    const spec = parsePluginSpec('https://github.com/org/repo.git');
    expect(spec.kind).toBe('git');
    if (spec.kind === 'git') {
      expect(spec.host).toBe('generic');
      expect(spec.owner).toBe('org');
      expect(spec.repo).toBe('repo');
      expect(spec.url).toBe('https://github.com/org/repo.git');
    }
  });

  it('parses https git URL with ref', () => {
    const spec = parsePluginSpec('https://github.com/org/repo.git@v1.0.0');
    expect(spec.kind).toBe('git');
    if (spec.kind === 'git') {
      expect(spec.ref).toBe('v1.0.0');
      expect(spec.url).toBe('https://github.com/org/repo.git');
    }
  });

  it('parses ssh git URL without splitting on user@host', () => {
    const spec = parsePluginSpec('git@github.com:org/repo.git');
    expect(spec.kind).toBe('git');
    if (spec.kind === 'git') {
      expect(spec.owner).toBe('org');
      expect(spec.repo).toBe('repo');
      expect(spec.ref).toBeUndefined();
    }
  });

  it('parses ssh git URL with ref', () => {
    const spec = parsePluginSpec('git@github.com:org/repo.git@main');
    expect(spec.kind).toBe('git');
    if (spec.kind === 'git') expect(spec.ref).toBe('main');
  });

  it('throws on empty', () => {
    expect(() => parsePluginSpec('   ')).toThrow();
  });

  it('throws on bare token', () => {
    expect(() => parsePluginSpec('justone')).toThrow();
  });

  it('throws on invalid characters', () => {
    expect(() => parsePluginSpec('bad name/repo')).toThrow();
  });
});
