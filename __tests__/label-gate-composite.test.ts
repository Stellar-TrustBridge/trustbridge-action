/**
 * Label-gate composite action wiring (Issue #538).
 *
 * `.github/actions/trustbridge-label-gate/action.yml` is a composite action
 * that sits between a consumer workflow and trustbridge-action: it inspects
 * issue labels, decides whether to run validation, forwards a subset of
 * trustbridge-action inputs/outputs, and exposes `gate_skipped` so the calling
 * workflow can branch.
 *
 * Nothing in `src/` covers that file, and a composite action is only
 * statically inspectable — so these tests parse the YAML structure and assert
 * the wiring end to end:
 *
 *   inputs      ──► run-trustbridge.with   ──► action.yml inputs
 *   action.yml  ──► run-trustbridge outputs ──► composite outputs
 *   composite   ──► composite outputs       ──► ${{ steps.<id>.outputs.* }}
 *   check-gate  ──► $GITHUB_OUTPUT writes   ──► composite gate_* outputs
 *
 * Like `action-schema-sync.test.ts` and `outputs.test.ts`, the YAML reader here
 * is a deliberately narrow line-based extractor rather than a new dependency —
 * it only has to understand the shape of these two action.yml files.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const LABEL_GATE_PATH = path.join(REPO_ROOT, '.github/actions/trustbridge-label-gate/action.yml');
const ACTION_YML_PATH = path.join(REPO_ROOT, 'action.yml');

interface StepBlock {
  /** Step `name:` as written, or the first `with:` key when unnamed. */
  name: string;
  id?: string;
  uses?: string;
  if?: string;
  shell?: string;
  with: Map<string, string>;
  /** Every `${{ inputs.<name> }}` reference inside the step. */
  inputRefs: string[];
  /** Every `${{ steps.<id>.outputs.<name> }}` reference inside the step. */
  stepOutputRefs: Array<{ stepId: string; output: string }>;
  /** Every `>> "$GITHUB_OUTPUT"` write in the step's `run:` script. */
  githubOutputWrites: string[];
  /** Raw text of the step's `run:` script, or '' for `uses:` steps. */
  run: string;
}

interface CompositeAction {
  inputs: Map<string, { required: boolean; default?: string }>;
  outputs: Map<string, string>;
  using?: string;
  steps: StepBlock[];
  /** Every `${{ inputs.<name> }}` reference anywhere in the file. */
  inputRefs: string[];
  /** Every `${{ steps.<id>.outputs.<name> }}` reference anywhere in the file. */
  stepOutputRefs: Array<{ stepId: string; output: string }>;
}

const STEP_START = /^ {4}- /;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (/^'.*'$/.test(trimmed) || /^".*"$/.test(trimmed)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Collect every `${{ ... }}` expression body appearing in `text`. */
function expressionsIn(text: string): string[] {
  return [...text.matchAll(/\$\{\{(.+?)\}\}/gs)].map((m) => (m[1] ?? '').trim());
}

/** `${{ inputs.foo }}` → ['foo'] */
function inputRefsIn(text: string): string[] {
  return expressionsIn(text)
    .map((expr) => /^inputs\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!);
}

/** `${{ steps.id.outputs.name }}` → { stepId: 'id', output: 'name' } */
function stepOutputRefsIn(text: string): Array<{ stepId: string; output: string }> {
  return expressionsIn(text)
    .map((expr) => /^steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ stepId: m[1]!, output: m[2]! }));
}

/**
 * Names written to `$GITHUB_OUTPUT` by a bash script.
 * Matches `echo "key=value" >> "$GITHUB_OUTPUT"` and `echo "key=" >>...`.
 */
function githubOutputWritesIn(script: string): string[] {
  const writes: string[] = [];
  for (const line of script.split('\n')) {
    const match = /^\s*echo\s+"([^="]+)=[^"]*"\s*>>\s*"?\$\{?GITHUB_OUTPUT\}?"?/.exec(line);
    if (match) {
      writes.push(match[1]!.trim());
    }
  }
  return writes;
}

function parseSteps(lines: string[]): StepBlock[] {
  const steps: StepBlock[] = [];
  let current: StepBlock | null = null;
  let inRun = false;
  let runLines: string[] = [];
  let inWith = false;

  const flushRun = () => {
    if (current) {
      current.run = runLines.join('\n');
      current.githubOutputWrites = githubOutputWritesIn(current.run);
    }
    inRun = false;
    runLines = [];
  };

  for (const line of lines) {
    if (STEP_START.test(line)) {
      flushRun();
      current = {
        name: stripQuotes(line.replace(STEP_START, '')),
        with: new Map(),
        inputRefs: [],
        stepOutputRefs: [],
        githubOutputWrites: [],
        run: '',
      };
      inWith = false;
      steps.push(current);
      continue;
    }

    if (!current) continue;

    if (inRun) {
      runLines.push(line);
      continue;
    }

    // Step-level keys sit at 6 spaces; `with:` entries at 8.
    const stepKey = /^ {6}([a-z_]+):(?:\s*(.*))?$/.exec(line);
    if (stepKey) {
      inWith = false;
      const [, key, rawValue] = stepKey;
      const value = rawValue ?? '';
      switch (key) {
        case 'id':
          current.id = stripQuotes(value);
          break;
        case 'uses':
          // `uses: owner/repo@sha # v1` — the trailing comment is not part of
          // the reference.
          current.uses = stripQuotes(value.replace(/\s+#.*$/, ''));
          break;
        case 'if':
          current.if = value.trim();
          break;
        case 'shell':
          current.shell = stripQuotes(value);
          break;
        case 'with':
          inWith = true;
          break;
        case 'run':
          // Block scalar: the script is every following, more-indented line.
          if (/[|>][-+]?\s*$/.test(value)) {
            inRun = true;
          } else {
            current.run = value;
          }
          break;
        default:
          break;
      }
      continue;
    }

    const withKey = /^ {8}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (inWith && withKey) {
      const [, key, value] = withKey;
      current.with.set(key!, value!.trim());
    }
  }

  flushRun();
  return steps;
}

function parseCompositeAction(yamlText: string): CompositeAction {
  const lines = yamlText.split('\n');
  const inputs = new Map<string, { required: boolean; default?: string }>();
  const outputs = new Map<string, string>();
  const steps: StepBlock[] = [];
  let using: string | undefined;

  let section: 'inputs' | 'outputs' | 'runs' | null = null;
  let currentKey: string | null = null;
  let currentRequired = false;
  let currentDefault: string | undefined;
  let stepsCollected = false;

  const flushKey = () => {
    if (currentKey === null) return;
    if (section === 'inputs') {
      inputs.set(currentKey, { required: currentRequired, default: currentDefault });
    }
    currentKey = null;
    currentRequired = false;
    currentDefault = undefined;
  };

  for (const line of lines) {
    if (/^inputs:\s*$/.test(line)) {
      flushKey();
      section = 'inputs';
      continue;
    }
    if (/^outputs:\s*$/.test(line)) {
      flushKey();
      section = 'outputs';
      continue;
    }
    if (/^runs:\s*$/.test(line)) {
      flushKey();
      section = 'runs';
      continue;
    }

    // Any other top-level key ends the current section.
    if (section && /^[A-Za-z_]/.test(line)) {
      flushKey();
      section = null;
      continue;
    }

    if (section === 'runs') {
      const usingMatch = /^ {2}using:\s*(.+)$/.exec(line);
      if (usingMatch) {
        using = stripQuotes(usingMatch[1]!);
        continue;
      }
      if (/^ {2}steps:\s*$/.test(line)) {
        steps.push(...parseSteps(lines.slice(lines.indexOf(line) + 1)));
        stepsCollected = true;
      }
      continue;
    }

    if (section === 'inputs') {
      if (/^\s*#/.test(line)) continue;
      const inputKey = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(line);
      if (inputKey) {
        flushKey();
        currentKey = inputKey[1]!;
        continue;
      }
      const required = /^ {4}required:\s*(true|false)\s*$/.exec(line);
      if (required) {
        currentRequired = required[1] === 'true';
        continue;
      }
      const def = /^ {4}default:\s*(.+)$/.exec(line);
      if (def) {
        currentDefault = stripQuotes(def[1]!);
      }
      continue;
    }

    if (section === 'outputs') {
      if (/^\s*#/.test(line)) continue;
      const outputKey = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(line);
      if (outputKey) {
        flushKey();
        currentKey = outputKey[1]!;
        continue;
      }
      const value = /^ {4}value:\s*(.+)$/.exec(line);
      if (value && currentKey) {
        outputs.set(currentKey, value[1]!.trim());
      }
    }
  }

  if (!stepsCollected) {
    throw new Error('No `runs.steps:` found in the label-gate composite action.');
  }

  const rawInputs = inputRefsIn(yamlText);
  return {
    inputs,
    outputs,
    using,
    steps,
    inputRefs: [...new Set(rawInputs)],
    stepOutputRefs: stepOutputRefsIn(yamlText),
  };
}

/** Declared output names of the main trustbridge-action `action.yml`. */
function actionYmlOutputNames(yamlText: string): Set<string> {
  const names = new Set<string>();
  let inOutputs = false;
  let current: string | null = null;

  for (const raw of yamlText.split('\n')) {
    const line = raw.trimEnd();
    if (/^outputs:\s*$/.test(line)) {
      inOutputs = true;
      continue;
    }
    if (inOutputs && /^[A-Za-z_]/.test(line) && !/^\s/.test(line)) {
      if (current !== null) names.add(current);
      current = null;
      inOutputs = false;
      continue;
    }
    if (!inOutputs || /^\s*#/.test(line)) continue;
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(line);
    if (match) {
      if (current !== null) names.add(current);
      current = match[1]!;
    }
  }
  if (current !== null) names.add(current);
  return names;
}

/** Declared input names of the main trustbridge-action `action.yml`. */
function actionYmlInputNames(yamlText: string): Set<string> {
  const names = new Set<string>();
  let inInputs = false;

  for (const raw of yamlText.split('\n')) {
    const line = raw.trimEnd();
    if (/^inputs:\s*$/.test(line)) {
      inInputs = true;
      continue;
    }
    if (inInputs && /^[A-Za-z_]/.test(line) && !/^\s/.test(line)) {
      inInputs = false;
      continue;
    }
    if (!inInputs || /^\s*#/.test(line)) continue;
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
}

describe('label-gate composite action wiring (#538)', () => {
  const composite = parseCompositeAction(fs.readFileSync(LABEL_GATE_PATH, 'utf8'));
  const actionYml = fs.readFileSync(ACTION_YML_PATH, 'utf8');
  const actionInputs = actionYmlInputNames(actionYml);
  const actionOutputs = actionYmlOutputNames(actionYml);

  const stepById = (id: string): StepBlock => {
    const step = composite.steps.find((s) => s.id === id);
    if (!step) {
      throw new Error(
        `Composite action has no step with id "${id}". Found: ${composite.steps
          .map((s) => s.id ?? s.name)
          .join(', ')}`,
      );
    }
    return step;
  };

  const checkGate = stepById('check-gate');
  const runTrustBridge = stepById('run-trustbridge');
  const skipComment = composite.steps.find((s) => s.name.includes('Post skip comment'));

  // ── Shape ────────────────────────────────────────────────────────────────

  it('is a composite action', () => {
    expect(composite.using).toBe('composite');
  });

  it('has exactly the three documented steps, in order', () => {
    expect(composite.steps).toHaveLength(3);
    expect(composite.steps[0]!.id).toBe('check-gate');
    expect(skipComment).toBeDefined();
    expect(composite.steps[2]!.id).toBe('run-trustbridge');
  });

  it('gives every step a unique id', () => {
    const ids = composite.steps.map((s) => s.id).filter((id): id is string => Boolean(id));
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it('runs the gate check before the skip comment and the validation run', () => {
    const names = composite.steps.map((s) => s.name);
    expect(names[0]).toContain('Check gate labels');
    expect(names[1]).toContain('Post skip comment');
    expect(names[2]).toContain('Run TrustBridge');
  });

  // ── Gate control wiring ──────────────────────────────────────────────────

  it('requires github_token and defaults gate_labels to "bounty"', () => {
    expect(composite.inputs.get('github_token')).toEqual({ required: true, default: undefined });
    expect(composite.inputs.get('gate_labels')?.default).toBe('bounty');
  });

  it('reads the gate inputs and issue labels in the check-gate step env', () => {
    // These are env: entries rather than inline ${{ }}, so assert on the raw
    // text of the step instead of the parsed expression refs.
    expect(checkGate.run).toContain('GITHUB_OUTPUT');
    const rawStep = fs.readFileSync(LABEL_GATE_PATH, 'utf8');
    expect(rawStep).toContain('GATE_LABELS: ${{ inputs.gate_labels }}');
    expect(rawStep).toContain('GITHUB_TOKEN: ${{ inputs.github_token }}');
    expect(rawStep).toContain('ISSUE_LABELS_JSON: ${{ toJSON(github.event.issue.labels) }}');
  });

  it('fails open outside an issue context (gate_skipped=false on the early exit)', () => {
    expect(checkGate.githubOutputWrites).toContain('gate_skipped');
    expect(checkGate.githubOutputWrites).toContain('gate_label_found');
    // The early-exit path must write gate_skipped=false *before* exiting.
    const earlyExitIndex = checkGate.run.indexOf('Running outside issue context');
    const beforeExit = checkGate.run.slice(0, earlyExitIndex);
    expect(beforeExit).toContain('echo "gate_skipped=false" >> "$GITHUB_OUTPUT"');
  });

  it('publishes both gate control outputs the composite declares', () => {
    const published = new Set(checkGate.githubOutputWrites);
    for (const name of ['gate_skipped', 'gate_label_found']) {
      expect(published.has(name)).toBe(true);
      expect(composite.outputs.get(name)).toContain(`steps.check-gate.outputs.${name}`);
    }
  });

  it('sets gate_skipped=true only when no gate label matches', () => {
    expect(checkGate.run).toContain('echo "gate_skipped=true" >> "$GITHUB_OUTPUT"');
    expect(checkGate.run).toContain('Label gate closed (no gate labels found)');
  });

  it('records the matching label in gate_label_found', () => {
    expect(checkGate.run).toContain('echo "gate_label_found=$found_label" >> "$GITHUB_OUTPUT"');
  });

  // ── Conditional execution wiring ─────────────────────────────────────────

  it('runs trustbridge-action only when the gate is open', () => {
    expect(runTrustBridge.if).toBe("steps.check-gate.outputs.gate_skipped != 'true'");
  });

  it('posts the skip comment only when the gate is closed and the input opts in', () => {
    expect(skipComment!.if).toBe(
      "steps.check-gate.outputs.gate_skipped == 'true' && inputs.post_skip_comment == 'true'",
    );
    expect(skipComment!.shell).toBe('bash');
  });

  it('never both skips and validates', () => {
    expect(runTrustBridge.if).not.toContain('== \'true\'');
    expect(skipComment!.if).not.toContain('!= \'true\'');
  });

  it('defaults post_skip_comment to false', () => {
    expect(composite.inputs.get('post_skip_comment')?.default).toBe('false');
  });

  it('runs the gate check with a pinned bash shell', () => {
    expect(checkGate.shell).toBe('bash');
  });

  // ── Input forwarding ─────────────────────────────────────────────────────

  it('invokes this repository action, pinned to a commit SHA', () => {
    expect(runTrustBridge.uses).toMatch(/^Stellar-TrustBridge\/trustbridge-action@[0-9a-f]{40}$/);
  });

  it('forwards stellar_address_input and github_token', () => {
    expect(runTrustBridge.with.get('stellar_address_input')).toBe('${{ inputs.stellar_address_input }}');
    expect(runTrustBridge.with.get('github_token')).toBe('${{ inputs.github_token }}');
  });

  it('only forwards inputs that the composite declares', () => {
    const undeclared = [...runTrustBridge.with.keys()].filter(
      (key) => !composite.inputs.has(key),
    );
    expect(undeclared).toEqual([]);
  });

  it('only forwards inputs that trustbridge-action declares', () => {
    const unknown = [...runTrustBridge.with.keys()].filter((key) => !actionInputs.has(key));
    expect(
      unknown,
    ).toEqual([]);
  });

  it('only forwards inputs from `inputs.*` (never hardcoded values)', () => {
    const hardcoded = [...runTrustBridge.with.entries()]
      .filter(([, value]) => !value.startsWith('${{ inputs.'))
      .map(([key, value]) => `${key}=${value}`);
    expect(hardcoded).toEqual([]);
  });

  it('references only declared inputs anywhere in the composite', () => {
    const undeclared = composite.inputRefs.filter((name) => !composite.inputs.has(name));
    expect(undeclared).toEqual([]);
  });

  // ── Output forwarding ────────────────────────────────────────────────────

  it('reads every output expression from an existing step id', () => {
    const knownIds = new Set(composite.steps.map((s) => s.id));
    const dangling = composite.stepOutputRefs
      .filter((ref) => !knownIds.has(ref.stepId))
      .map((ref) => ref.stepId);
    expect(dangling).toEqual([]);
  });

  it('declares both the gate and the pass-through outputs', () => {
    for (const name of [
      'gate_skipped',
      'gate_label_found',
      'trustline_exists',
      'xlm_balance',
      'account_funded',
      'comment_url',
      'ready',
    ]) {
      expect(composite.outputs.has(name)).toBe(true);
    }
  });

  it('routes every non-gate output through the run-trustbridge step', () => {
    const misplaced = [...composite.outputs.entries()]
      .filter(([name]) => !name.startsWith('gate_'))
      .filter(([, value]) => !value.includes('steps.run-trustbridge.outputs.'))
      .map(([name]) => name);
    expect(misplaced).toEqual([]);
  });

  it('routes every gate output through the check-gate step', () => {
    const misplaced = [...composite.outputs.entries()]
      .filter(([name]) => name.startsWith('gate_'))
      .filter(([, value]) => !value.includes('steps.check-gate.outputs.'))
      .map(([name]) => name);
    expect(misplaced).toEqual([]);
  });

  /**
   * Known gap, pinned rather than fixed here.
   *
   * Issue #466 added `asset_balance_met`, `check_account_funded`,
   * `check_trustline` and `check_xlm_reserve` to the composite's outputs, but
   * trustbridge-action's own `action.yml` never declared those outputs, so the
   * four composite outputs always resolve to an empty string. Closing the gap
   * means changing the action's public output surface (or dropping the
   * composite outputs and the `#466` tests that assert them), which is outside
   * this issue's scope.
   */
  const KNOWN_UNDECLARED_FORWARDED_OUTPUTS = [
    'asset_balance_met',
    'check_account_funded',
    'check_trustline',
    'check_xlm_reserve',
  ];

  it('forwards only outputs trustbridge-action actually declares', () => {
    const forwarded = [...composite.outputs.entries()]
      .filter(([, value]) => value.includes('steps.run-trustbridge.outputs.'))
      .map(([name]) => name);

    const undeclared = forwarded.filter((name) => !actionOutputs.has(name));
    expect(undeclared).toEqual(KNOWN_UNDECLARED_FORWARDED_OUTPUTS);
  });

  it('declares a description for every composite input and output', () => {
    const raw = fs.readFileSync(LABEL_GATE_PATH, 'utf8');
    for (const name of [...composite.inputs.keys(), ...composite.outputs.keys()]) {
      const block = new RegExp(`^ {2}${name}:\\n(?: {4}.*\\n)+`, 'm').exec(raw);
      expect(block).not.toBeNull();
      expect(block![0]).toContain('description:');
    }
  });
});
