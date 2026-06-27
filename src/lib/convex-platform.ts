/**
 * Convex Platform API Client
 *
 * This client interacts with the Convex Management API to programmatically
 * create and manage Convex projects and deployments for user web projects.
 *
 * API Documentation: https://docs.convex.dev/production/integrations/platform-api
 */

const CONVEX_API_BASE = 'https://api.convex.dev/v1';

export class ConvexPlatformClient {
  private teamId: string;
  private teamToken: string;

  constructor() {
    const teamId = process.env.CONVEX_TEAM_ID;
    const teamToken = process.env.CONVEX_TEAM_TOKEN;

    if (!teamId || !teamToken) {
      throw new Error('CONVEX_TEAM_ID and CONVEX_TEAM_TOKEN must be set');
    }

    this.teamId = teamId;
    this.teamToken = teamToken;
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.teamToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Create a new Convex project with a production deployment
   * @param projectName - Name for the new project (will be slugified)
   * @returns Project and deployment details including the deployment URL
   */
  async createProject(projectName: string): Promise<{
    projectId: number;
    deploymentName: string;
    deploymentUrl: string;
  }> {
    // Create project with prod deployment
    const url = `${CONVEX_API_BASE}/teams/${this.teamId}/create_project`;
    console.log(`[Convex API] POST ${url}`);
    console.log(`[Convex API] Team ID: ${this.teamId}`);
    console.log(`[Convex API] Project Name: ${projectName}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        projectName,
        deploymentType: 'prod',
      }),
    });

    console.log(`[Convex API] Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      // errorText is needed by callers to detect ProjectQuotaReached, but don't
      // log the raw upstream body separately.
      throw new Error(`Failed to create Convex project: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    // Do NOT log the response body — create_project can include a deploy/admin key.

    // The deployment URL is constructed from the deployment name
    // Response structure may vary - handle both possible formats
    const deployment = result.prodDeployment || result.deployment || result;
    const project = result.project || result;

    const deploymentName = deployment.name || deployment.deploymentName;
    const deploymentUrl = `https://${deploymentName}.convex.cloud`;

    const projectId = project.id || project.projectId;

    return {
      projectId,
      deploymentName,
      deploymentUrl,
    };
  }

  /**
   * Create a deploy key for a deployment
   * @param deploymentName - The deployment name (e.g., "happy-otter-123")
   * @returns The deploy key (access token)
   */
  async createDeployKey(deploymentName: string): Promise<string> {
    const url = `${CONVEX_API_BASE}/deployments/${deploymentName}/create_deploy_key`;
    console.log(`[Convex API] POST ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        name: `ide-deploy-key-${Date.now()}`,
      }),
    });

    console.log(`[Convex API] Deploy key response status: ${response.status}`);

    if (!response.ok) {
      await response.text().catch(() => '');
      throw new Error(`Failed to create deploy key (status ${response.status}).`);
    }

    const result = await response.json();
    // Do NOT log the response body — it contains the deploy key.

    // The response contains a key like "prod:deployment-name|token"
    return result.key || result.deployKey || result.accessToken || '';
  }

  /**
   * Set (add or update) environment variables on a deployment.
   * Used to provision Convex Auth secrets without exposing them to the sandbox.
   *
   * For platform-managed deployments: omit accessToken — uses the team token.
   * For BYOC deployments: pass the user's OAuth access token.
   */
  async setDeploymentEnvVars(
    deploymentName: string,
    vars: Record<string, string>,
    accessToken?: string,
  ): Promise<void> {
    const url = `${CONVEX_API_BASE}/deployments/${deploymentName}/environment_variables`;
    const changes = Object.entries(vars).map(([name, value]) => ({ name, value }));
    const token = accessToken ?? this.teamToken;

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ changes }),
    });

    if (!response.ok) {
      // Don't include the upstream body — the request payload carries secret env
      // values (JWT_PRIVATE_KEY, AUTH_*_SECRET) a Convex error could echo back.
      await response.text().catch(() => '');
      throw new Error(`Failed to set deployment env vars (status ${response.status}).`);
    }
  }

  /**
   * Delete a Convex project and all its deployments
   * @param projectId - The Convex project ID
   */
  async deleteProject(projectId: number): Promise<void> {
    const response = await fetch(
      `${CONVEX_API_BASE}/projects/${projectId}/delete`,
      {
        method: 'POST',
        headers: this.headers,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to delete Convex project: ${response.status} ${errorText}`);
    }
  }
}

// Lazy-initialized singleton instance
let _client: ConvexPlatformClient | null = null;

export function getConvexPlatformClient(): ConvexPlatformClient {
  if (!_client) {
    _client = new ConvexPlatformClient();
  }
  return _client;
}

/**
 * Provision a new Convex backend for a project
 * This is the main entry point for creating Convex infrastructure
 */
export async function provisionConvexBackend(projectName: string): Promise<{
  projectId: string;
  deploymentId: string;
  deployUrl: string;
  deployKey: string;
}> {
  const client = getConvexPlatformClient();

  // Create the project and get deployment info
  const { projectId, deploymentName, deploymentUrl } = await client.createProject(projectName);

  // Create a deploy key for the deployment
  const deployKey = await client.createDeployKey(deploymentName);

  return {
    projectId: String(projectId),
    deploymentId: deploymentName,
    deployUrl: deploymentUrl,
    deployKey,
  };
}

/**
 * Delete a Convex backend when a project is deleted
 */
export async function deleteConvexBackend(projectId: string): Promise<void> {
  const client = getConvexPlatformClient();
  await client.deleteProject(Number(projectId));
}
