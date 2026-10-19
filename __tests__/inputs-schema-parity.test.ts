import * as fs from 'fs';
import * as path from 'path';

/**
 * Schema parity test (Issue #769).
 *
 * Guards against drift between the inputs declared in `action.yml` and the
 * input keys understood by `src/inputs.ts`. CI fails when an input is added
 * to one side only, which would otherwise produce undocumented inputs or
 * dead config for Wave consumers.
 */

const repoRoot = path.resolve(__dirname, '..');
const actionYmlPath = path.join(repoRoot, 'action.yml');
const inputsTsPath = path.join(repoRoot, 'src', 'inputs.ts');

/**
 * Extract the top-level `inputs:` keys from action.yml.
 *
 * We intentionally avoid a YAML dependency: the `inputs:` block is a flat
 * mapping of input names at a fixed indentation, so a line scan is stable
 * and dependency-free.
 */
export function parseActionYmlInputs(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const inputs: string[] = [];
  let inInputs = false;
  let inputsIndent = -1;

  for (const line of lines) {
    if (!inInputs) {
      const match = /^(\s*)inputs:\s*$/.exec(line);
      if (match) {
        inInputs = true;
        inputsIndent = match[1].length;
      }
      continue;
    }

    // Blank lines and comments do not end the block.
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // A line at or before the `inputs:` indentation ends the block.
    if (indent <= inputsIndent) {
      break;
    }

    // Direct children of `inputs:` are the input names.
    const childMatch = /^(\s*)([A-Za-z0-9_]+):\s*$/.exec(line);
    if (childMatch && childMatch[1].length === inputsIndent + 2) {
      inputs.push(childMatch[2]);
    }
  }

  return inputs;
}

/**
 * Extract the input keys declared in `src/inputs.ts`.
 *
 * Inputs are declared as keys of the `Inputs` interface (or type). We scan
 * the interface body for `name:` / `name?:` property declarations.
 */
export function parseInputsTsKeys(source: string): string[] {
  const keys: string[] = [];
  const interfaceMatch = /(?:export\s+)?interface\s+Inputs\b[^{]*\{([\s\S]*?)\n\}/.exec(
    source,
  );

  if (!interfaceMatch) {
    return keys;
  }

  const body = interfaceMatch[1];
  const propRegex = /^\s*([A-Za-z0-9_]+)\??\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = propRegex.exec(body)) !== null) {
    keys.push(match[1]);
  }

  return keys;
}

/**
 * Compute the symmetric difference between two input name lists.
 * Returns the names present in `a` but not `b`, and vice versa.
 */
export function diffInputs(
  a: string[],
  b: string[],
): { onlyInA: string[]; onlyInB: string[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyInA: a.filter((name) => !setB.has(name)),
    onlyInB: b.filter((name) => !setA.has(name)),
  };
}

function assertParity(actionInputs: string[], tsInputs: string[]): void {
  const { onlyInA, onlyInB } = diffInputs(actionInputs, tsInputs);
  const problems: string[] = [];

  if (onlyInA.length > 0) {
    problems.push(
      `Declared in action.yml but missing from src/inputs.ts: ${onlyInA.join(', ')}`,
    );
  }
  if (onlyInB.length > 0) {
    problems.push(
      `Declared in src/inputs.ts but missing from action.yml: ${onlyInB.join(', ')}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Input schema drift detected:\n${problems.join('\n')}`);
  }
}

describe('inputs.ts / action.yml schema parity', () => {
  it('keeps action.yml and src/inputs.ts inputs in sync (happy path)', () => {
    const actionYml = fs.readFileSync(actionYmlPath, 'utf8');
    const inputsTs = fs.readFileSync(inputsTsPath, 'utf8');

    const actionInputs = parseActionYmlInputs(actionYml);
    const tsInputs = parseInputsTsKeys(inputsTs);

    expect(actionInputs.length).toBeGreaterThan(0);
    expect(tsInputs.length).toBeGreaterThan(0);

    expect(() => assertParity(actionInputs, tsInputs)).not.toThrow();
  });

  it('detects an input declared only in action.yml (failure path)', () => {
    const actionInputs = ['horizon_url', 'ghost_input'];
    const tsInputs = ['horizon_url'];

    expect(() => assertParity(actionInputs, tsInputs)).toThrow(
      /Declared in action\.yml but missing from src\/inputs\.ts: ghost_input/,
    );
  });

  it('detects an input declared only in src/inputs.ts (failure path)', () => {
    const actionInputs = ['horizon_url'];
    const tsInputs = ['horizon_url', 'orphan_input'];

    expect(() => assertParity(actionInputs, tsInputs)).toThrow(
      /Declared in src\/inputs\.ts but missing from action\.yml: orphan_input/,
    );
  });

  it('parses action.yml inputs block correctly', () => {
    const yaml = [
      'name: test',
      'inputs:',
      '  alpha:',
      '    description: "a"',
      '  beta:',
      '    description: "b"',
      'outputs:',
      '  gamma:',
      '    description: "c"',
    ].join('\n');

    expect(parseActionYmlInputs(yaml)).toEqual(['alpha', 'beta']);
  });

  it('parses inputs.ts interface keys correctly', () => {
    const source = [
      'export interface Inputs {',
      '  alpha: string;',
      '  beta?: number;',
      '}',
    ].join('\n');

    expect(parseInputsTsKeys(source)).toEqual(['alpha', 'beta']);
  });
});
