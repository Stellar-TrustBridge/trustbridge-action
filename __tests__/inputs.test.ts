import {
  getErrorMessage,
  parseBooleanInput,
  parseNumberInput,
  parsePresetInput,
  resolveGitHubAuthToken,
  resolveMaintainerSkipInput,
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

