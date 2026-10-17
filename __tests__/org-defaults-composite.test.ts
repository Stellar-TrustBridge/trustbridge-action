/**
 * Org-defaults composite action wiring (Issue #693).
 *
 * `.github/actions/trustbridge-org-defaults/action.yml` is a composite action
 * that injects organization-wide default policy values (Horizon URL, asset
 * code, asset issuer, minimum XLM reserve, fail_on_missing, sticky_comment)
 * before calling trustbridge-action. Repositories can override any default via
 * the corresponding non-org_* input.
 *
 * Nothing in `src/` covers that file, and a composite action is only
 * statically inspectable — so these tests parse the YAML structure and assert
 * the wiring end to end:
 *
 *   org_* defaults  ──► resolve-policy (bash) ──► run-trustbridge.with
 *   repo overrides  ──► resolve-policy (bash) ──► run-trustbridge.with
 *   passthrough     ──► run-trustbridge.with      ──► action.yml inputs
 *   step outputs    ──► composite outputs          ──► action.yml outputs
 *
 * Like `label-gate-composite.test.ts`, the YAML reader here is a deliberately
 * narrow line-based extractor rather than a new dependency.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const ORG_DEFAULTS_PATH = path.join(
  REPO_ROOT,
  '.github/actions/trustbridge-org-defaults/action.yml',
);
const ACTION_YML_PATH = path.join(REPO_ROOT, 'action.yml');

interface StepBlock {
  /** Step `name:` as written. */
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
function stepOutputRefsIn(
  text: string,
): Array<{ stepId: string; output: string }> {
  return expressionsIn(text)
    .map(
      (expr) =>
        /^steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(
          expr,
        ),
    )
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
    const match =
      /^\s*echo\s+"([^="]+)=[^"]*"\s*>>\s*"?\$\{?GITHUB_OUTPUT\}?"?/.exec(line);
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

    const withKey =
      /^ {8}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
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
      inputs.set(currentKey, {
        required: currentRequired,
        default: currentDefault,
      });
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
    throw new Error(
      'No `runs.steps:` found in the org-defaults composite action.',
    );
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

describe('trustbridge-org-defaults composite action wiring (#693)', () => {
  const composite = parseCompositeAction(
    fs.readFileSync(ORG_DEFAULTS_PATH, 'utf8'),
  );
  const actionYml = fs.readFileSync(ACTION_YML_PATH, 'utf8');
  const actionInputs = actionYmlInputNames(actionYml);
  const actionOutputs = actionYmlOutputNames(actionYml);

  const stepById = (id: string): StepBlock => {
    const step = composite.steps.find((s) => s.id === id);
    if (!step) {
      throw new Error(
        'Composite action has no step with id "' +
          id +
          '". Found: ' +
          composite.steps.map((s) => s.id ?? s.name).join(', '),
      );
    }
    return step;
  };

  const resolvePolicy = stepById('resolve-policy');
  const runTrustBridge = stepById('run-trustbridge');

  // Helper: build a ${{ inputs.name }} expression string without
  // triggering JavaScript template-literal interpolation.
  function inputsExpr(name: string): string {
    return '${{ inputs.' + name + ' }}';
  }

  function stepOutputsExpr(stepId: string, output: string): string {
    return '${{ steps.' + stepId + '.outputs.' + output + ' }}';
  }

  // ── Shape ────────────────────────────────────────────────────────────────

  it('is a composite action', () => {
    expect(composite.using).toBe('composite');
  });

  it('has exactly the two documented steps, in order', () => {
    expect(composite.steps).toHaveLength(2);
    expect(composite.steps[0]!.id).toBe('resolve-policy');
    expect(composite.steps[1]!.id).toBe('run-trustbridge');
  });

  it('gives every step a unique id', () => {
    const ids = composite.steps
      .map((s) => s.id)
      .filter((id): id is string => Boolean(id));
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it('runs policy resolution before the trustbridge invocation', () => {
    expect(composite.steps[0]!.name).toContain('Resolve org policy defaults');
    expect(composite.steps[1]!.name).toContain('Run TrustBridge');
  });

  // ── Required / default inputs ────────────────────────────────────────────

  it('requires github_token', () => {
    expect(composite.inputs.get('github_token')?.required).toBe(true);
  });

  it('declares stellar_address_input as optional with empty default', () => {
    expect(composite.inputs.get('stellar_address_input')?.required).toBe(false);
    expect(composite.inputs.get('stellar_address_input')?.default).toBe('');
  });

  it('declares org_* inputs with their documented defaults', () => {
    const expectations: Array<[string, string]> = [
      ['org_horizon_url', 'https://horizon.stellar.org'],
      ['org_asset_code', 'USDC'],
      [
        'org_asset_issuer',
        'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      ],
      ['org_min_xlm_reserve', '1.5'],
      ['org_fail_on_missing', 'true'],
      ['org_sticky_comment', 'true'],
    ];
    for (const [inputName, expectedDefault] of expectations) {
      expect(composite.inputs.get(inputName)?.required).toBe(false);
      expect(composite.inputs.get(inputName)?.default).toBe(expectedDefault);
    }
  });

  it('declares override inputs with empty defaults', () => {
    const overrideInputs = [
      'horizon_url',
      'asset_code',
      'asset_issuer',
      'min_xlm_reserve',
      'fail_on_missing',
      'sticky_comment',
    ];
    for (const name of overrideInputs) {
      expect(composite.inputs.get(name)?.required).toBe(false);
      expect(composite.inputs.get(name)?.default).toBe('');
    }
  });

  it('declares all passthrough inputs', () => {
    const passthrough = [
      'assignee_address_map',
      'debug_mode',
      'horizon_timeout_ms',
      'wait_until_funded',
      'wait_until_funded_timeout_ms',
      'wait_until_funded_interval_ms',
      'horizon_url_fallback',
      'rpc_fallback_url',
      'use_cache',
      'horizon_cache_ttl_ms',
      'allow_cross_network_fallback',
      'trustbridge_config_path',
      'log_inputs',
      'check_ledger_freshness',
      'max_ledger_lag_seconds',
      'ledger_freshness_fail_on_stale',
      'locale',
      'comment_mode',
      'auto_wallet_labels',
      'unassign_on_not_ready',
      'assets_json',
    ];
    for (const name of passthrough) {
      expect(composite.inputs.has(name)).toBe(true);
    }
  });

  // ── Policy resolution step ───────────────────────────────────────────────

  it('runs resolve-policy with bash shell', () => {
    expect(resolvePolicy.shell).toBe('bash');
  });

  it('reads both override and org_* inputs in the resolve function', () => {
    const resolvePairs: Array<[string, string]> = [
      ['horizon_url', 'org_horizon_url'],
      ['asset_code', 'org_asset_code'],
      ['asset_issuer', 'org_asset_issuer'],
      ['min_xlm_reserve', 'org_min_xlm_reserve'],
      ['fail_on_missing', 'org_fail_on_missing'],
      ['sticky_comment', 'org_sticky_comment'],
    ];
    for (const [override, orgDefault] of resolvePairs) {
      const expectedCall =
        'resolve("' +
        inputsExpr(override) +
        '" "' +
        inputsExpr(orgDefault) +
        '")';
      expect(resolvePolicy.run).toContain(expectedCall);
    }
  });

  it('writes all six resolved values to GITHUB_OUTPUT', () => {
    const expectedOutputs = [
      'horizon_url',
      'asset_code',
      'asset_issuer',
      'min_xlm_reserve',
      'fail_on_missing',
      'sticky_comment',
    ];
    for (const name of expectedOutputs) {
      expect(resolvePolicy.githubOutputWrites).toContain(name);
    }
    expect(resolvePolicy.githubOutputWrites).toHaveLength(
      expectedOutputs.length,
    );
  });

  it('implements override-wins precedence (non-empty override beats org default)', () => {
    // The resolve function: if [ -n "$override" ]; then echo "$override"; else echo "$org_default"; fi
    expect(resolvePolicy.run).toContain('if [ -n "$override" ]; then');
    expect(resolvePolicy.run).toContain('echo "$override"');
    expect(resolvePolicy.run).toContain('echo "$org_default"');
  });

  // ── Run-trustbridge step ─────────────────────────────────────────────────

  it('invokes this repository action pinned to a commit SHA', () => {
    expect(runTrustBridge.uses).toMatch(
      /^Stellar-TrustBridge\/trustbridge-action@[0-9a-f]{40}$/,
    );
  });

  it('forwards github_token and stellar_address_input directly', () => {
    expect(runTrustBridge.with.get('github_token')).toBe(
      inputsExpr('github_token'),
    );
    expect(runTrustBridge.with.get('stellar_address_input')).toBe(
      inputsExpr('stellar_address_input'),
    );
  });

  it('forwards resolved policy values from the resolve-policy step outputs', () => {
    const policyOutputs = [
      'horizon_url',
      'asset_code',
      'asset_issuer',
      'min_xlm_reserve',
      'fail_on_missing',
      'sticky_comment',
    ];
    for (const name of policyOutputs) {
      expect(runTrustBridge.with.get(name)).toBe(
        stepOutputsExpr('resolve-policy', name),
      );
    }
  });

  it('forwards all passthrough inputs directly from composite inputs', () => {
    const passthrough = [
      'assignee_address_map',
      'debug_mode',
      'horizon_timeout_ms',
      'wait_until_funded',
      'wait_until_funded_timeout_ms',
      'wait_until_funded_interval_ms',
      'horizon_url_fallback',
      'rpc_fallback_url',
      'use_cache',
      'horizon_cache_ttl_ms',
      'allow_cross_network_fallback',
      'trustbridge_config_path',
      'log_inputs',
      'check_ledger_freshness',
      'max_ledger_lag_seconds',
      'ledger_freshness_fail_on_stale',
      'locale',
      'comment_mode',
      'auto_wallet_labels',
      'unassign_on_not_ready',
      'assets_json',
    ];
    for (const name of passthrough) {
      expect(runTrustBridge.with.get(name)).toBe(inputsExpr(name));
    }
  });

  it('only forwards inputs that the composite declares', () => {
    const undeclared = [...runTrustBridge.with.keys()].filter(
      (key) => !composite.inputs.has(key),
    );
    expect(undeclared).toEqual([]);
  });

  it('only forwards inputs that trustbridge-action declares', () => {
    const unknown = [...runTrustBridge.with.keys()].filter(
      (key) => !actionInputs.has(key),
    );
    expect(unknown).toEqual([]);
  });

  it('references only declared inputs anywhere in the composite', () => {
    const undeclared = composite.inputRefs.filter(
      (name) => !composite.inputs.has(name),
    );
    expect(undeclared).toEqual([]);
  });

  it('reports an explicit test failure when an org_* input is removed from the composite', () => {
    // Acceptance criteria: "Test file fails when org default input removed from composite"
    const orgInputs = [
      'org_horizon_url',
      'org_asset_code',
      'org_asset_issuer',
      'org_min_xlm_reserve',
      'org_fail_on_missing',
      'org_sticky_comment',
    ];
    for (const name of orgInputs) {
      expect(composite.inputs.has(name)).toBe(true);
    }
  });

  // ── Output forwarding ────────────────────────────────────────────────────

  it('reads every output expression from an existing step id', () => {
    const knownIds = new Set(composite.steps.map((s) => s.id));
    const dangling = composite.stepOutputRefs
      .filter((ref) => !knownIds.has(ref.stepId))
      .map((ref) => ref.stepId);
    expect(dangling).toEqual([]);
  });

  it('routes every composite output through the run-trustbridge step', () => {
    const misplaced = [...composite.outputs.entries()]
      .filter(
        ([, value]) => !value.includes('steps.run-trustbridge.outputs.'),
      )
      .map(([name]) => name);
    expect(misplaced).toEqual([]);
  });

  it('forwards only outputs that trustbridge-action actually declares', () => {
    const forwarded = [...composite.outputs.entries()]
      .filter(([, value]) =>
        value.includes('steps.run-trustbridge.outputs.'),
      )
      .map(([name]) => name);

    const undeclared = forwarded.filter((name) => !actionOutputs.has(name));

    // The composite exposes `horizon_url_used` mapping to
    // `steps.run-trustbridge.outputs.horizon_url`.  The action.yml declares
    // the output as `horizon_url` (not `horizon_url_used`), so it is a
    // known-renamed output that is accepted here.
    const knownAliases = new Set(['horizon_url_used']);
    const trulyUndeclared = undeclared.filter(
      (name) => !knownAliases.has(name),
    );
    expect(trulyUndeclared).toEqual([]);
  });

  it('declares a description for every composite input and output', () => {
    const raw = fs.readFileSync(ORG_DEFAULTS_PATH, 'utf8');
    for (const name of [
      ...composite.inputs.keys(),
      ...composite.outputs.keys(),
    ]) {
      const block = new RegExp(
        '^ {2}' + name + ':\\n(?: {4}.*\\n)+',
        'm',
      ).exec(raw);
      expect(block).not.toBeNull();
      expect(block![0]).toContain('description:');
    }
  });

  // ── No hardcoded values ──────────────────────────────────────────────────

  it('never hardcodes a value in the run-trustbridge step (all from inputs or step outputs)', () => {
    const hardcoded = [...runTrustBridge.with.entries()]
      .filter(([, value]) => {
        const trimmed = value.trim();
        return (
          !trimmed.startsWith('${{ inputs.') &&
          !trimmed.startsWith('${{ steps.')
        );
      })
      .map(([key, value]) => key + '=' + value);
    expect(hardcoded).toEqual([]);
  });

  // ── Pinning ──────────────────────────────────────────────────────────────

  it('has no unpinned uses statement in the composite per policy', () => {
    for (const step of composite.steps) {
      if (step.uses) {
        // Must use a full 40-char commit SHA, not a semver tag or branch
        expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});