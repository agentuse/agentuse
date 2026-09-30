import matter from 'gray-matter';

/**
 * The one way this repo parses front matter. Every caller goes through here.
 *
 * gray-matter picks its parser from the word after the opening `---`, and its
 * built-in `javascript` engine (`---js`, `---javascript`, any case) runs the
 * block through `eval()`. Agent files, skills, and Markdown artifacts can all be
 * written by an agent that read hostile input, and serve parses them in the
 * daemon process, so that engine is replaced with one that refuses.
 *
 * Options are always passed: with no options gray-matter memoizes every result
 * in a module-level cache keyed by the full content, so a long-lived daemon
 * would retain every version of every file it ever parsed.
 */
const refuseExecutableFrontmatter = {
  parse(): never {
    throw new Error('JavaScript front matter is not supported');
  },
  stringify(): never {
    throw new Error('JavaScript front matter is not supported');
  },
};

const FRONTMATTER_OPTIONS = {
  engines: { javascript: refuseExecutableFrontmatter },
};

export function parseFrontmatter(text: string): matter.GrayMatterFile<string> {
  return matter(text, FRONTMATTER_OPTIONS);
}

export function stringifyFrontmatter(content: string, data: Record<string, unknown>): string {
  return matter.stringify(content, data);
}
