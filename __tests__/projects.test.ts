import { updateProjectV2Status } from '../src/projects';
import * as core from '@actions/core';
import { logger } from '../src/logger';

jest.mock('@actions/core');
jest.mock('../src/logger');

describe('updateProjectV2Status', () => {
  const mockGraphql = jest.fn();
  const mockOctokit = { graphql: mockGraphql };

  beforeEach(() => {
    mockGraphql.mockReset();
    jest.clearAllMocks();
  });

  it('updates project status (happy path, single-select)', async () => {
    mockGraphql.mockResolvedValueOnce({
      node: {
        fields: {
          nodes: [
            {
              id: 'field-1',
              name: 'Status',
              options: [
                { id: 'opt-1', name: 'Done' }
              ]
            }
          ]
        }
      }
    });

    mockGraphql.mockResolvedValueOnce({
      addProjectV2ItemById: {
        item: { id: 'item-1' }
      }
    });

    mockGraphql.mockResolvedValueOnce({});

    const result = await updateProjectV2Status({
      octokit: mockOctokit as any,
      projectId: 'proj-1',
      contentNodeId: 'content-1',
      targetStatusValue: 'Done'
    });

    expect(result).toEqual({ updated: true, itemId: 'item-1' });
    expect(mockGraphql).toHaveBeenCalledTimes(3);
  });

  it('updates project status (happy path, text field)', async () => {
    mockGraphql.mockResolvedValueOnce({
      node: {
        fields: {
          nodes: [
            {
              id: 'field-1',
              name: 'Status'
            }
          ]
        }
      }
    });

    mockGraphql.mockResolvedValueOnce({
      addProjectV2ItemById: {
        item: { id: 'item-1' }
      }
    });

    mockGraphql.mockResolvedValueOnce({});

    const result = await updateProjectV2Status({
      octokit: mockOctokit as any,
      projectId: 'proj-1',
      contentNodeId: 'content-1',
      targetStatusValue: 'Done'
    });

    expect(result).toEqual({ updated: true, itemId: 'item-1' });
  });

  it('handles missing project or missing fields', async () => {
    mockGraphql.mockResolvedValueOnce({ node: null });

    const result = await updateProjectV2Status({
      octokit: mockOctokit as any,
      projectId: 'proj-1',
      contentNodeId: 'content-1',
      targetStatusValue: 'Done'
    });

    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/not found or lacks readable fields/);
    expect(core.warning).toHaveBeenCalled();
  });

  it('handles missing status option', async () => {
    mockGraphql.mockResolvedValueOnce({
      node: {
        fields: {
          nodes: [
            {
              id: 'field-1',
              name: 'Status',
              options: [
                { id: 'opt-1', name: 'In Progress' }
              ]
            }
          ]
        }
      }
    });

    mockGraphql.mockResolvedValueOnce({
      addProjectV2ItemById: {
        item: { id: 'item-1' }
      }
    });

    mockGraphql.mockResolvedValueOnce({});

    const result = await updateProjectV2Status({
      octokit: mockOctokit as any,
      projectId: 'proj-1',
      contentNodeId: 'content-1',
      targetStatusValue: 'Done'
    });

    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/Option "Done" not found/);
    expect(core.warning).toHaveBeenCalled();
  });

  it('soft-fails on GraphQL errors (does not throw)', async () => {
    mockGraphql.mockRejectedValueOnce(new Error('Resource not accessible by integration'));

    const result = await updateProjectV2Status({
      octokit: mockOctokit as any,
      projectId: 'proj-1',
      contentNodeId: 'content-1',
      targetStatusValue: 'Done'
    });

    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/Resource not accessible/);
    expect(core.warning).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
