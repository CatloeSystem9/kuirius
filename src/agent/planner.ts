/**
 * Planner (Phase 1) — basic planning.
 *
 * Decomposes multi-step requests into an ordered plan by reusing the existing
 * pure intent detectors (webActions / appLauncher / fileSystemAccess / location).
 * Every clause that cannot be classified becomes an honest `system.note` step
 * rather than being silently dropped. LLM-assisted planning arrives later; this
 * heuristic planner is deterministic and fully testable.
 */
import type { AgentGoal, AgentPlan, PlanStep } from './types';
import { detectAndParseWebAction } from '../utils/webActions';
import { detectAndParseAppLaunchCommand } from '../utils/appLauncher';
import { parseFileCommand } from '../utils/fileSystemAccess';
import { isLocationIntent } from '../utils/locationService';
import { isKnownKey, isKnownModifier } from './computer/keyboardTypes';

export const REPORT_CLAUSE_RE =
  /\b(?:tell\s+me|report|summarize|let\s+me\s+know|what\s+(?:is|was)\s+the\s+result|the\s+result)\b/i;

export const SEQUENCE_RE =
  /,?\s*\b(?:and\s+then|then|after\s+that|afterwards|after\s+which)\b\s*|\s*;\s*|\n+\s*|\s+and\s+(?=(?:tell\s+me|report|summarize|show|open|launch|start|run|search|find|check|scan|type|play|watch|go|visit|create|write|list|locate)\b)/i;

const IMPERATIVE_VERBS_RE =
  /^(?:open|launch|start|run|go|visit|search|find|look|scan|check|inspect|type|write|create|play|watch|listen|download|compare|organize|close|set|turn|show|get|make|fix|read|open\s+up|browse|tell|report|summarize|list|locate|remember|note|click|double|scroll|drag|move|press|copy|paste|select|hotkey|delete|rename|focus)\b/i;

const MAX_PLAN_STEPS = 10;

/** Capabilities the Phase 7 computer-use orchestrator can execute. */
export const COMPUTER_USE_CAPABILITIES = new Set([
  'computer.click', 'computer.double_click', 'computer.right_click', 'computer.move_cursor',
  'computer.scroll', 'computer.drag', 'keyboard.type', 'keyboard.press_key', 'keyboard.hotkey',
  'keyboard.key_down', 'keyboard.key_up', 'keyboard.copy', 'keyboard.paste', 'keyboard.select_all',
]);

/** Capabilities the Phase 8 browser agent can execute (incl. Phase 1 web open/search). */
export const BROWSER_USE_CAPABILITIES = new Set([
  'browser.find', 'browser.click', 'browser.type', 'browser.scroll_until', 'browser.scroll',
  'browser.wait', 'browser.verify', 'browser.back', 'browser.refresh',
  'browser.open_url', 'browser.search',
]);

const BROWSER_INTERACTION_CAPABILITIES = new Set([
  'browser.find', 'browser.click', 'browser.type', 'browser.scroll_until', 'browser.scroll', 'browser.wait', 'browser.verify',
]);

/**
 * Browser on-page interaction phrases (Phase 8). Requires an explicit
 * page/tab/browser context word so ordinary chat is never hijacked.
 */
export function classifyBrowserPhrase(clause: string): StepClassification | null {
  const text = clause.trim();
  // "scroll until X" is unambiguous on its own; everything else needs an
  // explicit page/tab/browser context word.
  if (!/\b(page|tab|browser)\b/i.test(text) && !/^scroll\s+until\b/i.test(text)) return null;

  let m: RegExpMatchArray | null;

  if ((m = text.match(/^find\s+(.+?)\s+on\s+(?:this\s+|the\s+)?page$/i))) {
    return { toolName: 'browser.find', capability: 'browser.find', description: `Find "${m[1].trim()}" on the page`, input: { query: m[1].trim() } };
  }
  if ((m = text.match(/^scroll\s+until\s+(.+?)(?:\s+(?:is|are)?\s*visible)?$/i))) {
    return { toolName: 'browser.scroll_until', capability: 'browser.scroll_until', description: `Scroll until "${m[1].trim()}" is visible`, input: { query: m[1].trim() } };
  }
  if ((m = text.match(/^scroll\s+(up|down)(?:\s+(?:by\s+)?(\d+))?(?:\s+on\s+(?:this\s+|the\s+)?page)?$/i))) {
    return {
      toolName: 'browser.scroll',
      capability: 'browser.scroll',
      description: `Scroll ${m[1].toLowerCase()} on the page`,
      input: { direction: m[1].toLowerCase(), amount: m[2] ? parseInt(m[2], 10) : undefined },
    };
  }
  if ((m = text.match(/^click\s+(?:the\s+)?(.+?)\s+(?:link|button|element)?\s*on\s+(?:this\s+|the\s+)?page$/i))) {
    return { toolName: 'browser.click', capability: 'browser.click', description: `Click "${m[1].trim()}" on the page`, input: { target: m[1].trim() } };
  }
  if ((m = text.match(/^type\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+into\s+(?:the\s+)?(.+?)\s+on\s+(?:this\s+|the\s+)?page$/i))) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    return { toolName: 'browser.type', capability: 'browser.type', description: `Type into "${m[4].trim()}" on the page`, input: { text: value, field: m[4].trim() } };
  }
  if ((m = text.match(/^wait\s+(?:for|until)\s+(?:the\s+)?(?:page\s+)?(?:shows|contains|loads)\s+(.+)$/i))) {
    return { toolName: 'browser.wait', capability: 'browser.wait', description: `Wait for the page to show "${m[1].trim()}"`, input: { textContains: m[1].trim() } };
  }
  if (/^go\s+back(\s+on\s+(?:this\s+|the\s+)?page)?$/i.test(text)) {
    return { toolName: 'browser.back', capability: 'browser.back', description: 'Navigate back', input: {} };
  }
  if (/^refresh(\s+(?:this\s+|the\s+)?page)?$/i.test(text)) {
    return { toolName: 'browser.refresh', capability: 'browser.refresh', description: 'Refresh the page', input: {} };
  }
  if ((m = text.match(/^verify\s+(?:the\s+)?(?:page\s+)?(?:shows|contains)\s+(.+)$/i))) {
    return { toolName: 'browser.wait', capability: 'browser.verify', description: `Verify the page shows "${m[1].trim()}"`, input: { textContains: m[1].trim() } };
  }
  return null;
}

/** True when the goal is a compound browser task (≥2 browser clauses, ≥1 interactive). */
export function isBrowserUseRequest(text: string): boolean {
  const clauses = splitIntoClauses(text);
  if (clauses.length < 2) return false;
  let browser = 0;
  let interactive = 0;
  for (const clause of clauses) {
    const cls = classifyStep(clause);
    if (!cls) continue;
    if (cls.capability && BROWSER_USE_CAPABILITIES.has(cls.capability)) {
      browser++;
      if (BROWSER_INTERACTION_CAPABILITIES.has(cls.capability)) interactive++;
    } else if (cls.toolName !== 'chat.report') {
      return false;
    }
  }
  return browser >= 2 && interactive >= 1;
}

/** Capabilities the Phase 9 filesystem/application layer can execute. */
export const SYSTEM_USE_CAPABILITIES = new Set([
  'filesystem.list', 'filesystem.search', 'filesystem.inspect', 'filesystem.read', 'filesystem.create',
  'filesystem.rename', 'filesystem.copy', 'filesystem.move', 'filesystem.delete', 'filesystem.open_file',
  'filesystem.find_open', 'application.find', 'application.launch', 'application.status',
  'application.close', 'application.focus',
]);

/**
 * Filesystem/application intent phrases (Phase 9). Explicit verbs only —
 * ordinary chat is never hijacked. 'open X' app launching stays on the
 * Phase 1 app-intent detector.
 */
export function classifySystemIntent(clause: string): StepClassification | null {
  const text = clause.trim();
  if (!text) return null;

  let m: RegExpMatchArray | null;

  // Compound: find X and open it (direct FS APIs — not computer.use).
  if ((m = text.match(/^find\s+(?:the\s+)?(.+?)\s+and\s+open\s+it$/i))) {
    return {
      toolName: 'filesystem.find_open',
      capability: 'filesystem.find_open',
      description: `Find "${m[1].trim()}" on disk and open it`,
      input: { root: '', query: m[1].trim() },
    };
  }

  if ((m = text.match(/^(?:create|make)\s+(?:a\s+|an\s+|the\s+)?(file|folder|directory)(?:\s+(?:named|called)\s*"?([^"]+?)"?)?(?:\s+in\s+(?:the\s+|my\s+)?(.+))?$/i))) {
    const kindWord = m[1].toLowerCase();
    const type = kindWord === 'file' ? 'file' : 'dir';
    const name = (m[2] ?? (type === 'file' ? 'new-file.txt' : 'new-folder')).trim();
    const location = (m[3] ?? '').trim().replace(/[\\/]+$/, '');
    const pathValue = location ? `${location}\\${name}` : name;
    return {
      toolName: 'filesystem.create',
      capability: 'filesystem.create',
      description: `Create ${type === 'file' ? 'file' : 'directory'} "${name}"${location ? ` in ${location}` : ''}`,
      input: { path: pathValue, type },
    };
  }

  if ((m = text.match(/^delete\s+(?:the\s+)?(?:file|folder|directory)?\s*:?\s*(.+)$/i))) {
    const target = m[1].trim();
    if (!/[\\/]/.test(target) && !/\.\w{1,5}$/i.test(target)) return null; // require a path-ish target
    return { toolName: 'filesystem.delete', capability: 'filesystem.delete', description: `Delete "${target}"`, input: { path: target } };
  }

  if ((m = text.match(/^rename\s+(.+?)\s+to\s+(.+)$/i))) {
    return { toolName: 'filesystem.rename', capability: 'filesystem.rename', description: `Rename "${m[1].trim()}" to "${m[2].trim()}"`, input: { path: m[1].trim(), newName: m[2].trim() } };
  }

  if ((m = text.match(/^(copy|move)\s+(.+?)\s+to\s+(.+)$/i)) && !/\b(cursor|mouse)\b/i.test(text)) {
    const kind = m[1].toLowerCase();
    return {
      toolName: kind === 'copy' ? 'filesystem.copy' : 'filesystem.move',
      capability: kind === 'copy' ? 'filesystem.copy' : 'filesystem.move',
      description: `${kind === 'copy' ? 'Copy' : 'Move'} "${m[2].trim()}" to "${m[3].trim()}"`,
      input: { from: m[2].trim(), to: m[3].trim() },
    };
  }

  if ((m = text.match(/^list\s+(?:the\s+)?(?:files\s+(?:in|of)\s+|contents\s+of\s+)?(?:folder\s+|directory\s+)?(.+)$/i))) {
    return { toolName: 'filesystem.list', capability: 'filesystem.list', description: `List "${m[1].trim()}"`, input: { path: m[1].trim() } };
  }

  if ((m = text.match(/^search\s+(?:the\s+)?(?:filesystem|disk|computer)\s+for\s+(.+)$/i))) {
    return { toolName: 'filesystem.search', capability: 'filesystem.search', description: `Search the filesystem for "${m[1].trim()}"`, input: { root: '', query: m[1].trim() } };
  }

  if ((m = text.match(/^read\s+(?:the\s+)?(?:file\s+)?(.+)$/i))) {
    const target = m[1].trim();
    if (!/\.\w{1,5}$/.test(target) && !/[\\/]/.test(target)) return null;
    return { toolName: 'filesystem.read', capability: 'filesystem.read', description: `Read "${target}"`, input: { path: target } };
  }

  if ((m = text.match(/^open\s+(?:the\s+)?(?:file\s+)?(?:at\s+)?((?:[a-zA-Z]:)?[\\/].+)$/i))) {
    return { toolName: 'filesystem.open_file', capability: 'filesystem.open_file', description: `Open "${m[1].trim()}" with its associated application`, input: { path: m[1].trim() } };
  }

  if ((m = text.match(/^is\s+(.+?)\s+running\??$/i))) {
    return { toolName: 'application.status', capability: 'application.status', description: `Check whether "${m[1].trim()}" is running`, input: { name: m[1].trim() } };
  }
  if ((m = text.match(/^close\s+(?:the\s+)?(.+?)(?:\s+app(?:lication)?)?$/i)) && !/\bpage\b|\btab\b/i.test(text)) {
    return { toolName: 'application.close', capability: 'application.close', description: `Close "${m[1].trim()}"`, input: { name: m[1].trim() } };
  }
  if ((m = text.match(/^focus\s+(?:the\s+)?(.+?)(?:\s+(?:app|window))?(?:lication)?$/i)) && /\bapp\b|\bwindow\b|\bnotepad\b|\bchrome\b/i.test(text)) {
    return { toolName: 'application.focus', capability: 'application.focus', description: `Focus "${m[1].trim()}"`, input: { name: m[1].trim() } };
  }
  return null;
}

export function isSystemIntent(text: string): boolean {
  return classifySystemIntent(text) !== null;
}

export interface StepClassification {
  toolName: string;
  /** Capability tag; the registry/selector resolves the concrete tool (Phase 3). */
  capability?: string;
  description: string;
  input: Record<string, unknown>;
}

/** True when the request should be handled by the Agent Core instead of the single-shot chat flow. */
export function isMultiStepRequest(text: string): boolean {
  const clean = text.trim();
  if (clean.length < 8) return false;

  const clauses = splitIntoClauses(clean);
  if (clauses.length < 2) return false;

  // Pure questions about sequences are chat, not tasks ("what did you do then?").
  if (/\?\s*$/.test(clean) && !IMPERATIVE_VERBS_RE.test(clauses[0])) {
    return false;
  }

  return IMPERATIVE_VERBS_RE.test(clauses[0]);
}

export function splitIntoClauses(text: string): string[] {
  return text
    .split(SEQUENCE_RE)
    .map((c) => c.trim().replace(/^[\s,]+|[\s,.:;]+$/g, ''))
    .filter((c) => c.length > 1);
}

export function extractGoal(text: string): AgentGoal {
  const clean = text.trim();
  const description = clean
    .replace(/^(?:hey|hi|hello|ok|okay|krisha)[,\s]+/i, '')
    .replace(/^(?:can\s+you|could\s+you|would\s+you|please)\s+/i, '')
    .trim();
  return {
    description: description || clean,
    rawInput: clean,
    kind: 'command',
  };
}

/**
 * Screen-intent classification (Phase 4). Requires an explicit screen/display
 * word so ordinary chat is never hijacked.
 */
export function classifyScreenIntent(text: string): StepClassification | null {
  const clean = text.trim();
  if (!/\b(screen|display|monitor)\b/i.test(clean)) return null;

  if (/what\s+changed?|did\s+the\s+screen\s+change|any\s+changes?\s+on/i.test(clean)) {
    return {
      toolName: 'screen.detect_changes',
      capability: 'screen.detect_changes',
      description: 'Detect what changed on the screen',
      input: {},
    };
  }
  if (/\bcompare\b/i.test(clean)) {
    return {
      toolName: 'screen.compare',
      capability: 'screen.compare',
      description: 'Compare recent screen observations',
      input: {},
    };
  }
  if (
    /what(?:'s| is| am i)|\bread\b|\bcheck\b|look\s+at|describe|analyze|inspect|observe|wrong|error|dialog|popup|notification|visible|do\s+you\s+see|is\s+there/i.test(clean)
  ) {
    return {
      toolName: 'screen.observe',
      capability: 'screen.observe',
      description: 'Observe and analyze the current screen',
      input: { question: clean },
    };
  }
  return null;
}

export function isScreenIntent(text: string): boolean {
  return classifyScreenIntent(text) !== null;
}

/**
 * Mouse-control intent classification (Phase 5). Conservative: the clause must
 * START with an explicit mouse verb so ordinary chat is never hijacked.
 */
export function classifyMouseIntent(text: string): StepClassification | null {
  const clean = text.trim();
  if (!clean) return null;

  let m: RegExpMatchArray | null;

  if ((m = clean.match(/^double[-\s]?click\s+(?:on\s+|the\s+)?(.+)$/i))) {
    return {
      toolName: 'computer.double_click',
      capability: 'computer.double_click',
      description: `Double-click "${m[1].trim().slice(0, 50)}"`,
      input: { target: { text: m[1].trim() } },
    };
  }
  if ((m = clean.match(/^right[-\s]?click\s+(?:on\s+|the\s+)?(.+)$/i))) {
    return {
      toolName: 'computer.right_click',
      capability: 'computer.right_click',
      description: `Right-click "${m[1].trim().slice(0, 50)}"`,
      input: { target: { text: m[1].trim() } },
    };
  }
  if ((m = clean.match(/^click\s+(?:on\s+|the\s+)?(.+)$/i))) {
    return {
      toolName: 'computer.click',
      capability: 'computer.click',
      description: `Click "${m[1].trim().slice(0, 50)}"`,
      input: { target: { text: m[1].trim() } },
    };
  }
  if ((m = clean.match(/^move\s+(?:the\s+)?(?:mouse|cursor)\s+to\s+(.+)$/i))) {
    const coordMatch = m[1].match(/^(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)$/);
    const input = coordMatch
      ? { coordinates: { x: parseFloat(coordMatch[1]), y: parseFloat(coordMatch[2]) } }
      : { target: { text: m[1].trim() } };
    return {
      toolName: 'computer.move_cursor',
      capability: 'computer.move_cursor',
      description: `Move the cursor to ${m[1].trim().slice(0, 40)}`,
      input,
    };
  }
  if ((m = clean.match(/^scroll\s+(up|down)(?:\s+(?:by\s+)?(\d+))?(?:\s+(?:times|clicks|notches))?/i))) {
    const amount = m[2] ? parseInt(m[2], 10) : undefined;
    return {
      toolName: 'computer.scroll',
      capability: 'computer.scroll',
      description: `Scroll ${m[1].toLowerCase()}${amount ? ` ${amount}` : ''}`,
      input: { direction: m[1].toLowerCase() as 'up' | 'down', amount },
    };
  }
  if ((m = clean.match(/^drag\s+(.+?)\s+to\s+(.+)$/i))) {
    return {
      toolName: 'computer.drag',
      capability: 'computer.drag',
      description: `Drag "${m[1].trim().slice(0, 40)}" to "${m[2].trim().slice(0, 40)}"`,
      input: { from: { text: m[1].trim() }, to: { text: m[2].trim() } },
    };
  }
  return null;
}

export function isMouseIntent(text: string): boolean {
  return classifyMouseIntent(text) !== null;
}

/**
 * Keyboard intent classification (Phase 6). Requires an explicit keyboard
 * verb AND a valid key/combination (or quoted text for typing) so ordinary
 * chat ("copy this file") is never hijacked.
 */
export function classifyKeyboardIntent(text: string): StepClassification | null {
  const clean = text.trim();
  if (!clean) return null;

  let m: RegExpMatchArray | null;

  // Typing: quoted text, or plain text with an optional "into <target>" part.
  if ((m = clean.match(/^type\s+(?:"([^"]{1,500})"|'([^']{1,500})'|(.+))$/i))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw) return null;
    const intoMatch = !m[1] && !m[2] ? raw.match(/^(.+?)\s+into\s+(?:the\s+|my\s+|this\s+|that\s+)?(.+)$/i) : null;
    if (intoMatch) {
      const typeText = intoMatch[1].trim().replace(/^["']|["']$/g, '');
      if (!typeText) return null;
      return {
        toolName: 'computer.click',
        capability: 'computer.click',
        description: `Click the "${intoMatch[2].trim().slice(0, 40)}" field to focus it`,
        input: { target: { text: intoMatch[2].trim() } },
      };
    }
    return {
      toolName: 'computer.type',
      capability: 'keyboard.type',
      description: `Type ${raw.length > 24 ? `${raw.length} characters` : `"${raw}"`}`,
      input: { text: raw },
    };
  }

  if ((m = clean.match(/^press\s+(?:the\s+)?(.+)$/i)) || (m = clean.match(/^hotkey\s+(.+)$/i))) {
    const combo = m[1].trim().toLowerCase().replace(/[.!]+$/, '');
    const parts = combo.split(/\s*\+\s*|\s+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 5) return null;
    const mods = parts.slice(0, -1);
    const key = parts[parts.length - 1];
    if (!isKnownKey(key)) return null;
    for (const mod of mods) {
      if (!isKnownModifier(mod)) return null;
    }
    if (mods.length === 0) {
      return {
        toolName: 'computer.press_key',
        capability: 'keyboard.press_key',
        description: `Press ${key}`,
        input: { key },
      };
    }
    return {
      toolName: 'computer.hotkey',
      capability: 'keyboard.hotkey',
      description: `Press ${mods.join('+')}+${key}`,
      input: { modifiers: mods, key },
    };
  }

  if (/^copy$/i.test(clean)) {
    return { toolName: 'computer.copy', capability: 'keyboard.copy', description: 'Copy the current selection (Ctrl+C)', input: {} };
  }
  if (/^paste$/i.test(clean)) {
    return { toolName: 'computer.paste', capability: 'keyboard.paste', description: 'Paste from the clipboard (Ctrl+V)', input: {} };
  }
  if (/^select\s+all$/i.test(clean)) {
    return { toolName: 'computer.select_all', capability: 'keyboard.select_all', description: 'Select all content (Ctrl+A)', input: {} };
  }
  return null;
}

export function isKeyboardIntent(text: string): boolean {
  return classifyKeyboardIntent(text) !== null;
}

/**
 * Research intent classification (Deep Research capability — outside the
 * numbered roadmap). Conservative:
 * explicit research verbs only, so ordinary chat is never hijacked. "Compare"
 * additionally requires an explicit comparative structure (X and/vs Y).
 * File-like targets stay on the filesystem detectors.
 */
const FILE_TARGET_RE = /\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|jpe?g|png|gif|zip|rar|mp3|mp4|exe|md)\b/i;

export function classifyResearchIntent(clause: string): StepClassification | null {
  const text = clause.trim();
  if (!text || text.length < 10) return null;
  if (FILE_TARGET_RE.test(text)) return null;

  const researchVerb =
    /^(?:research|investigate|dig\s+into|look\s+into|find\s+out|do\s+(?:some\s+)?research|gather\s+(?:some\s+)?(?:info|information)|study\s+up\s+on|compare)\b/i;
  if (!researchVerb.test(text)) return null;

  if (/^(?:compare)\b/i.test(text) && !/\b(?:vs\.?|versus|and|with)\b/i.test(text)) return null;

  return {
    toolName: 'research.run',
    capability: 'research.run',
    description: `Research: ${text.length > 80 ? `${text.slice(0, 77)}...` : text}`,
    input: { goal: text },
  };
}

export function isResearchIntent(text: string): boolean {
  return classifyResearchIntent(text) !== null;
}

/**
 * True when a request should run as ONE deep-research task: the first clause
 * carries an explicit research phrase and the remaining clauses are only
 * reporting ("...and tell me what you find"). Mixed requests fall through to
 * per-clause planning, where the research clause still becomes research.run.
 */
export function isResearchRequest(text: string): boolean {
  const clauses = splitIntoClauses(text);
  if (clauses.length === 0) return false;
  if (!classifyResearchIntent(clauses[0])) return false;
  return clauses.slice(1).every((clause) => REPORT_CLAUSE_RE.test(clause));
}

/**
 * Diagnostic intent classification (Self-Diagnostics v1).
 * Conservative: matches explicit diagnostic queries ("check system health", "run diagnostics", "self-diagnostics").
 */
export function classifyDiagnosticIntent(clause: string): StepClassification | null {
  const text = clause.trim();
  if (!text) return null;

  if (
    /^(?:run\s+)?(?:system\s+)?(?:self-?)?diagnostics(?:\s+(?:check|report|suite))?$/i.test(text) ||
    /^(?:check\s+)?(?:your|system|operational|runtime)?\s*(?:health|diagnostics)(?:\s+(?:check|status|report))?$/i.test(text) ||
    /^(?:how\s+are\s+you\s+(?:doing|functioning)|system\s+health\s+check)$/i.test(text)
  ) {
    return {
      toolName: 'diagnostics.health',
      capability: 'diagnostics.health',
      description: 'Check system health and runtime diagnostics',
      // Passive diagnostics are cache-first by default. A caller may request a
      // refresh explicitly through the tool, but ordinary health questions do
      // not need to re-run deterministic local checks.
      input: {},
    };
  }

  const inspectMatch = text.match(/^(?:inspect|diagnose)\s+(?:the\s+)?(core|intelligence|execution|models|persistence|system)\s+(?:subsystem|health)$/i);
  if (inspectMatch) {
    return {
      toolName: 'diagnostics.inspect',
      capability: 'diagnostics.inspect',
      description: `Inspect ${inspectMatch[1]} subsystem diagnostics`,
      input: { subsystem: inspectMatch[1].toLowerCase() },
    };
  }

  return null;
}

export function isDiagnosticIntent(text: string): boolean {
  return classifyDiagnosticIntent(text) !== null;
}

/** Classify one clause into an intent (capability) + fallback tool name using the existing detectors. */
export function classifyStep(clause: string): StepClassification | null {
  const text = clause.trim();
  if (!text) return null;

  // 0. Filesystem/application intents (Phase 9) — explicit verbs like
  // "find X and open it" must win over the report-clause matcher, which
  // would otherwise fire on the word "report".
  const systemIntent = classifySystemIntent(text);
  if (systemIntent) return systemIntent;

  // 1. Report step — the terminal conversational step.
  if (REPORT_CLAUSE_RE.test(text) && text.split(/\s+/).length <= 8) {
    return {
      toolName: 'chat.report',
      capability: 'communication.report',
      description: `Report the result to the user`,
      input: { topic: text },
    };
  }

  // 2. Explicit remember commands route to the memory tool layer.
  const rememberMatch = text.match(/^remember(?:\s+that)?\s+(.{4,})$/i);
  if (rememberMatch) {
    return {
      toolName: 'memory.remember',
      capability: 'memory.store',
      description: `Remember: "${rememberMatch[1].trim().slice(0, 60)}"`,
      input: { text: rememberMatch[1].trim() },
    };
  }

  // 3. Screen observation intents (before other detectors).
  const screenIntent = classifyScreenIntent(text);
  if (screenIntent) return screenIntent;

  // 3.4 Browser on-page interaction phrases ("click X on the page").
  const browserPhrase = classifyBrowserPhrase(text);
  if (browserPhrase) return browserPhrase;

  // 3.5 Mouse-control intents.
  const mouseIntent = classifyMouseIntent(text);
  if (mouseIntent) return mouseIntent;

  // 3.6 Keyboard-control intents.
  const keyboardIntent = classifyKeyboardIntent(text);
  if (keyboardIntent) return keyboardIntent;

  // 3.7 Deep-research intents (additional Deep Research capability) — explicit
  // verbs, file targets stay on the filesystem detectors below.
  const researchIntent = classifyResearchIntent(text);
  if (researchIntent) return researchIntent;

  // 3.8 Self-diagnostics intents (Self-Diagnostics v1)
  const diagnosticIntent = classifyDiagnosticIntent(text);
  if (diagnosticIntent) return diagnosticIntent;

  // 4. Files (before web: "find resume.pdf" must not become a Google search).
  const fileCmd = parseFileCommand(text);
  if (fileCmd.isFileCommand) {
    if (fileCmd.action === 'scan_folder') {
      return {
        toolName: 'files.scan',
        capability: 'filesystem.scan',
        description: `Scan folder${fileCmd.targetFolder ? ` "${fileCmd.targetFolder}"` : 's'}${fileCmd.targetQuery ? ` for "${fileCmd.targetQuery}"` : ''}`,
        input: { query: fileCmd.targetQuery || '', folderName: fileCmd.targetFolder || '' },
      };
    }
    return {
      toolName: 'files.open',
      capability: 'filesystem.open',
      description: `Find and open "${fileCmd.targetQuery || 'files'}"`,
      input: { query: fileCmd.targetQuery || '', folderName: fileCmd.targetFolder || '' },
    };
  }

  // 5. Web (open or search within a known platform / URL).
  const webAction = detectAndParseWebAction(text);
  if (webAction) {
    const isSearch = webAction.type === 'search_website';
    return {
      toolName: isSearch ? 'web.search_website' : 'web.open_website',
      capability: isSearch ? 'browser.search' : 'browser.open_url',
      description: isSearch
        ? `Search ${webAction.siteName} for "${webAction.query ?? ''}"`
        : `Open ${webAction.siteName}`,
      input: { action: webAction },
    };
  }

  // 6. Laptop application launch.
  const appCmd = detectAndParseAppLaunchCommand(text);
  if (appCmd.isAppCommand) {
    if (appCmd.action === 'list_apps') {
      return {
        toolName: 'app.list',
        capability: 'application.list',
        description: 'Show installed laptop apps',
        input: {},
      };
    }
    if (appCmd.app) {
      return {
        toolName: 'app.launch',
        capability: 'application.launch',
        description: `Launch ${appCmd.app.name}`,
        input: { app: appCmd.app },
      };
    }
  }

  // 7. Location.
  if (isLocationIntent(text)) {
    return {
      toolName: 'location.get',
      capability: 'location.current',
      description: 'Check the user\'s current location',
      input: { text },
    };
  }

  // 8. Unclassified clause — honest note step instead of silent drop.
  return {
    toolName: 'system.note',
    capability: 'system.note',
    description: `Noted (not executable yet): "${text}"`,
    input: { text },
  };
}

export interface Planner {
  makePlan(goal: AgentGoal): AgentPlan;
  /** Phase 11 hook: propose an alternative step after a failure. Returns null for now. */
  proposeAlternative(step: PlanStep, error: string): PlanStep | null;
}

export class HeuristicPlanner implements Planner {
  makePlan(goal: AgentGoal): AgentPlan {
    const clauses = splitIntoClauses(goal.rawInput);
    const usableClauses = clauses.length > 0 ? clauses : [goal.rawInput];
    const steps: PlanStep[] = [];
    const now = Date.now();

    // Compound desktop tasks (≥2 computer-action clauses, nothing else) run
    // through the Phase 7 computer-use orchestrator as one closed-loop step.
    const overflow = usableClauses.length > MAX_PLAN_STEPS;
    const planned = overflow ? usableClauses.slice(0, MAX_PLAN_STEPS - 1) : usableClauses;

    const classifications = planned.map((clause) => ({ clause, cls: classifyStep(clause) }));
    const computerActions = classifications.filter((x) => x.cls && x.cls.capability && COMPUTER_USE_CAPABILITIES.has(x.cls.capability));
    const browserActions = classifications.filter((x) => x.cls && x.cls.capability && BROWSER_USE_CAPABILITIES.has(x.cls.capability));
    const browserInteractive = classifications.filter(
      (x) => x.cls?.capability && ['browser.find', 'browser.click', 'browser.type', 'browser.scroll_until', 'browser.scroll', 'browser.wait', 'browser.verify'].includes(x.cls.capability)
    );
    const nonComputer = classifications.filter(
      (x) => x.cls && !COMPUTER_USE_CAPABILITIES.has(x.cls.capability ?? '') && x.cls.toolName !== 'chat.report'
    );
    const nonBrowser = classifications.filter(
      (x) => x.cls && !BROWSER_USE_CAPABILITIES.has(x.cls.capability ?? '') && x.cls.toolName !== 'chat.report'
    );

    const pushReportStep = (idSuffix: string): void => {
      const last = classifications[classifications.length - 1];
      if (last.cls?.toolName === 'chat.report') {
        steps.push({
          id: `step_${now}_${idSuffix}`,
          description: last.cls.description,
          toolName: 'chat.report',
          capability: last.cls.capability,
          input: last.cls.input,
          status: 'pending',
          attempts: 0,
        });
      }
    };
    const pushOverflowNote = (idSuffix: string): void => {
      if (overflow) {
        steps.push({
          id: `step_${now}_${idSuffix}`,
          description: `Note: request had ${usableClauses.length} parts; only the first ${MAX_PLAN_STEPS - 1} were planned`,
          toolName: 'system.note',
          capability: 'system.note',
          input: { text: 'plan truncated' },
          status: 'pending',
          attempts: 0,
        });
      }
    };

    if (computerActions.length >= 2 && nonComputer.length === 0) {
      steps.push({
        id: `step_${now}_1`,
        description: `Perform computer task: ${goal.description.slice(0, 80)}`,
        toolName: 'computer.use',
        capability: 'computer.use',
        input: { goal: goal.rawInput },
        status: 'pending',
        attempts: 0,
      });
      pushReportStep('2');
      pushOverflowNote('3');
      return { goal, steps, createdAt: now, revision: 1 };
    }

    // Compound browser tasks (≥2 browser clauses incl. ≥1 on-page interaction)
    // run through the Phase 8 browser agent as one closed-loop step.
    if (browserActions.length >= 2 && browserInteractive.length >= 1 && nonBrowser.length === 0) {
      steps.push({
        id: `step_${now}_1`,
        description: `Perform browser task: ${goal.description.slice(0, 80)}`,
        toolName: 'browser.use',
        capability: 'browser.use',
        input: { goal: goal.rawInput },
        status: 'pending',
        attempts: 0,
      });
      pushReportStep('2');
      pushOverflowNote('3');
      return { goal, steps, createdAt: now, revision: 1 };
    }

    // Deep-research requests (additional Deep Research capability) run as ONE
    // bounded research loop that
    // plans sub-questions, searches across rounds, cross-checks sources and
    // synthesizes a cited report through the registered research tools. The
    // research GOAL is the first (research-phrased) clause — trailing report
    // clauses are not part of what should be researched.
    if (isResearchRequest(goal.rawInput)) {
      const researchClause = splitIntoClauses(goal.rawInput)[0] ?? goal.rawInput;
      steps.push({
        id: `step_${now}_1`,
        description: `Research: ${goal.description.slice(0, 80)}`,
        toolName: 'research.run',
        capability: 'research.run',
        input: { goal: researchClause },
        status: 'pending',
        attempts: 0,
      });
      pushReportStep('2');
      pushOverflowNote('3');
      return {
        goal,
        steps,
        createdAt: now,
        revision: 1,
        objective: goal.description,
      };
    }

    if (overflow) {
      planned.push(`Note: request had ${usableClauses.length} parts; only the first ${MAX_PLAN_STEPS - 1} were planned`);
    }

    planned.forEach((clause, index) => {
      const classification = classifyStep(clause) ?? {
        toolName: 'system.note',
        capability: 'system.note',
        description: `Noted (not executable yet): "${clause}"`,
        input: { text: clause } as Record<string, unknown>,
      };
      // Verification is left to the tool's declared strategy; the core defaults
      // to tool_success when a tool declares nothing.
      steps.push({
        id: `step_${now}_${index + 1}`,
        description: classification.description,
        toolName: classification.toolName,
        capability: classification.capability,
        input: classification.input,
        status: 'pending',
        attempts: 0,
      });
    });

    // Phase 10 tool chaining: a filesystem.search followed by a
    // read/inspect/open without an absolute path chains via the task context —
    // the search result feeds the later step's input.
    for (let i = 0; i < steps.length - 1; i++) {
      const producer = steps[i];
      const consumer = steps[i + 1];
      if (
        producer.toolName === 'filesystem.search' &&
        (consumer.toolName === 'filesystem.read' || consumer.toolName === 'filesystem.inspect' || consumer.toolName === 'filesystem.open_file')
      ) {
        const pathValue = String(consumer.input.path ?? '');
        if (!/^[a-zA-Z]:[\\/]/.test(pathValue)) {
          producer.outputKey = 'found';
          consumer.input = { path: { $context: 'found.matches.0.path' } } as Record<string, unknown>;
        }
      }
    }

    return {
      goal,
      steps,
      createdAt: now,
      revision: 1,
      objective: goal.description,
    };
  }

  proposeAlternative(_step: PlanStep, _error: string): PlanStep | null {
    // Phase 11 (Error Recovery) will implement strategy changes.
    return null;
  }
}
