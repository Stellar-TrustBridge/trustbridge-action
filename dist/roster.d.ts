import { AssigneeAddressMap } from './inputs';
export declare function fetchDashboardRoster(url: string, secret: string, timeoutMs: number, fetchFn?: typeof fetch): Promise<AssigneeAddressMap>;
