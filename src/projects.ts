import * as core from '@actions/core';
import { logger } from './logger';

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
  octokit: { graphql: <T = any>(query: string, parameters?: Record<string, any>) => Promise<T> };
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
export async function updateProjectV2Status(
  options: UpdateProjectV2StatusOptions,
): Promise<UpdateProjectV2Result> {
  const { octokit, projectId, contentNodeId, targetStatusValue } = options;
  const statusFieldName = (options.statusFieldName || 'Status').trim();

  if (!projectId || !projectId.trim()) {
    return { updated: false };
  }

  if (!targetStatusValue || !targetStatusValue.trim()) {
    return { updated: false };
  }

  if (!contentNodeId || !contentNodeId.trim()) {
    core.warning('[Projects v2] Cannot update project item status: contentNodeId is missing.');
    return { updated: false, error: 'Missing contentNodeId' };
  }

  const cleanProjectId = projectId.trim();
  const cleanTargetValue = targetStatusValue.trim();

  try {
    // 1. Fetch project fields
    const fieldsQuery = `
      query getProjectFields($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            id
            fields(first: 50) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
                ... on ProjectV2Field {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `;

    const projectResponse = await octokit.graphql<{ node?: ProjectV2Node }>(fieldsQuery, {
      projectId: cleanProjectId,
    });

    const projectNode = projectResponse?.node;
    if (!projectNode || !projectNode.fields?.nodes) {
      const msg = `Project v2 with ID "${cleanProjectId}" not found or lacks readable fields. Check token scope and project_id.`;
      core.warning(`[Projects v2] ${msg}`);
      return { updated: false, error: msg };
    }

    const fieldNodes = projectNode.fields.nodes;
    const targetField = fieldNodes.find(
      (f) => f.name.trim().toLowerCase() === statusFieldName.toLowerCase(),
    );

    if (!targetField) {
      const availableFields = fieldNodes.map((f) => `"${f.name}"`).join(', ');
      const msg = `Status field "${statusFieldName}" not found in Project v2. Available fields: ${availableFields}`;
      core.warning(`[Projects v2] ${msg}`);
      return { updated: false, error: msg };
    }

    // 2. Add or find item in project (idempotent)
    const addItemMutation = `
      mutation addProjectItem($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item {
            id
          }
        }
      }
    `;

    const addResponse = await octokit.graphql<{
      addProjectV2ItemById?: { item?: { id: string } };
    }>(addItemMutation, {
      projectId: cleanProjectId,
      contentId: contentNodeId,
    });

    const itemId = addResponse?.addProjectV2ItemById?.item?.id;
    if (!itemId) {
      const msg = `Could not add or locate content ${contentNodeId} in Project v2.`;
      core.warning(`[Projects v2] ${msg}`);
      return { updated: false, error: msg };
    }

    // 3. Update field value
    if (targetField.options && targetField.options.length > 0) {
      // Single-select field
      const matchingOption = targetField.options.find(
        (opt) => opt.name.trim().toLowerCase() === cleanTargetValue.toLowerCase(),
      );

      if (!matchingOption) {
        const availableOptions = targetField.options.map((opt) => `"${opt.name}"`).join(', ');
        const msg = `Option "${cleanTargetValue}" not found for single-select field "${targetField.name}". Available options: ${availableOptions}`;
        core.warning(`[Projects v2] ${msg}`);
        return { updated: false, error: msg };
      }

      const updateMutation = `
        mutation updateSingleSelectValue($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: {
              singleSelectOptionId: $optionId
            }
          }) {
            projectV2Item {
              id
            }
          }
        }
      `;

      await octokit.graphql(updateMutation, {
        projectId: cleanProjectId,
        itemId,
        fieldId: targetField.id,
        optionId: matchingOption.id,
      });
    } else {
      // Text field
      const updateMutation = `
        mutation updateTextValue($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: {
              text: $text
            }
          }) {
            projectV2Item {
              id
            }
          }
        }
      `;

      await octokit.graphql(updateMutation, {
        projectId: cleanProjectId,
        itemId,
        fieldId: targetField.id,
        text: cleanTargetValue,
      });
    }

    core.info(
      `[Projects v2] Updated item ${itemId} field "${targetField.name}" to "${cleanTargetValue}" in project ${cleanProjectId}.`,
    );
    return { updated: true, itemId };
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    let userMsg = rawMsg;
    if (
      rawMsg.includes('Resource not accessible') ||
      rawMsg.includes('FORBIDDEN') ||
      rawMsg.includes('scope') ||
      rawMsg.includes('Could not resolve to a node')
    ) {
      userMsg = `${rawMsg}. Ensure the token has the 'project' scope (or write:org / fine-grained Projects read & write permissions).`;
    }
    logger.warn(`Projects v2 status update error: ${userMsg}`, { component: 'projects' });
    core.warning(`[Projects v2] Failed to update project status (non-fatal): ${userMsg}`);
    return { updated: false, error: userMsg };
  }
}
