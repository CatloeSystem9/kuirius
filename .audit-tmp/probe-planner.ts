import { HeuristicPlanner, isMultiStepRequest, extractGoal } from '../src/agent/planner';

const candidates = [
  'list the files in C:/wftmp and then read the file C:/wftmp/report.txt',
  'List the files in C:/wftmp, then read the file C:/wftmp/report.txt and finally write a note about it',
  'Open notepad, then read my screen',
  'Create a file at C:/wftmp/x.txt and then delete it',
];

const planner = new HeuristicPlanner();
for (const c of candidates) {
  const multi = isMultiStepRequest(c);
  const goal = extractGoal(c);
  const plan = planner.makePlan(goal);
  console.log(JSON.stringify({ input: c, multi, steps: plan.steps.map((s) => ({ tool: s.toolName, cap: s.capability, input: s.input, desc: s.description })) }, null, 1));
}
