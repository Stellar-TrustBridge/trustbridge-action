import { formatCommentBody } from '../src/comment';
import { ValidationResult } from '../src/checks';

const validationResult: ValidationResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  xlmReserveMet: false,
  checks: [
    {
      passed: false,
      label: 'Account funded',
      detail: 'Account was not found.',
    },
  ],
};

const baseConfig = {
  stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
};

describe('formatCommentBody', () => {
  it('uses public Stellar Laboratory links for public Horizon', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toContain('account-viewer?network=public&account=');
    expect(body).toContain('txbuilder?network=public');
  });

  it('uses testnet Stellar Laboratory links for testnet Horizon', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });

    expect(body).toContain('account-viewer?network=testnet&account=');
    expect(body).toContain('txbuilder?network=testnet');
  });
});
