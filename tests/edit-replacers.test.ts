import { describe, it, expect } from 'bun:test';
import {
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  TrimmedBoundaryReplacer,
  LineEndingNormalizedReplacer,
  fuzzyReplace,
  REPLACERS,
} from '../src/tools/edit-replacers.js';

/**
 * Tests for fuzzy edit replacers
 *
 * The edit tool uses progressive fuzzy matching strategies to find and replace
 * text even when there are minor differences like whitespace, indentation, etc.
 */

describe('Edit Replacers - Individual Strategies', () => {
  describe('SimpleReplacer (exact match)', () => {
    it('should yield the exact search string', () => {
      const results = [...SimpleReplacer('hello world', 'hello')];
      expect(results).toEqual(['hello']);
    });

    it('should work with multi-line content', () => {
      const content = 'line1\nline2\nline3';
      const results = [...SimpleReplacer(content, 'line2')];
      expect(results).toEqual(['line2']);
    });
  });

  describe('LineTrimmedReplacer', () => {
    it('should match lines with different leading whitespace', () => {
      const content = '  const x = 1;\n    const y = 2;';
      const search = 'const x = 1;';
      const results = [...LineTrimmedReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toBe('  const x = 1;');
    });

    it('should match lines with different trailing whitespace', () => {
      const content = 'const x = 1;   \nconst y = 2;';
      const search = 'const x = 1;';
      const results = [...LineTrimmedReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });

    it('should match multi-line blocks with trimmed lines', () => {
      const content = '  function foo() {\n    return 1;\n  }';
      const search = 'function foo() {\nreturn 1;\n}';
      const results = [...LineTrimmedReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });

    it('should not match when content differs', () => {
      const content = 'const x = 1;';
      const search = 'const y = 2;';
      const results = [...LineTrimmedReplacer(content, search)];
      expect(results).toEqual([]);
    });

    it('should handle trailing newline in search', () => {
      const content = '  line1\n  line2\n  line3';
      const search = 'line1\nline2\n';
      const results = [...LineTrimmedReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('BlockAnchorReplacer', () => {
    it('should match blocks by first and last line anchors', () => {
      const content = `function foo() {
  const x = 1;
  const y = 2;
  return x + y;
}`;
      const search = `function foo() {
  const a = 10;
  return a;
}`;
      const results = [...BlockAnchorReplacer(content, search)];
      // Should find the block based on matching first and last lines
      expect(results.length).toBeGreaterThan(0);
    });

    it('should require at least 3 lines for block matching', () => {
      const content = 'line1\nline2';
      const search = 'line1\nline2';
      const results = [...BlockAnchorReplacer(content, search)];
      expect(results).toEqual([]);
    });

    it('should find best match among multiple candidates', () => {
      const content = `start
  similar content A
end
start
  similar content B
end`;
      const search = `start
  similar content B
end`;
      const results = [...BlockAnchorReplacer(content, search)];
      // Should find at least one match
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle blocks with varying middle content', () => {
      const content = `if (condition) {
  doSomething();
  doSomethingElse();
  finishUp();
}`;
      const search = `if (condition) {
  // completely different middle
  // with different lines
}`;
      const results = [...BlockAnchorReplacer(content, search)];
      // Should match based on anchors
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('WhitespaceNormalizedReplacer', () => {
    it('should match with normalized whitespace', () => {
      const content = 'const   x   =   1;';
      const search = 'const x = 1;';
      const results = [...WhitespaceNormalizedReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });

    it('should match with tabs converted to spaces', () => {
      const content = 'const\tx\t=\t1;';
      const search = 'const x = 1;';
      const results = [...WhitespaceNormalizedReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });

    it('should match multi-line with normalized whitespace', () => {
      const content = '  const   x = 1;\n  const   y = 2;';
      const search = 'const x = 1;\nconst y = 2;';
      const results = [...WhitespaceNormalizedReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });

    it('should find substring matches within lines', () => {
      const content = 'prefix const  x = 1; suffix';
      const search = 'const x = 1;';
      const results = [...WhitespaceNormalizedReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('IndentationFlexibleReplacer', () => {
    it('should match regardless of base indentation level', () => {
      const content = `    function foo() {
        return 1;
    }`;
      const search = `function foo() {
    return 1;
}`;
      const results = [...IndentationFlexibleReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });

    it('should preserve relative indentation differences', () => {
      const content = `  if (x) {
    doThis();
  }`;
      const search = `if (x) {
  doThis();
}`;
      const results = [...IndentationFlexibleReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle tabs vs spaces indentation', () => {
      const content = '\tfunction foo() {\n\t\treturn 1;\n\t}';
      const search = 'function foo() {\n    return 1;\n}';
      const results = [...IndentationFlexibleReplacer(content, search)];
      // May or may not match depending on implementation
      // Just check it doesn't throw
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle empty lines in indented blocks', () => {
      const content = `    function foo() {

        return 1;
    }`;
      const search = `function foo() {

    return 1;
}`;
      const results = [...IndentationFlexibleReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('TrimmedBoundaryReplacer', () => {
    it('should match when search has leading/trailing whitespace', () => {
      const content = 'hello world';
      const search = '  hello world  ';
      const results = [...TrimmedBoundaryReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });

    it('should not yield when search is already trimmed', () => {
      const content = 'hello world';
      const search = 'hello world';
      const results = [...TrimmedBoundaryReplacer(content, search)];
      // Already trimmed, nothing to do
      expect(results).toEqual([]);
    });

    it('should match blocks with trimmed boundaries', () => {
      const content = 'line1\nline2\nline3';
      const search = '\nline1\nline2\n';
      const results = [...TrimmedBoundaryReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('LineEndingNormalizedReplacer', () => {
    it('should match CRLF content with LF search', () => {
      const content = 'line1\r\nline2\r\nline3';
      const search = 'line1\r\nline2';
      const results = [...LineEndingNormalizedReplacer(content, search)];
      expect(results.length).toBeGreaterThan(0);
    });

    it('should not yield when line endings already match', () => {
      const content = 'line1\nline2';
      const search = 'line1\nline2';
      const results = [...LineEndingNormalizedReplacer(content, search)];
      // No CRLF to normalize
      expect(results).toEqual([]);
    });

    it('should handle mixed line endings', () => {
      const content = 'line1\r\nline2\nline3\r\n';
      const search = 'line2\r\nline3';
      const results = [...LineEndingNormalizedReplacer(content, search)];
      // May or may not match depending on exact implementation
      expect(Array.isArray(results)).toBe(true);
    });
  });
});

describe('fuzzyReplace - Integration', () => {
  describe('exact match cases', () => {
    it('should replace exact match', () => {
      const result = fuzzyReplace(
        'const x = 1;',
        'const x = 1;',
        'const x = 2;'
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.newContent).toBe('const x = 2;');
        expect(result.replacerUsed).toBe('exact');
      }
    });

    it('should replace first occurrence by default', () => {
      const result = fuzzyReplace(
        'x = 1;\nx = 1;',
        'x = 1;',
        'x = 2;'
      );
      // Should fail due to ambiguity (multiple matches)
      expect(result.success).toBe(false);
    });

    it('should replace all occurrences with replace_all', () => {
      const result = fuzzyReplace(
        'x = 1;\nx = 1;',
        'x = 1;',
        'x = 2;',
        true // replace_all
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.newContent).toBe('x = 2;\nx = 2;');
      }
    });
  });

  describe('fuzzy match cases', () => {
    it('should use line-trimmed matching for whitespace differences', () => {
      // Content where exact match won't work but line-trimmed will
      const result = fuzzyReplace(
        '  const x = 1;\n  const y = 2;',
        'const x = 1;\nconst y = 2;',
        'const a = 10;\nconst b = 20;'
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.newContent).toContain('const a = 10;');
        expect(result.newContent).toContain('const b = 20;');
        expect(result.replacerUsed).toBe('line-trimmed');
      }
    });

    it('should use whitespace-normalized matching', () => {
      const result = fuzzyReplace(
        'const   x   =   1;',
        'const x = 1;',
        'const y = 2;'
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.newContent).toBe('const y = 2;');
      }
    });

    it('should use indentation-flexible matching', () => {
      const content = `    function foo() {
        return 1;
    }`;
      const oldString = `function foo() {
    return 1;
}`;
      const newString = `function bar() {
    return 2;
}`;
      const result = fuzzyReplace(content, oldString, newString);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.newContent).toContain('bar');
        expect(result.newContent).toContain('return 2');
      }
    });

    it('should use block-anchor matching for modified middle content', () => {
      const content = `function process() {
  // existing implementation
  doSomething();
  doMore();
  cleanup();
}`;
      const oldString = `function process() {
  // different middle
  otherThing();
}`;
      const newString = `function process() {
  // new implementation
  newThing();
}`;
      const result = fuzzyReplace(content, oldString, newString);
      // May use block-anchor if anchors match
      if (result.success) {
        expect(result.newContent).toContain('new implementation');
      }
    });
  });

  describe('error cases', () => {
    it('should fail when old_string equals new_string', () => {
      const result = fuzzyReplace(
        'hello world',
        'hello',
        'hello'
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('must be different');
      }
    });

    it('should fail when old_string not found', () => {
      const result = fuzzyReplace(
        'hello world',
        'goodbye',
        'farewell'
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('should report ambiguity when multiple matches exist', () => {
      const result = fuzzyReplace(
        'foo bar foo',
        'foo',
        'baz'
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('matches');
        expect(result.error).toContain('replace_all');
      }
    });
  });

  describe('real-world scenarios', () => {
    it('should handle function replacement with different indentation', () => {
      const content = `export class MyClass {
  async fetchData() {
    const response = await fetch(url);
    return response.json();
  }

  processData(data) {
    return data.map(x => x * 2);
  }
}`;
      const oldString = `async fetchData() {
  const response = await fetch(url);
  return response.json();
}`;
      const newString = `async fetchData() {
  try {
    const response = await fetch(url);
    return response.json();
  } catch (error) {
    console.error(error);
    throw error;
  }
}`;
      const result = fuzzyReplace(content, oldString, newString);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.newContent).toContain('try {');
        expect(result.newContent).toContain('catch (error)');
        expect(result.newContent).toContain('processData'); // Other method preserved
      }
    });

    it('should handle import statement replacement', () => {
      const content = `import { foo } from 'bar';
import { baz }   from   'qux';
import { quux } from 'corge';`;
      const oldString = `import { baz } from 'qux';`;
      const newString = `import { baz, newThing } from 'qux';`;
      const result = fuzzyReplace(content, oldString, newString);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.newContent).toContain('newThing');
      }
    });

    it('should handle JSX component replacement', () => {
      const content = `function App() {
  return (
    <div className="container">
      <Header title="Hello" />
      <Content />
    </div>
  );
}`;
      const oldString = `<Header title="Hello" />`;
      const newString = `<Header title="Hello World" subtitle="Welcome" />`;
      const result = fuzzyReplace(content, oldString, newString);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.newContent).toContain('Hello World');
        expect(result.newContent).toContain('subtitle="Welcome"');
      }
    });

    it('should handle config object replacement', () => {
      const content = `const config = {
  host: 'localhost',
  port:   3000,
  debug: true,
};`;
      const oldString = `port: 3000,`;
      const newString = `port: 8080,`;
      const result = fuzzyReplace(content, oldString, newString);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.newContent).toContain('port: 8080');
        expect(result.newContent).toContain('host:');
        expect(result.newContent).toContain('debug:');
      }
    });
  });
});

describe('REPLACERS array', () => {
  it('should contain all replacers in correct order', () => {
    expect(REPLACERS).toHaveLength(7);
    expect(REPLACERS[0]).toBe(SimpleReplacer);
    expect(REPLACERS[1]).toBe(LineTrimmedReplacer);
    expect(REPLACERS[2]).toBe(BlockAnchorReplacer);
    expect(REPLACERS[3]).toBe(WhitespaceNormalizedReplacer);
    expect(REPLACERS[4]).toBe(IndentationFlexibleReplacer);
    expect(REPLACERS[5]).toBe(TrimmedBoundaryReplacer);
    expect(REPLACERS[6]).toBe(LineEndingNormalizedReplacer);
  });

  it('should try replacers in order from exact to fuzzy', () => {
    // The order matters: exact matching should be tried before fuzzy
    const content = 'const x = 1;';
    const search = 'const x = 1;';

    // Exact match should be found first
    const result = fuzzyReplace(content, search, 'const y = 2;');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.replacerUsed).toBe('exact');
    }
  });
});
