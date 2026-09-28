import { AssigneeAddressMap } from './inputs';
export declare function fetchDashboardRoster(url: string, secret: string, timeoutMs: number, allowHttp?: boolean, fetchFn?: typeof fetch): Promise<AssigneeAddressMap>;
