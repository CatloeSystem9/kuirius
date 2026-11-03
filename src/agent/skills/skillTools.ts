/**
 * Learned Skills v1 — tools.
 *
 * Discovery + management tools over the skill engine. All of them are local,
 * deterministic and cheap. skill.list/search/stats are read-only (safe);
 * skill.disable/skill.forget mutate LEARNED DATA only (never permissions,
 * settings or source) and are gated by 'memory.access' plus the Phase 18
 * SafetyGate like every other tool.
 *
 * There is deliberately NO tool that creates skills from user text — skills
 * come only from verified task executions via the engine's event pipeline.
 */
import type { AgentTool } from '../types';
import { fail, ok } from '../types';
import type { SkillEngine } from './skillEngine';
import { SKILL_MIN_RELIABILITY } from './skillTypes';

export interface SkillToolsDeps {
  skills: SkillEngine;
}

export function createSkillTools(deps: SkillToolsDeps): AgentTool[] {
  const { skills } = deps;

  const skillList: AgentTool = {
    name: 'skill.list',
    description: 'List learned skills with reliability, version and status (read-only)',
    category: 'memory',
    riskLevel: 'safe',
    capabilities: ['skill.list'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Read-only listing of bounded learned-skill state' },
    inputSchema: { required: [], optional: [], description: 'No inputs' },
    async execute() {
      const list = skills.list().map((s) => ({
        id: s.id,
        name: s.name,
        version: s.version,
        reliability: s.reliability,
        status: s.status,
        steps: s.steps.length,
        sensitive: s.sensitive,
        reusable: s.reliability >= SKILL_MIN_RELIABILITY && s.status === 'active',
        updatedAt: s.updatedAt,
      }));
      return ok({ output: { skills: list, count: list.length } });
    },
  };

  const skillSearch: AgentTool = {
    name: 'skill.search',
    description: 'Search learned skills relevant to a task goal, with transparent scores and blockers (read-only)',
    category: 'memory',
    riskLevel: 'safe',
    capabilities: ['skill.search'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Deterministic local match over the bounded skill store' },
    inputSchema: {
      required: ['query'],
      optional: [],
      types: { query: 'string' },
      description: 'The task goal to match against learned skills',
    },
    async execute(input) {
      const query = String(input.query ?? '').trim();
      if (!query) {
        return fail('query is required', { errorKind: 'invalid_input' });
      }
      const matches = skills.match(query).map((m) => ({
        skillId: m.skill.id,
        name: m.skill.name,
        version: m.skill.version,
        score: m.score,
        goalSimilarity: m.goalSimilarity,
        semanticOverlap: m.semanticOverlap,
        reliability: m.skill.reliability,
        environmentCoverage: m.environmentCoverage,
        preconditionsMet: m.preconditionsMet,
        reusableNow: m.blockers.length === 0 && m.score >= 0.6,
        reasons: m.reasons,
        blockers: m.blockers,
      }));
      return ok({ output: { matches, count: matches.length } });
    },
  };

  const skillStats: AgentTool = {
    name: 'skill.stats',
    description: 'Learned-skills subsystem statistics (read-only)',
    category: 'memory',
    riskLevel: 'safe',
    capabilities: ['skill.stats'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Bounded counters over the skill store' },
    inputSchema: { required: [], optional: [], description: 'No inputs' },
    async execute() {
      return ok({ output: { ...skills.stats(), stale: skills.auditStale() } });
    },
  };

  const skillDisable: AgentTool = {
    name: 'skill.disable',
    description: 'Disable a learned skill so it is never auto-reused (reversible; learned data only)',
    category: 'memory',
    riskLevel: 'low',
    capabilities: ['skill.disable'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Status flag change in the bounded skill store' },
    inputSchema: { required: ['id'], optional: [], types: { id: 'string' }, description: 'The skill id to disable' },
    async execute(input) {
      const id = String(input.id ?? '').trim();
      if (!id) return fail('id is required', { errorKind: 'invalid_input' });
      const done = skills.disable(id);
      return done
        ? ok({ output: { disabled: true, skillId: id } })
        : fail(`no skill with id "${id}"`, { errorKind: 'not_found', retryable: false });
    },
  };

  const skillForget: AgentTool = {
    name: 'skill.forget',
    description: 'Delete a learned skill permanently (learned data only)',
    category: 'memory',
    riskLevel: 'low',
    capabilities: ['skill.forget'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Removal from the bounded skill store' },
    inputSchema: { required: ['id'], optional: [], types: { id: 'string' }, description: 'The skill id to forget' },
    async execute(input) {
      const id = String(input.id ?? '').trim();
      if (!id) return fail('id is required', { errorKind: 'invalid_input' });
      const done = skills.forget(id);
      return done
        ? ok({ output: { forgotten: true, skillId: id } })
        : fail(`no skill with id "${id}"`, { errorKind: 'not_found', retryable: false });
    },
  };

  return [skillList, skillSearch, skillStats, skillDisable, skillForget];
}
