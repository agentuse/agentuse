/** An absolute or relative path of three or more segments, inside a command. */
const PATH_IN_COMMAND = /(?:~|\.{1,2})?(?:\/[^\s'"`|;&<>()]+){2,}/g;

/**
 * Shorten the paths inside a command rather than the command itself.
 *
 * A sandbox call reads `uv run /Users/x/.claude/skills/some-skill/scripts/
 * get_conversation.py --number 301607`. The directory is noise repeated across
 * every call; the script name and the arguments are what tell them apart. So
 * collapse each path to its last couple of segments and leave the rest alone -
 * truncating the string blindly cuts exactly the informative end.
 */
export function shortenCommand(value: string, keep = 2, max = 96): string {
  const shortened = value.replace(PATH_IN_COMMAND, (match) => {
    const parts = match.split('/').filter(Boolean);
    if (parts.length <= keep) return match;
    return `…/${parts.slice(-keep).join('/')}`;
  });
  return shortened.length > max ? `${shortened.slice(0, max - 1)}…` : shortened;
}
