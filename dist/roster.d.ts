import { AssigneeAddressMap } from './inputs';
export interface RosterFilterOptions {
    allowlist?: string[];
    denylist?: string[];
}
/**
 * Filter a batch assignee address map against roster allowlist/denylist entries.
 *
 * - Allowlist: when non-empty, only entries whose address is in the allowlist are kept.
 * - Denylist: entries whose address is in the denylist are always removed.
 * - Denylist takes precedence over allowlist.
 * - Empty allowlist means "allow all" (subject to denylist).
 * - Empty map returns an empty map.
 * - Matching is case-insensitive and whitespace-trimmed.
 */
export declare function filterRosterAddressMap(addressMap: AssigneeAddressMap, options?: RosterFilterOptions): AssigneeAddressMap;
export declare function fetchDashboardRoster(url: string, secret: string, timeoutMs: number, allowHttp?: boolean, fetchFn?: typeof fetch): Promise<AssigneeAddressMap>;
