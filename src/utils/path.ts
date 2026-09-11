import * as os from 'os';

/**
 * Expand a leading `~` to the current user's home directory.
 *
 * Only `~` and `~/...` are expanded. `~user/...` is left untouched: we cannot
 * resolve another account's home directory, and naively replacing the `~`
 * would mangle the path into `<home>user/...`.
 */
export function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, os.homedir());
}
