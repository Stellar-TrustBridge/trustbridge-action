import {
  getErrorMessage,
  parseBooleanInput,
  parseNumberInput,
  parsePresetInput,
  resolveGitHubAuthToken,
  resolveMaintainerSkipInput,
  resolveReadyLabelInputs,
} from '../src/inputs';

describe('parseBooleanInput', () => {
  it.each(['true', 'TRUE', '1', 'yes', ' Yes '])(
    'parses %s as true',
    (value) => {
      expect(parseBooleanInput(value, false)).toBe(true);
    },
  );

  it.each(['false', 'FALSE', '0', 'no', ' No '])(
    'parses %s as false',
    (value) => {
      expect(parseBooleanInput(value, true)).toBe(false);
    },
  );

  it('falls back to the default for blank values', () => {
    expect(parseBooleanInput('', true)).toBe(true);
  });

  it('falls back to the default for unknown values', () => {
    expect(parseBooleanInput('sometimes', false)).toBe(false);
  });
});

describe('parseNumberInput', () => {
  it('returns default value for blank inputs', () => {
    expect(parseNumberInput('', 20)).toBe(20);
  });

  it('parses numeric strings correctly', () => {
    expect(parseNumberInput(' 1500 ', 1000)).toBe(1500);
  });

  it('throws when input is not numeric', () => {
    expect(() => parseNumberInput('abc', 1000)).toThrow(
      'Expected a numeric input, but received: "abc"',
    );
  });

  it('throws when input is below min', () => {
    expect(() => parseNumberInput('0', 1000, { min: 1 })).toThrow(
      'Value must be at least 1. Received: 0',
    );
  });

  it('throws when input is above max', () => {
    expect(() => parseNumberInput('100', 10, { max: 50 })).toThrow(
      'Value must be at most 50. Received: 100',
    );
  });
});

describe('getErrorMessage', () => {
  it('reads Error messages and stringifies unknown values', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    expect(getErrorMessage('plain')).toBe('plain');
  });
});

describe('parsePresetInput', () => {
  it('prioritizes preset over network', () => {
    expect(parsePresetInput('public', 'testnet')).toBe('testnet');
  });

  it('uses network when preset is empty', () => {
    expect(parsePresetInput('testnet', '')).toBe('testnet');
  });

  it('returns empty string when both are empty', () => {
    expect(parsePresetInput('', '')).toBe('');
  });
});

describe('resolveGitHubAuthToken (Issue #225)', () => {
  it('prefers github_app_token over github_token when both are provided', () => {
    const token = resolveGitHubAuthToken({
      githubToken: 'ghp_userToken',
      githubAppToken: 'ghs_appInstallationToken',
    });
    expect(token).toBe('ghs_appInstallationToken');
  });

  it('uses github_token when github_app_token is not provided', () => {
    const token = resolveGitHubAuthToken({
      githubToken: 'ghp_userToken',
    });
    expect(token).toBe('ghp_userToken');
  });

  it('uses github_app_token when github_token is empty string', () => {
    const token = resolveGitHubAuthToken({
      githubToken: '',
      githubAppToken: 'ghs_appInstallationToken',
    });
    expect(token).toBe('ghs_appInstallationToken');
  });

  it('throws a descriptive error when neither token is provided', () => {
    expect(() => resolveGitHubAuthToken({})).toThrow(
      'Missing GitHub authentication token. Please provide either `github_token` or `github_app_token`.',
    );
    expect(() => resolveGitHubAuthToken({ githubToken: '   ', githubAppToken: '' })).toThrow(
      'Missing GitHub authentication token. Please provide either `github_token` or `github_app_token`.',
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #448 — skip_for_maintainers / skip_if_maintainer precedence
// ---------------------------------------------------------------------------

describe('resolveMaintainerSkipInput (Issue #448)', () => {
  describe('canonical input alone', () => {
    it.each(['true', 'TRUE', '1', 'yes', ' Yes '])(
      'enables the skip for %s',
      (value) => {
        const resolved = resolveMaintainerSkipInput(value, '');
        expect(resolved.enabled).toBe(true);
        expect(resolved.source).toBe('skip_for_maintainers');
        expect(resolved.usedDeprecatedAlias).toBe(false);
        expect(resolved.conflict).toBe(false);
      },
    );

    it.each(['false', 'FALSE', '0', 'no', ' No '])(
      'disables the skip for %s',
      (value) => {
        const resolved = resolveMaintainerSkipInput(value, '');
        expect(resolved.enabled).toBe(false);
        expect(resolved.source).toBe('skip_for_maintainers');
      },
    );
  });

  describe('deprecated alias alone', () => {
    it('is honoured when the canonical input is unset', () => {
      const resolved = resolveMaintainerSkipInput('', 'true');
      expect(resolved.enabled).toBe(true);
      expect(resolved.source).toBe('skip_if_maintainer');
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });

    it('can disable the skip', () => {
      const resolved = resolveMaintainerSkipInput('', 'false');
      expect(resolved.enabled).toBe(false);
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });

    it('is ignored when the alias holds an unparseable value', () => {
      const resolved = resolveMaintainerSkipInput('', 'maybe');
      expect(resolved.enabled).toBe(false);
      expect(resolved.source).toBe('default');
      expect(resolved.usedDeprecatedAlias).toBe(false);
    });
  });

  describe('precedence and conflicts', () => {
    it('canonical true wins over alias false and flags the conflict', () => {
      const resolved = resolveMaintainerSkipInput('true', 'false');
      expect(resolved.enabled).toBe(true);
      expect(resolved.source).toBe('skip_for_maintainers');
      expect(resolved.conflict).toBe(true);
    });

    it('canonical false wins over alias true and flags the conflict', () => {
      // The whole point of #448: an explicit canonical `false` must not be
      // silently overridden by a stale alias.
      const resolved = resolveMaintainerSkipInput('false', 'true');
      expect(resolved.enabled).toBe(false);
      expect(resolved.source).toBe('skip_for_maintainers');
      expect(resolved.conflict).toBe(true);
    });

    it('reports no conflict when both inputs agree', () => {
      expect(resolveMaintainerSkipInput('true', 'true').conflict).toBe(false);
      expect(resolveMaintainerSkipInput('false', 'false').conflict).toBe(false);
    });

    it('ignores an unparseable canonical value in favour of the alias', () => {
      const resolved = resolveMaintainerSkipInput('nonsense', 'true');
      expect(resolved.enabled).toBe(true);
      expect(resolved.source).toBe('skip_if_maintainer');
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });
  });

  describe('defaults', () => {
    it('is opt-out (false) when neither input is supplied', () => {
      expect(resolveMaintainerSkipInput('', '')).toEqual({
        enabled: false,
        source: 'default',
        conflict: false,
        usedDeprecatedAlias: false,
      });
    });

    it('is opt-out when both inputs are undefined', () => {
      const resolved = resolveMaintainerSkipInput(undefined, undefined);
      expect(resolved.enabled).toBe(false);
      expect(resolved.source).toBe('default');
    });

    it('treats a whitespace-only canonical value as unset', () => {
      const resolved = resolveMaintainerSkipInput('   ', 'true');
      expect(resolved.enabled).toBe(true);
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });
  });
});


// ---------------------------------------------------------------------------
// Issue #669 � deprecated ready_label alias chains
// ---------------------------------------------------------------------------

describe('resolveReadyLabelInputs (Issue #669)', () => {
  describe('pass chain: pass_label -> ready_pass_label -> ready_label_pass', () => {
    it('uses pass_label when it is the only value supplied', () => {
      const resolved = resolveReadyLabelInputs({ passLabel: 'wallet-ready' });
      expect(resolved.passLabel).toBe('wallet-ready');
      expect(resolved.usedDeprecatedAlias).toBe(false);
    });

    it('falls back to ready_pass_label when pass_label is empty', () => {
      const resolved = resolveReadyLabelInputs({
        passLabel: '',
        readyPassLabel: 'legacy-pass',
      });
      expect(resolved.passLabel).toBe('legacy-pass');
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });

    it('falls back to ready_label_pass when both higher tiers are empty', () => {
      const resolved = resolveReadyLabelInputs({
        passLabel: '',
        readyPassLabel: '',
        readyLabelPass: 'oldest-pass',
      });
      expect(resolved.passLabel).toBe('oldest-pass');
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });

    it('prefers ready_pass_label over ready_label_pass when both are set', () => {
      const resolved = resolveReadyLabelInputs({
        readyPassLabel: 'newer-alias',
        readyLabelPass: 'older-alias',
      });
      expect(resolved.passLabel).toBe('newer-alias');
    });

    it('ignores every deprecated alias when pass_label is non-empty', () => {
      const resolved = resolveReadyLabelInputs({
        passLabel: 'canonical',
        readyPassLabel: 'stale-1',
        readyLabelPass: 'stale-2',
      });
      expect(resolved.passLabel).toBe('canonical');
      expect(resolved.usedDeprecatedAlias).toBe(false);
    });
  });

  describe('fail chain: fail_label -> ready_fail_label -> ready_label_fail', () => {
    it('uses fail_label when it is the only value supplied', () => {
      const resolved = resolveReadyLabelInputs({ failLabel: 'wallet-blocked' });
      expect(resolved.failLabel).toBe('wallet-blocked');
    });

    it('falls back to ready_fail_label when fail_label is empty', () => {
      const resolved = resolveReadyLabelInputs({
        failLabel: '',
        readyFailLabel: 'legacy-fail',
      });
      expect(resolved.failLabel).toBe('legacy-fail');
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });

    it('falls back to ready_label_fail when both higher tiers are empty', () => {
      const resolved = resolveReadyLabelInputs({
        failLabel: '',
        readyFailLabel: '',
        readyLabelFail: 'oldest-fail',
      });
      expect(resolved.failLabel).toBe('oldest-fail');
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });

    it('prefers ready_fail_label over ready_label_fail when both are set', () => {
      const resolved = resolveReadyLabelInputs({
        readyFailLabel: 'newer-alias',
        readyLabelFail: 'older-alias',
      });
      expect(resolved.failLabel).toBe('newer-alias');
    });
  });

  describe('whitespace-only values are treated as unset', () => {
    it('falls through a whitespace-only pass_label', () => {
      const resolved = resolveReadyLabelInputs({
        passLabel: '   ',
        readyPassLabel: 'ready',
      });
      expect(resolved.passLabel).toBe('ready');
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });

    it('falls through whitespace-only aliases at every tier', () => {
      const resolved = resolveReadyLabelInputs({
        passLabel: '  ',
        readyPassLabel: '\t\n ',
        readyLabelPass: 'deepest',
      });
      expect(resolved.passLabel).toBe('deepest');
    });

    it('falls through a whitespace-only fail_label', () => {
      const resolved = resolveReadyLabelInputs({
        failLabel: ' ',
        readyLabelFail: 'blocked',
      });
      expect(resolved.failLabel).toBe('blocked');
    });
  });

  describe('trimming', () => {
    it('trims surrounding whitespace from the resolved label', () => {
      // GitHub treats ' wallet-ready ' and 'wallet-ready' as distinct labels,
      // so an untrimmed value would create a second label by accident.
      const resolved = resolveReadyLabelInputs({ passLabel: '  wallet-ready  ' });
      expect(resolved.passLabel).toBe('wallet-ready');
    });

    it('trims a value resolved from a deprecated alias', () => {
      const resolved = resolveReadyLabelInputs({ readyLabelPass: '\n wallet-ready \n' });
      expect(resolved.passLabel).toBe('wallet-ready');
    });
  });

  describe('the two chains resolve independently', () => {
    it('supports a canonical pass label with a deprecated fail alias', () => {
      const resolved = resolveReadyLabelInputs({
        passLabel: 'ready',
        readyLabelFail: 'blocked',
      });
      expect(resolved.passLabel).toBe('ready');
      expect(resolved.failLabel).toBe('blocked');
      // The alias was used for one chain, so the flag reflects that.
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });

    it('supports a deprecated pass alias with a canonical fail label', () => {
      const resolved = resolveReadyLabelInputs({
        readyPassLabel: 'ready',
        failLabel: 'blocked',
      });
      expect(resolved.passLabel).toBe('ready');
      expect(resolved.failLabel).toBe('blocked');
    });
  });

  describe('defaults', () => {
    it('returns empty strings when nothing is supplied', () => {
      expect(resolveReadyLabelInputs({})).toEqual({
        passLabel: '',
        failLabel: '',
        usedDeprecatedAlias: false,
      });
    });

    it('treats undefined values the same as empty ones', () => {
      expect(resolveReadyLabelInputs({})).toEqual(
        resolveReadyLabelInputs({
          passLabel: undefined,
          readyPassLabel: undefined,
          readyLabelPass: undefined,
          failLabel: undefined,
          readyFailLabel: undefined,
          readyLabelFail: undefined,
        }),
      );
    });
  });

  describe('deprecation warning trigger', () => {
    it('flags the alias when only a deprecated input supplies the value', () => {
      const resolved = resolveReadyLabelInputs({ readyLabelPass: 'ready' });
      expect(resolved.usedDeprecatedAlias).toBe(true);
    });

    it('does not flag the alias when every supplied value is canonical', () => {
      const resolved = resolveReadyLabelInputs({ passLabel: 'a', failLabel: 'b' });
      expect(resolved.usedDeprecatedAlias).toBe(false);
    });
  });
});
