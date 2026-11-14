import { HeuristicPlanner, extractGoal } from '../src/agent/planner';

const planner = new HeuristicPlanner();
const tmp = 'C:/Users/Expert/AppData/Local/Temp/krisha-stop-test/deleteme.txt';
for (const c of ['delete the file ' + tmp, 'remove the file ' + tmp]) {
  const p = planner.makePlan(extractGoal(c));
  console.log(c, '->', JSON.stringify(p.steps.map((s) => s.toolName + ' ' + JSON.stringify(s.input))));
}
