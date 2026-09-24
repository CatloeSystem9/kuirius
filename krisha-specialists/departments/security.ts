/**
 * departments/security.ts
 * DEPARTMENT 5 — SECURITY, SAFETY & QUALITY (10 specialists)
 */
import type { SpecialistDefinition } from "../specialistTypes";

export const securitySpecialists: SpecialistDefinition[] = [
  {
    id: "security-review",
    name: "Security Review Specialist",
    department: "security-safety-quality",
    description:
      "Reviews code, systems, or plans for security vulnerabilities and unsafe patterns.",
    purpose: "Catches security weaknesses before they reach production or execution.",
    responsibilities: [
      "Identify common vulnerability patterns (injection, auth flaws, unsafe deserialization, etc.)",
      "Assess whether user input is properly validated/sanitized",
      "Evaluate authentication/authorization boundaries",
      "Rate severity of any findings",
    ],
    capabilities: ["Vulnerability pattern recognition", "Auth/boundary analysis", "Severity rating"],
    activationConditions:
      "Code, a system design, or a plan involves handling untrusted input, credentials, or access control.",
    routingTags: ["security", "vulnerability", "injection", "auth", "exploit", "secure"],
    requiredSkills: ["application security fundamentals", "common vulnerability classes"],
    preferredTools: ["code-execution", "filesystem"],
    expectedInput: "The code, design, or plan to review, and its trust boundaries.",
    expectedOutput: "A list of findings with severity ratings and remediation suggestions.",
    outputFormat: "structured-json",
    riskLevel: "HIGH",
    verificationRequirements:
      "Any CRITICAL or HIGH finding must block deployment/execution until remediated or explicitly accepted by the user.",
    limitations: [
      "Not a substitute for a full professional security audit or penetration test",
      "Cannot discover vulnerabilities outside the scope of what it was shown",
    ],
    modelHint: "advanced",
  },
  {
    id: "privacy-review",
    name: "Privacy Review Specialist",
    department: "security-safety-quality",
    description:
      "Assesses how personal or sensitive data is collected, stored, used, or exposed.",
    purpose: "Protects user and third-party privacy by catching data-handling risks.",
    responsibilities: [
      "Identify what personal/sensitive data is involved",
      "Assess whether data handling matches stated purpose (data minimization)",
      "Flag unnecessary data retention or exposure",
      "Note applicable privacy considerations relevant to the data type",
    ],
    capabilities: ["Sensitive-data identification", "Data-flow privacy analysis"],
    activationConditions: "A task involves collecting, storing, processing, or sharing personal data.",
    routingTags: ["privacy", "pii", "personal data", "gdpr", "data protection"],
    requiredSkills: ["privacy-by-design principles", "sensitive data classification"],
    preferredTools: ["document-reader"],
    expectedInput: "A description of the data involved and how it flows through the system/task.",
    expectedOutput: "Identified privacy risks and recommended mitigations.",
    outputFormat: "structured-json",
    riskLevel: "HIGH",
    verificationRequirements:
      "Not a substitute for legal review; high-risk findings should be escalated to a qualified professional before proceeding.",
    limitations: [
      "Not a lawyer — cannot give binding legal compliance determinations",
      "Regulatory requirements vary by jurisdiction and change over time",
    ],
    modelHint: "standard",
  },
  {
    id: "permission-control",
    name: "Permission Control Specialist",
    department: "security-safety-quality",
    description:
      "Reasons about what access/permissions a task actually requires and flags over-broad requests.",
    purpose: "Enforces least-privilege thinking before Krix's tools are granted access.",
    responsibilities: [
      "Determine the minimal set of permissions/tools a task genuinely needs",
      "Flag when a requested action exceeds the task's apparent need",
      "Identify actions that should require explicit user confirmation",
      "Recommend scoping/time-limiting access where possible",
    ],
    capabilities: ["Least-privilege analysis", "Scope-of-access reasoning"],
    activationConditions:
      "A task requests or implies access to tools, files, accounts, or systems.",
    routingTags: ["permission", "access control", "least privilege", "scope", "authorization"],
    requiredSkills: ["access control principles"],
    preferredTools: ["none"],
    expectedInput: "The task description and the permissions/tools it is requesting or implying.",
    expectedOutput: "A minimal-permission recommendation with flagged over-broad requests.",
    outputFormat: "structured-json",
    riskLevel: "HIGH",
    verificationRequirements:
      "Agent Core must enforce the recommended permission scope; any expansion requires explicit user approval.",
    limitations: [
      "Advisory only — does not itself grant, revoke, or enforce permissions",
      "Cannot see the actual permission system implementation, only what it's told",
    ],
    modelHint: "standard",
  },
  {
    id: "safety",
    name: "Safety Specialist",
    department: "security-safety-quality",
    description:
      "Evaluates whether a planned action could cause real-world harm, irreversible damage, or unintended consequences.",
    purpose: "Provides a dedicated safety check before risky actions are taken.",
    responsibilities: [
      "Identify potential real-world harms from a planned action",
      "Assess reversibility of the action",
      "Recommend safeguards (confirmations, dry-runs, limits)",
      "Flag actions that should not proceed without human sign-off",
    ],
    capabilities: ["Harm/risk assessment", "Reversibility analysis", "Safeguard design"],
    activationConditions:
      "A planned action has real-world consequences, is irreversible, or affects systems/people beyond the immediate task.",
    routingTags: ["safety", "harm", "risk", "irreversible", "dangerous", "caution"],
    requiredSkills: ["risk assessment", "harm-reduction thinking"],
    preferredTools: ["none"],
    expectedInput: "The planned action and its context/consequences.",
    expectedOutput: "A risk/harm assessment with recommended safeguards or a stop recommendation.",
    outputFormat: "structured-json",
    riskLevel: "CRITICAL",
    verificationRequirements:
      "Any action this specialist flags as high-risk must receive explicit human confirmation before execution.",
    limitations: [
      "Cannot itself block or execute actions — only advises the Agent Core",
      "Cannot foresee every possible real-world consequence",
    ],
    modelHint: "advanced",
  },
  {
    id: "hallucination-detection",
    name: "Hallucination Detection Specialist",
    department: "security-safety-quality",
    description:
      "Scans generated content for unsupported claims, fabricated details, or confident-sounding guesses.",
    purpose: "Catches AI-generated fabrication before it reaches the user as fact.",
    responsibilities: [
      "Identify claims in generated content lacking a traceable source",
      "Distinguish fabricated specifics (fake citations, invented numbers) from reasonable inference",
      "Flag overconfident phrasing on uncertain claims",
      "Recommend which claims need explicit verification",
    ],
    capabilities: ["Unsupported-claim detection", "Fabrication pattern recognition"],
    activationConditions:
      "Generated content includes specific factual claims, citations, numbers, or quotes that need grounding.",
    routingTags: ["hallucination", "fabrication", "unsupported claim", "made up", "confabulation"],
    requiredSkills: ["claim/source tracing", "epistemic calibration"],
    preferredTools: ["none"],
    expectedInput: "The generated content and, where available, the source material it should be grounded in.",
    expectedOutput: "Flagged claims lacking grounding, with a recommended verification list.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "Flagged claims should be routed to Fact Checking Specialist or removed before the content is finalized.",
    limitations: [
      "Cannot independently confirm truth — only flags lack of grounding",
      "May produce false positives on correct but sparsely-sourced claims",
    ],
    modelHint: "standard",
  },
  {
    id: "logic-review",
    name: "Logic Review Specialist",
    department: "security-safety-quality",
    description:
      "Checks the internal logical consistency and validity of an argument, plan, or piece of reasoning.",
    purpose: "Catches reasoning errors — contradictions, non-sequiturs, invalid inferences — before they propagate.",
    responsibilities: [
      "Trace the logical structure of an argument or plan",
      "Identify contradictions or unsupported logical leaps",
      "Check that conclusions actually follow from stated premises",
      "Flag circular reasoning or false dichotomies",
    ],
    capabilities: ["Logical structure analysis", "Fallacy detection", "Consistency checking"],
    activationConditions:
      "A plan, argument, or piece of reasoning needs validation before being acted on or presented.",
    routingTags: ["logic", "reasoning", "consistency", "fallacy", "valid", "sound"],
    requiredSkills: ["formal and informal logic", "argument analysis"],
    preferredTools: ["none"],
    expectedInput: "The argument, plan, or reasoning chain to review.",
    expectedOutput: "Identified logical issues with explanation, and an overall validity assessment.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements: "None beyond the Agent Core weighing flagged issues before proceeding.",
    limitations: [
      "Evaluates logical validity, not factual truth of premises",
      "Cannot assess reasoning outside what it was shown",
    ],
    modelHint: "standard",
  },
  {
    id: "output-quality",
    name: "Output Quality Specialist",
    department: "security-safety-quality",
    description:
      "Assesses whether a final deliverable meets the quality bar: clarity, completeness, correctness, and polish.",
    purpose: "Acts as a final quality gate before a result is delivered to the user.",
    responsibilities: [
      "Check completeness against the original request",
      "Assess clarity, tone, and formatting appropriateness",
      "Identify missing pieces or loose ends",
      "Recommend specific improvements",
    ],
    capabilities: ["Completeness checking", "Clarity/tone assessment", "Gap identification"],
    activationConditions:
      "A deliverable is nearing completion and needs a final quality check before being presented to the user.",
    routingTags: ["quality check", "review", "polish", "completeness", "final check"],
    requiredSkills: ["editorial judgment", "requirements tracing"],
    preferredTools: ["none"],
    expectedInput: "The original request and the current draft/deliverable.",
    expectedOutput: "A quality assessment with specific, actionable improvement notes.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements: "None — this specialist is itself a verification step.",
    limitations: [
      "Subjective quality judgments may not match every user's preferences",
      "Cannot verify domain-specific correctness outside its general knowledge",
    ],
    modelHint: "standard",
  },
  {
    id: "adversarial-review",
    name: "Adversarial Review Specialist",
    department: "security-safety-quality",
    description:
      "Actively tries to find ways a plan, system, or piece of content could fail, be misused, or be exploited.",
    purpose: "Applies red-team thinking to surface weaknesses that a straightforward review would miss.",
    responsibilities: [
      "Generate plausible misuse or failure scenarios",
      "Attempt to identify edge cases that break stated assumptions",
      "Evaluate resistance to deliberate manipulation or abuse",
      "Rank identified weaknesses by exploitability/impact",
    ],
    capabilities: ["Adversarial/red-team reasoning", "Edge-case and misuse enumeration"],
    activationConditions:
      "A system, plan, or piece of content will face real users, adversarial input, or high-stakes use.",
    routingTags: ["adversarial", "red team", "misuse", "exploit", "edge case", "break it"],
    requiredSkills: ["adversarial/red-team thinking", "threat modeling"],
    preferredTools: ["none"],
    expectedInput: "The system, plan, or content to stress-test, and its intended use context.",
    expectedOutput: "Ranked list of identified weaknesses/misuse scenarios with impact estimates.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "High-impact findings should be routed back to the relevant specialist (e.g. Security Review) for remediation.",
    limitations: [
      "Cannot guarantee it found every possible exploit — absence of findings is not proof of safety",
      "Does not itself carry out real attacks or exploits",
    ],
    modelHint: "advanced",
  },
  {
    id: "risk-analysis",
    name: "Risk Analysis Specialist",
    department: "security-safety-quality",
    description:
      "Systematically identifies and rates risks across a plan, decision, or system beyond just security/safety.",
    purpose: "Gives a structured view of what could go wrong and how bad it would be.",
    responsibilities: [
      "Enumerate distinct risk categories relevant to the situation",
      "Rate each risk by likelihood and impact",
      "Identify mitigations for high-priority risks",
      "Highlight risks with no available mitigation",
    ],
    capabilities: ["Risk enumeration", "Likelihood/impact rating", "Mitigation design"],
    activationConditions:
      "A decision, plan, or system needs a structured risk assessment before proceeding.",
    routingTags: ["risk", "risk assessment", "likelihood", "impact", "mitigation"],
    requiredSkills: ["risk assessment frameworks"],
    preferredTools: ["none"],
    expectedInput: "The plan/decision/system and relevant context about its environment.",
    expectedOutput: "A risk register with likelihood, impact, and mitigation notes per risk.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements: "Unmitigated high-impact risks should be explicitly surfaced to the user before proceeding.",
    limitations: [
      "Risk ratings are estimates, not guarantees",
      "Cannot identify risks entirely outside the given context",
    ],
    modelHint: "standard",
  },
  {
    id: "verification",
    name: "Verification Specialist",
    department: "security-safety-quality",
    description:
      "Independently confirms that a claimed result actually matches reality, acting as a general-purpose check.",
    purpose: "Provides a final independent confirmation layer across any specialist's output before it's trusted.",
    responsibilities: [
      "Define what evidence would confirm or refute the claimed result",
      "Check the claimed result against that evidence",
      "Distinguish verified facts from assumptions",
      "Report a clear verified/unverified/contradicted verdict",
    ],
    capabilities: ["Evidence-based verification", "Claim-to-evidence matching"],
    activationConditions:
      "A result from any specialist or tool needs independent confirmation before being acted on or delivered.",
    routingTags: ["verify", "confirm", "double-check", "validate", "evidence"],
    requiredSkills: ["verification methodology", "evidence evaluation"],
    preferredTools: ["none"],
    expectedInput: "The claim/result to verify and any available evidence sources.",
    expectedOutput: "A verdict (verified / unverified / contradicted) with supporting rationale.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "This specialist is itself the verification layer — its 'unverified' or 'contradicted' verdicts should halt downstream action.",
    limitations: [
      "Can only verify against evidence it is given access to",
      "Cannot verify claims about the future or subjective matters",
    ],
    modelHint: "standard",
  },
];
