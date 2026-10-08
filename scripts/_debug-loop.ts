import { MemoryStorage } from '../src/agent/taskState';
import { ContextEngine } from '../src/agent/context/index';
const e = new ContextEngine({ memory: undefined, cacheStorage: new MemoryStorage() });
e.cacheKnowledge('krisha release notes', { summary: 'v1 shipped local-first' }, { ttlMs: 60_000 });
const hit = e.lookupKnowledge('krisha release notes');
console.log('hit:', JSON.stringify(hit));
const hit2 = e.lookupKnowledge('krisha release notes', { allowStale: true });
console.log('hit2:', JSON.stringify(hit2));
console.log('stats:', JSON.stringify(e.stats()));
