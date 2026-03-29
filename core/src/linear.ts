import type { LinearTicket } from "./types.js";

export class LinearClient {
  private apiKey: string;
  private endpoint = "https://api.linear.app/graphql";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async query(graphql: string, variables: Record<string, unknown> = {}, retries = 3): Promise<unknown> {
    const body = JSON.stringify({ query: graphql, variables });
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: this.apiKey,
          },
          body,
        });

        // Retry on 5xx or 429 (rate limit)
        if (res.status >= 500 || res.status === 429) {
          lastError = new Error(`Linear API error: ${res.status} ${res.statusText}`);
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) throw new Error(`Linear API error: ${res.status} ${res.statusText}`);
        const json = (await res.json()) as { data?: unknown; errors?: { message: string; extensions?: unknown }[] };
        if (json.errors) {
          const details = JSON.stringify(json.errors);
          throw new Error(`Linear GraphQL error: ${details}`);
        }
        return json.data;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Don't retry on GraphQL errors (client-side issues like bad input)
        if (lastError.message.includes("GraphQL error")) throw lastError;
        if (attempt < retries - 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError || new Error("Linear API request failed after retries");
  }

  async getMyId(): Promise<string> {
    const data = (await this.query(`{ viewer { id } }`)) as { viewer: { id: string } };
    return data.viewer.id;
  }

  async getTeams(): Promise<{ id: string; name: string; key: string }[]> {
    const data = (await this.query(`{ teams { nodes { id name key } } }`)) as {
      teams: { nodes: { id: string; name: string; key: string }[] };
    };
    return data.teams.nodes;
  }

  async getAssignedTickets(assigneeId: string): Promise<LinearTicket[]> {
    const data = (await this.query(
      `query($assigneeId: ID!) {
        issues(filter: { assignee: { id: { eq: $assigneeId } }, state: { type: { in: ["unstarted", "backlog"] } } }, first: 50) {
          nodes {
            id
            identifier
            title
            description
            priority
            url
            state { id name type }
            labels { nodes { id name } }
          }
        }
      }`,
      { assigneeId }
    )) as { issues: { nodes: LinearTicket[] } };
    return data.issues.nodes.map((t) => ({
      ...t,
      labels: (t.labels as unknown as { nodes: { id: string; name: string }[] }).nodes,
    }));
  }

  async getWorkflowStates(teamId: string): Promise<{ id: string; name: string; type: string }[]> {
    // teamId might be a key like "SCL" instead of a UUID — resolve it first
    const resolvedId = await this.resolveTeamId(teamId);
    const data = (await this.query(
      `query($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) {
          nodes { id name type }
        }
      }`,
      { teamId: resolvedId }
    )) as { workflowStates: { nodes: { id: string; name: string; type: string }[] } };
    return data.workflowStates.nodes;
  }

  private async resolveTeamId(teamIdOrKey: string): Promise<string> {
    // If it's already a UUID, return as-is
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamIdOrKey)) {
      return teamIdOrKey;
    }
    // Otherwise treat it as a team key and look up the UUID
    const teams = await this.getTeams();
    const team = teams.find((t) => t.key === teamIdOrKey);
    if (!team) throw new Error(`Linear team with key "${teamIdOrKey}" not found`);
    return team.id;
  }

  async moveTicket(issueId: string, stateId: string): Promise<void> {
    await this.query(
      `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }`,
      { id: issueId, input: { stateId } }
    );
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.query(
      `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
        }
      }`,
      { input: { issueId, body } }
    );
  }

  async createIssue(input: {
    teamId: string;
    title: string;
    description?: string;
    priority?: number;
    labelIds?: string[];
    assigneeId?: string;
  }): Promise<{ id: string; identifier: string; url: string }> {
    const data = (await this.query(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      { input }
    )) as { issueCreate: { issue: { id: string; identifier: string; url: string } } };
    return data.issueCreate.issue;
  }

  async getLabels(teamId: string): Promise<{ id: string; name: string }[]> {
    const resolvedId = await this.resolveTeamId(teamId);
    const data = (await this.query(
      `query($teamId: ID!) {
        issueLabels(filter: { team: { id: { eq: $teamId } } }) {
          nodes { id name }
        }
      }`,
      { teamId: resolvedId }
    )) as { issueLabels: { nodes: { id: string; name: string }[] } };
    return data.issueLabels.nodes;
  }

  async createLabel(teamId: string, name: string, color?: string): Promise<{ id: string; name: string }> {
    const resolvedId = await this.resolveTeamId(teamId);
    const data = (await this.query(
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }`,
      { input: { teamId: resolvedId, name, color: color || "#6B7280" } }
    )) as { issueLabelCreate: { issueLabel: { id: string; name: string } } };
    return data.issueLabelCreate.issueLabel;
  }

  /**
   * Get tickets completed in the last N hours for an assignee.
   */
  async getCompletedTickets(assigneeId: string, sinceHours = 24): Promise<LinearTicket[]> {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
    const data = (await this.query(
      `query($assigneeId: ID!, $since: DateTime!) {
        issues(filter: {
          assignee: { id: { eq: $assigneeId } },
          completedAt: { gte: $since }
        }, first: 50) {
          nodes {
            id identifier title description priority url
            state { id name type }
            labels { nodes { id name } }
          }
        }
      }`,
      { assigneeId, since }
    )) as { issues: { nodes: LinearTicket[] } };
    return data.issues.nodes.map((t) => ({
      ...t,
      labels: (t.labels as unknown as { nodes: { id: string; name: string }[] }).nodes,
    }));
  }

  /**
   * Get tickets currently in progress for an assignee.
   */
  async getInProgressTickets(assigneeId: string): Promise<LinearTicket[]> {
    const data = (await this.query(
      `query($assigneeId: ID!) {
        issues(filter: {
          assignee: { id: { eq: $assigneeId } },
          state: { type: { in: ["started"] } }
        }, first: 50) {
          nodes {
            id identifier title description priority url
            state { id name type }
            labels { nodes { id name } }
          }
        }
      }`,
      { assigneeId }
    )) as { issues: { nodes: LinearTicket[] } };
    return data.issues.nodes.map((t) => ({
      ...t,
      labels: (t.labels as unknown as { nodes: { id: string; name: string }[] }).nodes,
    }));
  }

  async addIssueRelation(issueId: string, relatedIssueId: string, type: string = "blocks"): Promise<void> {
    await this.query(
      `mutation($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) {
          success
        }
      }`,
      { input: { issueId, relatedIssueId, type } }
    );
  }
}
