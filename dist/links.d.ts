export type StellarNetwork = 'public' | 'testnet';
export declare function inferStellarNetwork(horizonUrl: string): StellarNetwork;
export declare function buildAccountViewerLink(stellarAddress: string, network: StellarNetwork): string;
export declare function buildChangeTrustLink(network: StellarNetwork): string;
export declare function buildLobstrLink(): string;
