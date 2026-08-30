/** Host-owned metadata. This is intentionally not part of the public plugin API. */
export interface PluginIdentity {
  name: string;
  version?: string;
  source: string;
  scope: 'builtin' | 'global' | 'project' | 'local';
}
