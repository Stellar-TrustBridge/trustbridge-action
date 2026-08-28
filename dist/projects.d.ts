export interface ProjectV2FieldOption {
    id: string;
    name: string;
}
export interface ProjectV2Field {
    id: string;
    name: string;
    options?: ProjectV2FieldOption[];
}
export interface ProjectV2Node {
    id: string;
    fields?: {
        nodes: ProjectV2Field[];
    };
}
export interface UpdateProjectV2StatusOptions {
    octokit: {
        graphql: <T = any>(query: string, parameters?: Record<string, any>) => Promise<T>;
    };
    projectId: string;
    contentNodeId: string;
    statusFieldName?: string;
    targetStatusValue: string;
}
export interface UpdateProjectV2Result {
    updated: boolean;
    itemId?: string;
    error?: string;
}
/**
 * Update the status field of an item in a GitHub Projects v2 board.
 *
 * Opt-in only: when projectId or targetStatusValue is empty, does nothing.
 * Automatically adds the issue/PR to the project if not already present (idempotent).
 * Handles missing token scopes or rate limits with descriptive warnings without failing the workflow.
 */
export declare function updateProjectV2Status(options: UpdateProjectV2StatusOptions): Promise<UpdateProjectV2Result>;
