export interface ProjectConfig {
  linearApiKey: string;
  anthropicApiKey?: string;
  projectFolder: string;
  repos?: string[];
  linearTeamId?: string;
  assigneeId?: string;
  baseBranch?: string; // defaults to "staging"
}

export interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: {
    id: string;
    name: string;
    type: string;
  };
  priority: number;
  labels: { id: string; name: string }[];
  url: string;
}

export interface TicketStatus {
  ticketId: string;
  phase: ProcessingPhase;
  progress: string;
  error?: string;
  testCases?: TestCase[];
}

export type ProcessingPhase =
  | "queued"
  | "pulling"
  | "branching"
  | "developing"
  | "building"
  | "testing"
  | "qa_verifying"
  | "creating_pr"
  | "merging"
  | "generating_tests"
  | "done"
  | "error";

export interface TestCase {
  id: string;
  title: string;
  steps: string[];
  route?: string;
  passed: boolean;
  errorNote?: string;
}

export interface QAResult {
  buildPassed: boolean;
  buildOutput?: string;
  testsPassed: boolean;
  testOutput?: string;
  lintPassed: boolean;
  lintOutput?: string;
  selfReviewPassed: boolean;
  selfReviewNotes?: string;
  attempt: number;
  maxAttempts: number;
}

export interface PRInfo {
  url: string;
  number: number;
  title: string;
  branch: string;
  repo: string;
}