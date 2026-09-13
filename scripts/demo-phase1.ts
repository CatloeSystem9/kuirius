/**
 * Phase 1 completion-test demo (no side effects — plans are printed, not executed).
 * Usage: npx tsx scripts/demo-phase1.ts
 */
import { HeuristicPlanner, extractGoal, isMultiStepRequest } from '../src/agent/planner';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { createBrowserTools } from '../src/agent/browserTools';

const registry = new ToolRegistry();
registry.registerAll(createBrowserTools());

const planner = new HeuristicPlanner();
const examples = [
  'Open YouTube then search lofi beats on youtube and tell me the result',
  'Open calculator; check my location; tell me the result',
  'open resume.pdf then scan downloads folder',
];

console.log('Registered tools:', registry.names().join(', '));
console.log('');

for (const text of examples) {
  console.log(`INPUT : "${text}"`);
  console.log(`multi-step request? ${isMultiStepRequest(text)}`);
  const plan = planner.makePlan(extractGoal(text));
  console.log(`GOAL  : ${plan.goal.description}`);
  for (const [i, step] of plan.steps.entries()) {
    console.log(`  step ${i + 1}: [${step.toolName}] ${step.description}`);
  }
  console.log('');
}
