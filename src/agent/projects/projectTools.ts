/**
 * Project Awareness v1 — tools.
 *
 * The whole tool surface of project awareness. All tools are local and
 * read-only on disk except `project.status` (updates the bounded dev-progress
 * record) and `project.forget` (removes learned project knowledge AND the
 * approval). Every tool passes through the ToolRegistry → Phase 18
 * SafetyGate like every other capability, and unapproved roots are refused —
 * never silently accessed.
 */
import { fail, ok } from '../types';
import type { AgentTool } from '../types';
import type { ProjectEngine } from './projectEngine';
import { isStale } from './projectTypes';

export interface ProjectToolsDeps {
  projects: ProjectEngine;
}

function profileSummary(p: NonNullable<ReturnType<ProjectEngine['profile']>>) {
  return {
    root: p.root,
    name: p.name,
    kind: p.kind,
    languages: p.languages,
    frameworks: p.frameworks,
    entryPoints: p.entryPoints,
    modules: p.modules.length,
    filesSeen: p.stats.filesSeen,
    secretsExcluded: p.stats.secretsExcluded,
    goal: p.dev.goal,
    blockers: p.dev.blockers?.length ?? 0,
    stale: isStale(p),
    lastIndexedAt: p.lastIndexedAt,
  };
}

export function createProjectTools(deps: ProjectToolsDeps): AgentTool[] {
  const { projects } = deps;

  const approveRoot: AgentTool = {
    name: 'project.approve_root',
    description: 'Approve a directory as a project root for read-only awareness indexing (explicit user consent; the directory must exist)',
    category: 'filesystem',
    riskLevel: 'low',
    capabilities: ['project.approve_root'],
    permissions: ['filesystem.read'],
    verification: { strategy: 'state_check', description: 'Approval recorded only after the directory is verified listable' },
    inputSchema: { required: ['path'], optional: [], types: { path: 'string' }, description: 'Absolute directory path of the project root' },
    async execute(input) {
      const path = String(input.path ?? '').trim();
      if (!path) return fail('path is required', { errorKind: 'invalid_input' });
      const result = await projects.approveRoot(path);
      return result.ok
        ? ok({ output: { approved: true, root: result.root, note: result.reason } })
        : fail(result.reason ?? 'approval failed', { errorKind: 'invalid_input' });
    },
  };

  const projectList: AgentTool = {
    name: 'project.list',
    description: 'List approved project roots and indexed project profiles with staleness (read-only)',
    category: 'filesystem',
    riskLevel: 'safe',
    capabilities: ['project.list'],
    permissions: ['filesystem.read'],
    verification: { strategy: 'self_reported', description: 'Bounded read of the persisted project store' },
    inputSchema: { required: [], optional: [], description: 'No inputs' },
    async execute() {
      return ok({
        output: {
          approvedRoots: projects.listApproved(),
          projects: projects.listProfiles().map(profileSummary),
          stats: projects.stats(),
        },
      });
    },
  };

  const projectInspect: AgentTool = {
    name: 'project.inspect',
    description: 'Read-only scan of an APPROVED project root: identity, languages, frameworks, dependencies, entry points, modules, structure (incremental; no file contents stored)',
    category: 'filesystem',
    riskLevel: 'low',
    capabilities: ['project.inspect'],
    permissions: ['filesystem.read'],
    verification: { strategy: 'state_check', description: 'Profile built from actual directory listings and bounded manifest reads' },
    inputSchema: { required: ['root'], optional: [], types: { root: 'string' }, description: 'Approved project root directory' },
    async execute(input) {
      const root = String(input.root ?? '').trim();
      if (!root) return fail('root is required', { errorKind: 'invalid_input' });
      const outcome = await projects.index(root);
      if (!outcome.ok || !outcome.profile) return fail(outcome.reason ?? 'indexing failed', { errorKind: 'invalid_input', retryable: false });
      return ok({ output: { profile: profileSummary(outcome.profile), stats: outcome.profile.stats } });
    },
  };

  const projectChanges: AgentTool = {
    name: 'project.changes',
    description: 'Detect what changed in an approved project since the last index (changed directories, added/removed/modified tracked files; read-only)',
    category: 'filesystem',
    riskLevel: 'safe',
    capabilities: ['project.changes'],
    permissions: ['filesystem.read'],
    verification: { strategy: 'state_check', description: 'Diff computed from fresh directory signatures vs the stored profile' },
    inputSchema: { required: ['root'], optional: [], types: { root: 'string' }, description: 'Approved project root directory' },
    async execute(input) {
      const root = String(input.root ?? '').trim();
      if (!root) return fail('root is required', { errorKind: 'invalid_input' });
      const result = await projects.changes(root);
      if (!result.ok || !result.change) return fail(result.reason ?? 'change detection failed', { errorKind: 'invalid_input', retryable: false });
      return ok({ output: { change: result.change } });
    },
  };

  const projectStatus: AgentTool = {
    name: 'project.status',
    description: 'Get or update a project development-progress record (goal, progress, blockers, completed work) — durable across conversations',
    category: 'filesystem',
    riskLevel: 'low',
    capabilities: ['project.status'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Bounded dev-status record in the project profile' },
    inputSchema: {
      required: ['root'],
      optional: ['goal', 'progress', 'blockers', 'completed'],
      types: { root: 'string', goal: 'string', progress: 'string', blockers: 'array', completed: 'array' },
      description: 'root: approved project root. Provide goal/progress/blockers/completed to update; omit them to read.',
    },
    async execute(input) {
      const root = String(input.root ?? '').trim();
      if (!root) return fail('root is required', { errorKind: 'invalid_input' });
      const patch: Record<string, unknown> = {};
      if (typeof input.goal === 'string') patch.goal = input.goal;
      if (typeof input.progress === 'string') patch.progress = input.progress;
      if (Array.isArray(input.blockers)) patch.blockers = input.blockers;
      if (Array.isArray(input.completed)) patch.completed = input.completed;
      const hasPatch = Object.keys(patch).length > 0;
      const result = await projects.status(root, hasPatch ? (patch as { goal?: string; progress?: string; blockers?: string[]; completed?: string[] }) : undefined);
      if (!result.ok) return fail(result.reason ?? 'status failed', { errorKind: 'invalid_input', retryable: false });
      return ok({ output: { name: result.name, dev: result.dev, updated: hasPatch } });
    },
  };

  const projectForget: AgentTool = {
    name: 'project.forget',
    description: 'Remove a project from awareness: deletes its profile and revokes the root approval',
    category: 'memory',
    riskLevel: 'low',
    capabilities: ['project.forget'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Removal from the bounded project store' },
    inputSchema: { required: ['root'], optional: [], types: { root: 'string' }, description: 'Approved project root to forget' },
    async execute(input) {
      const root = String(input.root ?? '').trim();
      if (!root) return fail('root is required', { errorKind: 'invalid_input' });
      const removed = projects.forget(root);
      return removed
        ? ok({ output: { forgotten: true, root } })
        : fail(`no indexed project for root "${root}"`, { errorKind: 'not_found', retryable: false });
    },
  };

  return [approveRoot, projectList, projectInspect, projectChanges, projectStatus, projectForget];
}
