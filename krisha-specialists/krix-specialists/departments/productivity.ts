/**
 * departments/productivity.ts
 * DEPARTMENT 1 — PRODUCTIVITY & EXECUTION (10 specialists)
 */
import type { SpecialistDefinition } from "../specialistTypes";

export const productivitySpecialists: SpecialistDefinition[] = [
  {
    id: "task-execution",
    name: "Task Execution Specialist",
    department: "productivity-execution",
    description:
      "Breaks a stated goal into a concrete, ordered sequence of executable steps and tracks progress through them.",
    purpose:
      "Turns an ambiguous or high-level user request into an actionable step list the Agent Core can drive to completion.",
    responsibilities: [
      "Decompose a goal into discrete, ordered steps",
      "Identify preconditions and dependencies between steps",
      "Flag steps that require another specialist or a tool",
      "Track which steps are complete, pending, or blocked",
      "Recommend the next best action given current progress",
    ],
    capabilities: [
      "Goal decomposition",
      "Dependency sequencing",
      "Progress tracking against a plan",
      "Identifying blocking conditions",
    ],
    activationConditions:
      "A user request implies multiple steps or a multi-stage process, or an existing plan needs re-sequencing after new information.",
    routingTags: ["task", "execution", "plan", "steps", "todo", "sequence"],
    requiredSkills: ["task decomposition", "process thinking", "dependency analysis"],
    preferredTools: ["none"],
    expectedInput:
      "A goal statement, plus any known constraints, deadlines, or prior progress.",
    expectedOutput:
      "An ordered step list with dependencies, current status, and the recommended next step.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Agent Core should confirm the step sequence is logically complete before beginning execution.",
    limitations: [
      "Does not execute steps itself — only plans and sequences them",
      "Does not have access to tools or the live system state",
    ],
    modelHint: "standard",
  },
  {
    id: "workflow-management",
    name: "Workflow Management Specialist",
    department: "productivity-execution",
    description:
      "Designs and maintains repeatable multi-step workflows spanning tools, people, or systems.",
    purpose:
      "Provides structure for recurring or multi-stage processes so they run consistently rather than ad hoc.",
    responsibilities: [
      "Model a workflow as stages, transitions, and triggers",
      "Identify handoff points between people, tools, or specialists",
      "Detect workflow bottlenecks or redundant steps",
      "Recommend simplifications or reordering",
      "Version workflows as they evolve",
    ],
    capabilities: [
      "Workflow/state-machine modeling",
      "Bottleneck identification",
      "Handoff design",
    ],
    activationConditions:
      "A request describes a recurring or multi-stage process, or asks to formalize/improve an existing process.",
    routingTags: ["workflow", "process", "pipeline", "stages", "handoff"],
    requiredSkills: ["process design", "systems thinking"],
    preferredTools: ["none"],
    expectedInput: "A description of the current or desired process and its stages.",
    expectedOutput: "A structured workflow model with stages, transitions, and improvement notes.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Agent Core or user should confirm the modeled workflow matches real-world constraints before automating it.",
    limitations: [
      "Does not implement or automate the workflow itself",
      "Cannot observe how an existing process actually runs in practice",
    ],
    modelHint: "standard",
  },
  {
    id: "project-management",
    name: "Project Management Specialist",
    department: "productivity-execution",
    description:
      "Plans and tracks multi-person or multi-deliverable projects, including milestones, timelines, and risk.",
    purpose:
      "Gives structure to larger efforts that span multiple deliverables, contributors, or timeframes.",
    responsibilities: [
      "Define milestones and deliverables from a project goal",
      "Estimate rough sequencing and dependencies between deliverables",
      "Track status against milestones",
      "Surface schedule or scope risk",
      "Summarize project health for stakeholders",
    ],
    capabilities: [
      "Milestone planning",
      "Timeline construction",
      "Risk/status reporting",
    ],
    activationConditions:
      "A request spans multiple deliverables, contributors, or a defined timeline.",
    routingTags: ["project", "milestone", "timeline", "deliverables", "status"],
    requiredSkills: ["project planning", "risk assessment"],
    preferredTools: ["calendar"],
    expectedInput: "Project goal, known deliverables, deadlines, and constraints.",
    expectedOutput: "Milestone plan, timeline, and a status/risk summary.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Agent Core should validate estimated timelines against real calendar/tool data before presenting as commitments.",
    limitations: [
      "Does not have authority over other people's time or commitments",
      "Timeline estimates are advisory, not guarantees",
    ],
    modelHint: "standard",
  },
  {
    id: "task-prioritization",
    name: "Task Prioritization Specialist",
    department: "productivity-execution",
    description:
      "Ranks a set of candidate tasks by urgency, importance, and effort to recommend what to do next.",
    purpose: "Resolves the 'what should I work on first' problem using explicit criteria.",
    responsibilities: [
      "Collect and normalize a list of candidate tasks",
      "Score tasks against urgency, importance, and effort",
      "Identify quick wins vs. high-effort/high-value items",
      "Recommend a prioritized order with rationale",
    ],
    capabilities: ["Prioritization frameworks (e.g. urgency/importance)", "Trade-off reasoning"],
    activationConditions:
      "A user has multiple candidate tasks and needs help deciding order or focus.",
    routingTags: ["priority", "urgent", "important", "rank", "order", "triage"],
    requiredSkills: ["prioritization frameworks", "trade-off analysis"],
    preferredTools: ["none"],
    expectedInput: "A list of candidate tasks with any known deadlines, impact, or effort notes.",
    expectedOutput: "A ranked task list with the reasoning behind each ranking.",
    outputFormat: "structured-json",
    riskLevel: "SAFE",
    verificationRequirements: "User should confirm the prioritization criteria match their actual goals.",
    limitations: [
      "Rankings are only as good as the information provided about each task",
      "Does not know unstated personal or organizational priorities",
    ],
    modelHint: "lightweight",
  },
  {
    id: "scheduling",
    name: "Scheduling Specialist",
    department: "productivity-execution",
    description:
      "Reasons about calendars, deadlines, and time constraints to propose schedules or meeting times.",
    purpose: "Handles the reasoning required to fit tasks/events into available time sensibly.",
    responsibilities: [
      "Identify time constraints, deadlines, and existing commitments",
      "Propose a schedule or candidate time slots",
      "Detect scheduling conflicts",
      "Account for buffers, travel time, or recurring commitments",
    ],
    capabilities: ["Time-constraint reasoning", "Conflict detection", "Schedule optimization"],
    activationConditions:
      "A request involves fitting tasks/events into time, or resolving a scheduling conflict.",
    routingTags: ["schedule", "calendar", "meeting", "deadline", "time", "availability"],
    requiredSkills: ["temporal reasoning", "constraint solving"],
    preferredTools: ["calendar"],
    expectedInput: "Tasks/events to schedule, known constraints, and existing calendar data if available.",
    expectedOutput: "A proposed schedule or ranked list of candidate time slots, with conflicts flagged.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Agent Core must confirm against the actual calendar tool before treating any slot as booked.",
    limitations: [
      "Cannot see real calendar data unless supplied via a calendar tool",
      "Cannot book or modify events itself",
    ],
    modelHint: "lightweight",
  },
  {
    id: "notes-knowledge-organization",
    name: "Notes & Knowledge Organization Specialist",
    department: "productivity-execution",
    description:
      "Structures loose notes, ideas, or captured information into organized, retrievable knowledge.",
    purpose: "Prevents captured information from becoming unusable clutter.",
    responsibilities: [
      "Cluster related notes/ideas into coherent groups",
      "Propose a tagging or folder taxonomy",
      "Identify duplicate or contradictory notes",
      "Summarize a set of notes into key takeaways",
    ],
    capabilities: ["Clustering/categorization", "Taxonomy design", "Note summarization"],
    activationConditions:
      "A user has a body of unstructured notes or captured information to organize or make sense of.",
    routingTags: ["notes", "organize", "knowledge base", "taxonomy", "tags"],
    requiredSkills: ["information architecture", "categorization"],
    preferredTools: ["document-reader", "filesystem"],
    expectedInput: "Raw notes, captured text, or references to note files.",
    expectedOutput: "A proposed organizational structure and/or summarized/tagged notes.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "User should review proposed taxonomy before it's applied broadly.",
    limitations: [
      "Does not permanently reorganize files itself — proposes structure only",
      "Cannot verify factual accuracy of note contents",
    ],
    modelHint: "lightweight",
  },
  {
    id: "document-organization",
    name: "Document Organization Specialist",
    department: "productivity-execution",
    description:
      "Reasons about how a set of files/documents should be named, structured, and stored.",
    purpose: "Keeps file systems and document sets navigable and consistent.",
    responsibilities: [
      "Propose folder/file naming conventions",
      "Identify misfiled, duplicate, or orphaned documents",
      "Recommend a directory structure for a given document set",
      "Flag version-control or naming inconsistencies",
    ],
    capabilities: ["File taxonomy design", "Naming convention design", "Duplicate detection reasoning"],
    activationConditions:
      "A request involves organizing, renaming, or restructuring a set of files or documents.",
    routingTags: ["files", "documents", "folders", "organize", "naming", "structure"],
    requiredSkills: ["information architecture", "file management conventions"],
    preferredTools: ["filesystem", "document-reader"],
    expectedInput: "A listing or description of the documents/files to be organized.",
    expectedOutput: "A proposed folder/file structure and naming scheme, with flagged issues.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "Any actual file moves/renames must go through the filesystem tool under Agent Core supervision, with user confirmation for destructive changes.",
    limitations: [
      "Does not move, rename, or delete files itself",
      "Recommendations depend on the accuracy of the file listing provided",
    ],
    modelHint: "lightweight",
  },
  {
    id: "personal-productivity",
    name: "Personal Productivity Specialist",
    department: "productivity-execution",
    description:
      "Advises on personal habits, focus techniques, and time-use patterns to improve individual output.",
    purpose: "Helps a user work more effectively given their own patterns and constraints.",
    responsibilities: [
      "Identify friction points in a user's stated workflow",
      "Suggest evidence-based focus/productivity techniques",
      "Help set realistic, specific goals",
      "Suggest lightweight tracking approaches",
    ],
    capabilities: ["Productivity technique knowledge", "Habit/goal-setting guidance"],
    activationConditions:
      "A user asks for help being more productive, focused, or organized in their personal work habits.",
    routingTags: ["productivity", "focus", "habits", "time management", "goals"],
    requiredSkills: ["behavioral/productivity frameworks"],
    preferredTools: ["none"],
    expectedInput: "A description of the user's current habits, goals, and pain points.",
    expectedOutput: "Concrete, tailored suggestions and an optional lightweight tracking plan.",
    outputFormat: "structured-json",
    riskLevel: "SAFE",
    verificationRequirements: "None beyond user confirmation that suggestions fit their situation.",
    limitations: [
      "Not a substitute for professional coaching or mental health support",
      "Cannot monitor actual behavior over time without explicit tracking input",
    ],
    modelHint: "lightweight",
  },
  {
    id: "checklist-procedure",
    name: "Checklist & Procedure Specialist",
    department: "productivity-execution",
    description:
      "Converts a process description into a precise, repeatable checklist or standard operating procedure.",
    purpose: "Makes recurring processes reliable and easy to hand off or automate later.",
    responsibilities: [
      "Extract discrete steps from a process description",
      "Order steps and note required conditions/inputs per step",
      "Add verification checkpoints within the procedure",
      "Keep checklists concise and unambiguous",
    ],
    capabilities: ["Procedure writing", "Checklist design", "Edge-case enumeration"],
    activationConditions:
      "A user wants a process turned into a checklist, SOP, or step-by-step procedure.",
    routingTags: ["checklist", "procedure", "sop", "steps", "how-to"],
    requiredSkills: ["procedural writing", "process analysis"],
    preferredTools: ["document-reader"],
    expectedInput: "A description of the process, or examples of how it's currently done.",
    expectedOutput: "A structured checklist/SOP with ordered steps and verification points.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Subject-matter owner should validate the checklist against real-world edge cases before relying on it.",
    limitations: [
      "Cannot guarantee the checklist covers every real-world edge case",
      "Does not execute the procedure itself",
    ],
    modelHint: "lightweight",
  },
  {
    id: "routine-automation",
    name: "Routine Automation Specialist",
    department: "productivity-execution",
    description:
      "Identifies repetitive manual tasks and designs how they could be automated by Krix's tools.",
    purpose: "Reduces repeated manual effort by turning patterns into reusable automations.",
    responsibilities: [
      "Detect recurring/repetitive task patterns from descriptions or history",
      "Design a proposed automation flow (trigger, steps, conditions)",
      "Identify what tool capabilities the automation would require",
      "Flag risks of automating a given task (e.g. irreversible actions)",
    ],
    capabilities: ["Pattern detection in repeated tasks", "Automation flow design"],
    activationConditions:
      "A user performs or describes a repetitive task that could plausibly be automated by Krix.",
    routingTags: ["automation", "routine", "repetitive", "trigger", "recurring"],
    requiredSkills: ["process automation design", "risk-aware automation thinking"],
    preferredTools: ["none"],
    expectedInput: "A description of the repetitive task and how often/when it occurs.",
    expectedOutput: "A proposed automation design plus the tool capabilities it would depend on.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "Agent Core must confirm required tool permissions and get explicit user approval before enabling any automation that takes real actions.",
    limitations: [
      "Does not implement or run automations itself",
      "Cannot assess risk of tool actions it has no visibility into",
    ],
    modelHint: "standard",
  },
];
