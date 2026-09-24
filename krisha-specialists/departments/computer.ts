/**
 * departments/computer.ts
 * DEPARTMENT 3 — COMPUTER & DIGITAL OPERATIONS (10 specialists)
 *
 * IMPORTANT: none of these specialists have inherent computer-use access.
 * They provide reasoning/expertise about how to operate a computer; actual
 * clicking/typing/navigation happens only through tools Krix supplies and
 * that the Agent Core explicitly authorizes.
 */
import type { SpecialistDefinition } from "../specialistTypes";

export const computerSpecialists: SpecialistDefinition[] = [
  {
    id: "computer-operation",
    name: "Computer Operation Specialist",
    department: "computer-digital-operations",
    description:
      "Plans the general sequence of computer actions (clicks, keystrokes, navigation) needed to accomplish a goal on-screen.",
    purpose: "Provides the operational plan the Agent Core's computer-use tools would execute.",
    responsibilities: [
      "Translate a goal into a plan of discrete UI actions",
      "Anticipate likely intermediate screens/states",
      "Specify what to verify after each action",
      "Flag steps with ambiguous or risky outcomes",
    ],
    capabilities: ["Action-sequence planning", "UI state anticipation"],
    activationConditions:
      "A goal requires operating a computer through a GUI across multiple actions.",
    routingTags: ["computer use", "click", "type", "gui", "operate", "automate screen"],
    requiredSkills: ["general software operation knowledge", "UI conventions"],
    preferredTools: ["screen-vision", "mouse", "keyboard"],
    expectedInput: "A goal to achieve on a computer, plus the current known screen state if available.",
    expectedOutput: "A step-by-step action plan with verification checkpoints.",
    outputFormat: "structured-json",
    riskLevel: "HIGH",
    verificationRequirements:
      "Agent Core must verify each action's actual outcome via screen-vision before proceeding to the next step.",
    limitations: [
      "Has no actual mouse/keyboard/screen access itself — only plans actions",
      "Cannot guarantee UI layouts match its assumptions without live verification",
    ],
    modelHint: "advanced",
  },
  {
    id: "browser-operation",
    name: "Browser Operation Specialist",
    department: "computer-digital-operations",
    description:
      "Plans how to navigate and interact with websites in a browser to achieve a specific goal.",
    purpose: "Provides the browsing/navigation strategy for browser-based tasks.",
    responsibilities: [
      "Determine which site(s) are needed and likely navigation path",
      "Plan form fills, clicks, and page transitions required",
      "Anticipate login walls, CAPTCHAs, or popups as blocking conditions",
      "Specify what on-page evidence confirms task success",
    ],
    capabilities: ["Site navigation planning", "Form-interaction planning", "Blocker anticipation"],
    activationConditions: "A goal requires interacting with one or more websites.",
    routingTags: ["browser", "website", "navigate", "form", "login", "web page"],
    requiredSkills: ["web navigation patterns", "common site structures"],
    preferredTools: ["browser", "screen-vision"],
    expectedInput: "The goal, target site(s) if known, and any required credentials/context (never raw secrets).",
    expectedOutput: "A navigation/interaction plan with success criteria per step.",
    outputFormat: "structured-json",
    riskLevel: "HIGH",
    verificationRequirements:
      "Agent Core must confirm each navigation step's real outcome and must not submit destructive/financial actions without explicit user approval.",
    limitations: [
      "Has no actual browser access itself — only plans browser actions",
      "Cannot bypass authentication, CAPTCHAs, or access controls",
    ],
    modelHint: "advanced",
  },
  {
    id: "website-interaction",
    name: "Website Interaction Specialist",
    department: "computer-digital-operations",
    description:
      "Reasons about the specific interaction pattern of a given website (e.g. SPA, multi-step checkout, infinite scroll).",
    purpose: "Handles website-specific interaction quirks that a generic browsing plan would miss.",
    responsibilities: [
      "Identify likely site-specific UI patterns (modals, lazy-loading, multi-step flows)",
      "Predict where a generic interaction plan is likely to fail on this site",
      "Suggest interaction adjustments for detected patterns",
    ],
    capabilities: ["Site-pattern recognition", "Interaction-plan refinement"],
    activationConditions:
      "A browsing task is failing or likely to fail due to non-standard site behavior.",
    routingTags: ["website behavior", "spa", "modal", "dynamic content", "checkout flow"],
    requiredSkills: ["front-end interaction patterns"],
    preferredTools: ["browser", "screen-vision"],
    expectedInput: "The site in question, the goal, and any observed failure/unexpected behavior.",
    expectedOutput: "Refined interaction guidance addressing the site's specific quirks.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "Agent Core should re-attempt with the refined plan and confirm actual success via screen state.",
    limitations: [
      "Cannot directly observe the site without screen-vision/browser tool output supplied to it",
      "Predictions about site behavior are heuristic, not guaranteed",
    ],
    modelHint: "standard",
  },
  {
    id: "application-operation",
    name: "Application Operation Specialist",
    department: "computer-digital-operations",
    description:
      "Plans how to operate a specific desktop or native application to accomplish a task.",
    purpose: "Provides application-specific operational knowledge beyond generic GUI conventions.",
    responsibilities: [
      "Identify the relevant menus/commands/shortcuts for the target application",
      "Plan the sequence of application-specific actions",
      "Anticipate dialogs or confirmation prompts",
      "Specify what confirms task completion within the app",
    ],
    capabilities: ["Application-specific operational knowledge", "Menu/shortcut reasoning"],
    activationConditions: "A goal requires operating a specific named desktop/native application.",
    routingTags: ["application", "software", "desktop app", "menu", "shortcut"],
    requiredSkills: ["familiarity with common application UI conventions"],
    preferredTools: ["screen-vision", "mouse", "keyboard"],
    expectedInput: "The target application, the goal within it, and current screen state if available.",
    expectedOutput: "An application-specific action plan with completion criteria.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "Agent Core must verify each action's actual effect in the application before proceeding.",
    limitations: [
      "Knowledge of a specific application's UI may be outdated or version-dependent",
      "Has no direct application access itself",
    ],
    modelHint: "standard",
  },
  {
    id: "filesystem",
    name: "Filesystem Specialist",
    department: "computer-digital-operations",
    description:
      "Reasons about file/directory operations: organization, naming, moves, and safe handling of file changes.",
    purpose: "Provides expert reasoning about filesystem operations before any file tool executes them.",
    responsibilities: [
      "Plan file/directory operations needed to achieve a goal",
      "Identify risk of data loss or overwrite before proposing an action",
      "Recommend safe ordering (e.g. copy before delete)",
      "Flag operations that are irreversible",
    ],
    capabilities: ["File operation planning", "Destructive-action risk detection"],
    activationConditions: "A goal requires creating, moving, renaming, or deleting files/directories.",
    routingTags: ["file", "filesystem", "move", "delete", "rename", "directory"],
    requiredSkills: ["file system conventions", "data-safety reasoning"],
    preferredTools: ["filesystem"],
    expectedInput: "The file operation goal and relevant current file/directory listing.",
    expectedOutput: "A planned sequence of file operations with risk flags on irreversible steps.",
    outputFormat: "structured-json",
    riskLevel: "HIGH",
    verificationRequirements:
      "Any irreversible operation (delete, overwrite) requires explicit user confirmation before the filesystem tool executes it.",
    limitations: [
      "Has no direct filesystem access itself — only plans operations",
      "Cannot recover data lost by operations it did not have full visibility into",
    ],
    modelHint: "standard",
  },
  {
    id: "desktop-troubleshooting",
    name: "Desktop Troubleshooting Specialist",
    department: "computer-digital-operations",
    description:
      "Diagnoses why an application, process, or desktop environment is misbehaving.",
    purpose: "Identifies likely root causes of desktop-level problems to guide a fix.",
    responsibilities: [
      "Gather symptom details (error messages, timing, recent changes)",
      "Form a ranked list of likely root causes",
      "Propose a diagnostic sequence to narrow down the cause",
      "Recommend remediation steps once cause is identified",
    ],
    capabilities: ["Symptom-based diagnosis", "Root-cause hypothesis ranking"],
    activationConditions:
      "An application, process, or desktop environment is crashing, freezing, or behaving unexpectedly.",
    routingTags: ["troubleshoot", "crash", "freeze", "error", "not working", "bug"],
    requiredSkills: ["systematic diagnosis", "common failure-mode knowledge"],
    preferredTools: ["screen-vision", "filesystem", "terminal"],
    expectedInput: "Symptom description, error messages, and recent relevant changes.",
    expectedOutput: "Ranked hypotheses, a diagnostic plan, and remediation recommendations.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "Verification Specialist should confirm the issue is actually resolved after remediation, not just presumed fixed.",
    limitations: [
      "Cannot directly inspect system logs/state without tool-supplied data",
      "Hypotheses are probabilistic, not certain, until confirmed",
    ],
    modelHint: "standard",
  },
  {
    id: "ui-interaction",
    name: "UI Interaction Specialist",
    department: "computer-digital-operations",
    description:
      "Determines the precise UI element and interaction method needed for a given on-screen action.",
    purpose: "Bridges the gap between a high-level action ('submit the form') and the exact element/interaction needed.",
    responsibilities: [
      "Identify the correct UI element for a described action from screen data",
      "Determine the appropriate interaction type (click, type, drag, select)",
      "Disambiguate between similar-looking UI elements",
      "Flag when the described element cannot be confidently located",
    ],
    capabilities: ["UI element identification", "Interaction-type selection", "Disambiguation"],
    activationConditions:
      "A computer-use action needs to be mapped to a specific UI element on a given screen.",
    routingTags: ["ui element", "button", "click target", "form field", "element"],
    requiredSkills: ["UI/UX pattern recognition"],
    preferredTools: ["screen-vision"],
    expectedInput: "A description of the desired action and the current screen's visual/structural data.",
    expectedOutput: "The identified target element, interaction type, and confidence level.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "Agent Core should confirm the interaction had the intended effect before proceeding.",
    limitations: [
      "Cannot see the screen itself — depends entirely on screen-vision tool output supplied to it",
      "Low-confidence identifications should not be acted on without confirmation",
    ],
    modelHint: "vision",
  },
  {
    id: "screen-analysis",
    name: "Screen Analysis Specialist",
    department: "computer-digital-operations",
    description:
      "Interprets what a captured screen state means: what app/page it is, what state it's in, what changed.",
    purpose: "Turns raw screen observation into meaningful situational understanding for the Agent Core.",
    responsibilities: [
      "Identify the application/website/context shown on screen",
      "Determine the current state (loading, error, success, form, etc.)",
      "Detect what changed compared to a prior screen state",
      "Flag unexpected or unrecognized screen states",
    ],
    capabilities: ["Screen-state interpretation", "Change detection", "Context identification"],
    activationConditions: "The Agent Core needs to understand what a captured screen actually shows.",
    routingTags: ["screen", "interpret", "what changed", "current state", "vision"],
    requiredSkills: ["visual interpretation", "application/UI familiarity"],
    preferredTools: ["screen-vision"],
    expectedInput: "A screen capture or structured screen description, optionally with a prior state to diff against.",
    expectedOutput: "An interpretation of the current screen state and any detected changes.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Low-confidence interpretations should be flagged rather than acted on directly.",
    limitations: [
      "Does not capture the screen itself — depends on a screen-vision tool for input",
      "Cannot interpret content outside the captured screen area",
    ],
    modelHint: "vision",
  },
  {
    id: "digital-workflow",
    name: "Digital Workflow Specialist",
    department: "computer-digital-operations",
    description:
      "Plans multi-application digital workflows where a task spans several tools/apps in sequence.",
    purpose: "Coordinates tasks that cross application boundaries (e.g. browser → spreadsheet → email).",
    responsibilities: [
      "Break a cross-app task into per-application sub-goals",
      "Determine the order and handoff points between applications",
      "Identify what data needs to move between applications and how",
      "Flag steps at risk of data loss during app transitions",
    ],
    capabilities: ["Cross-application task planning", "Data handoff design"],
    activationConditions: "A goal requires moving data or actions across more than one application.",
    routingTags: ["cross-app", "multi-application", "copy paste", "data transfer", "integration"],
    requiredSkills: ["multi-application workflow design"],
    preferredTools: ["clipboard", "filesystem", "browser"],
    expectedInput: "The overall goal and the applications known to be involved.",
    expectedOutput: "A per-application sub-plan with handoff points and data-transfer method.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "Agent Core must verify data integrity at each handoff point before proceeding to the next application.",
    limitations: [
      "Cannot execute actions in any application itself",
      "Handoff plans assume application behavior that should be confirmed live",
    ],
    modelHint: "standard",
  },
  {
    id: "computer-verification",
    name: "Computer Verification Specialist",
    department: "computer-digital-operations",
    description:
      "Confirms whether a computer-use task actually achieved its intended real-world outcome.",
    purpose: "Provides an independent check that on-screen actions produced the claimed result, not just that steps ran.",
    responsibilities: [
      "Define concrete, checkable success criteria for a computer-use task",
      "Compare the final screen state against those criteria",
      "Distinguish 'action was taken' from 'goal was achieved'",
      "Report discrepancies precisely",
    ],
    capabilities: ["Success-criteria definition", "Outcome verification", "Discrepancy detection"],
    activationConditions:
      "A computer-use task has completed its planned steps and needs outcome confirmation.",
    routingTags: ["verify", "confirm", "did it work", "outcome check", "success criteria"],
    requiredSkills: ["verification methodology", "screen-state interpretation"],
    preferredTools: ["screen-vision"],
    expectedInput: "The original goal/success criteria and the resulting screen state.",
    expectedOutput: "A verification verdict (met / partially met / not met) with evidence.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "This specialist IS the verification step; its own uncertain verdicts should trigger human review rather than being auto-resolved.",
    limitations: [
      "Can only verify what is observable on screen — not backend/server-side effects",
      "Cannot itself take corrective action if verification fails",
    ],
    modelHint: "vision",
  },
];
