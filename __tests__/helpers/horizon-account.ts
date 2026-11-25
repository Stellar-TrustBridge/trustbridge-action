import type {
  HorizonAccount,
  HorizonBalance,
  HorizonBalanceCredit,
} from '../../src/horizon';

export const TEST_HORIZON_ACCOUNT_ID =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
export const TEST_HORIZON_ASSET_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

export interface HorizonTrustlineFixture {
  assetCode: string;
  assetIssuer: string;
  balance?: string;
  assetType?: HorizonBalanceCredit['asset_type'];
  limit?: string;
  isAuthorized?: boolean;
  isAuthorizedToMaintainLiabilities?: boolean;
  isClawbackEnabled?: boolean;
}

export interface HorizonAccountFixtureOptions {
  accountId?: string;
  sequence?: string;
  nativeBalance?: string;
  trustlines?: HorizonTrustlineFixture[];
  balances?: HorizonBalance[];
  subentryCount?: number;
  numSponsoring?: number;
  numSponsored?: number;
  flags?: HorizonAccount['flags'];
}

export function makeHorizonAccount(
  options: HorizonAccountFixtureOptions = {},
): HorizonAccount {
  const accountId = options.accountId ?? TEST_HORIZON_ACCOUNT_ID;
  const trustlines = options.trustlines ?? [];
  const generatedBalances: HorizonBalance[] = [
    {
      balance: options.nativeBalance ?? '10.0000000',
      asset_type: 'native',
      buying_liabilities: '0.0000000',
      selling_liabilities: '0.0000000',
    },
    ...trustlines.map((trustline): HorizonBalanceCredit => ({
      balance: trustline.balance ?? '0.0000000',
      asset_type:
        trustline.assetType ??
        (trustline.assetCode.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'),
      asset_code: trustline.assetCode,
      asset_issuer: trustline.assetIssuer,
      buying_liabilities: '0.0000000',
      selling_liabilities: '0.0000000',
      ...(trustline.limit === undefined ? {} : { limit: trustline.limit }),
      ...(trustline.isAuthorized === undefined
        ? {}
        : { is_authorized: trustline.isAuthorized }),
      ...(trustline.isAuthorizedToMaintainLiabilities === undefined
        ? {}
        : {
            is_authorized_to_maintain_liabilities:
              trustline.isAuthorizedToMaintainLiabilities,
          }),
      ...(trustline.isClawbackEnabled === undefined
        ? {}
        : { is_clawback_enabled: trustline.isClawbackEnabled }),
    })),
  ];

  return {
    id: accountId,
    account_id: accountId,
    sequence: options.sequence ?? '123456789',
    subentry_count: options.subentryCount ?? trustlines.length,
    num_sponsoring: options.numSponsoring ?? 0,
    num_sponsored: options.numSponsored ?? 0,
    balances: options.balances ?? generatedBalances,
    ...(options.flags === undefined ? {} : { flags: options.flags }),
  };
}
