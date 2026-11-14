import { isMultiStepRequest, isScreenIntent, isMouseIntent, isKeyboardIntent, isSystemIntent, isResearchIntent } from '../src/agent/planner';

const t = 'browser open https://example.com and then open https://example.org';
console.log(JSON.stringify({ multi: isMultiStepRequest(t), screen: isScreenIntent(t), mouse: isMouseIntent(t), kbd: isKeyboardIntent(t), sys: isSystemIntent(t), research: isResearchIntent(t) }));
