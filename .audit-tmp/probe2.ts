import { HeuristicPlanner, extractGoal } from '../src/agent/planner';

const planner = new HeuristicPlanner();
for (const c of ['browser open https://example.test/', 'open https://example.test/ in the browser', 'research krisha safety gates']) {
  const p = planner.makePlan(extractGoal(c));
  console.log(c, '->', JSON.stringify(p.steps.map((s) => s.toolName + ':' + s.capability)));
}
