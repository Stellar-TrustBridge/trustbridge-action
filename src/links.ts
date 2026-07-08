export type StellarNetwork = 'public' | 'testnet';

export function inferStellarNetwork(horizonUrl: string): StellarNetwork {
  return horizonUrl.toLowerCase().includes('testnet') ? 'testnet' : 'public';
}

export function buildAccountViewerLink(stellarAddress: string, network: StellarNetwork): string {
  const params = new URLSearchParams({ network, account: stellarAddress });
  return `https://laboratory.stellar.org/#account-viewer?${params.toString()}`;
}

export function buildChangeTrustLink(network: StellarNetwork): string {
  const params = new URLSearchParams({ network });
  return `https://laboratory.stellar.org/#txbuilder?${params.toString()}`;
}

export function buildLobstrLink(): string {
  return 'https://lobstr.co/';
}
