/**
 * departments/research.ts
 * DEPARTMENT 2 — RESEARCH & KNOWLEDGE (10 specialists)
 */
import type { SpecialistDefinition } from "../specialistTypes";

export const researchSpecialists: SpecialistDefinition[] = [
  {
    id: "web-research",
    name: "Web Research Specialist",
    department: "research-knowledge",
    description:
      "Plans and directs targeted web research to answer a specific question, using search as a tool.",
    purpose: "Finds current, relevant information from the open web efficiently.",
    responsibilities: [
      "Formulate effective search queries from a research question",
      "Identify which results are worth deeper investigation",
      "Extract relevant facts and note their sources",
      "Recognize when results are insufficient and refine the query",
    ],
    capabilities: ["Query formulation", "Source triage", "Fact extraction with attribution"],
    activationConditions:
      "A question requires current or external information not already known or provided.",
    routingTags: ["research", "search", "web", "lookup", "find information"],
    requiredSkills: ["search strategy", "source triage"],
    preferredTools: ["web-search", "browser"],
    expectedInput: "A specific research question or information need.",
    expectedOutput: "Extracted facts with source references and a confidence assessment.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Cross-check key facts against a second source; Fact Checking Specialist should verify high-stakes claims.",
    limitations: [
      "Does not have inherent web access — depends on a web-search/browser tool being supplied",
      "Cannot verify source reliability beyond surface heuristics",
    ],
    modelHint: "standard",
  },
  {
    id: "deep-research",
    name: "Deep Research Specialist",
    department: "research-knowledge",
    description:
      "Conducts multi-step, multi-source research on broad or open-ended topics requiring synthesis.",
    purpose: "Handles research questions too complex for a single search-and-summarize pass.",
    responsibilities: [
      "Break a broad topic into sub-questions",
      "Direct research across multiple sub-questions and sources",
      "Reconcile conflicting information across sources",
      "Synthesize findings into a coherent structured report",
    ],
    capabilities: ["Multi-step research planning", "Cross-source synthesis", "Conflict reconciliation"],
    activationConditions:
      "A research question is broad, open-ended, or requires combining many sources over multiple steps.",
    routingTags: ["deep research", "investigate", "comprehensive", "synthesis", "report"],
    requiredSkills: ["research planning", "synthesis", "source reconciliation"],
    preferredTools: ["web-search", "browser", "document-reader"],
    expectedInput: "A broad research topic or question, plus scope/depth constraints.",
    expectedOutput: "A structured research report with sub-findings, sources, and a synthesized conclusion.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Output Quality and Fact Checking specialists should review before presenting as final.",
    limitations: [
      "Time/step-limited — cannot exhaustively cover unbounded topics",
      "Depends entirely on tool-supplied search/browsing access",
    ],
    modelHint: "advanced",
  },
  {
    id: "fact-checking",
    name: "Fact Checking Specialist",
    department: "research-knowledge",
    description:
      "Verifies specific factual claims against available sources and flags unsupported statements.",
    purpose: "Reduces the risk of incorrect claims propagating into final results.",
    responsibilities: [
      "Identify discrete checkable claims in a piece of content",
      "Verify each claim against independent sources",
      "Rate each claim's support level",
      "Flag claims that cannot be verified",
    ],
    capabilities: ["Claim extraction", "Source cross-referencing", "Confidence rating"],
    activationConditions:
      "Content contains factual claims that carry real consequences if wrong (numbers, dates, quotes, technical claims).",
    routingTags: ["fact check", "verify", "accuracy", "claims", "confirm"],
    requiredSkills: ["source evaluation", "claim verification"],
    preferredTools: ["web-search", "document-reader"],
    expectedInput: "A piece of content or a list of specific claims to verify.",
    expectedOutput: "Per-claim verification status with supporting/contradicting sources.",
    outputFormat: "structured-json",
    riskLevel: "MEDIUM",
    verificationRequirements:
      "Claims rated UNCERTAIN should be surfaced explicitly to the user rather than silently resolved.",
    limitations: [
      "Cannot verify claims with no available independent source",
      "Not a legal or medical authority — flags rather than adjudicates disputed claims",
    ],
    modelHint: "standard",
  },
  {
    id: "source-evaluation",
    name: "Source Evaluation Specialist",
    department: "research-knowledge",
    description:
      "Assesses the credibility, bias, and reliability of a given information source.",
    purpose: "Helps the Agent Core weigh how much to trust a given piece of evidence.",
    responsibilities: [
      "Assess a source's authority, recency, and track record where knowable",
      "Identify likely bias or conflicts of interest",
      "Distinguish primary from secondary/derivative sources",
      "Provide a reliability rating with rationale",
    ],
    capabilities: ["Source credibility assessment", "Bias detection", "Primary/secondary classification"],
    activationConditions:
      "A research result's trustworthiness materially affects downstream decisions.",
    routingTags: ["source", "credibility", "bias", "reliability", "trustworthy"],
    requiredSkills: ["media literacy", "source criticism"],
    preferredTools: ["web-search"],
    expectedInput: "A source (URL, publication, or document) to assess.",
    expectedOutput: "A reliability rating with rationale and noted caveats.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements: "Ratings are advisory; Agent Core should still corroborate high-stakes facts elsewhere.",
    limitations: [
      "Cannot definitively prove intent or hidden bias",
      "Assessment quality depends on what metadata is available about the source",
    ],
    modelHint: "standard",
  },
  {
    id: "information-retrieval",
    name: "Information Retrieval Specialist",
    department: "research-knowledge",
    description:
      "Locates specific known information within a large body of already-available text or documents.",
    purpose: "Finds needle-in-haystack information within content Krix already has access to, without new external research.",
    responsibilities: [
      "Search across provided documents/text for relevant passages",
      "Rank matches by relevance to the query",
      "Extract precise answers with location references",
      "Indicate when the requested information is absent",
    ],
    capabilities: ["Relevance ranking", "Passage extraction", "Absence detection"],
    activationConditions:
      "The needed information should already exist within provided documents, files, or prior context.",
    routingTags: ["retrieve", "find", "lookup", "locate", "search documents"],
    requiredSkills: ["information retrieval", "relevance judgment"],
    preferredTools: ["document-reader", "filesystem"],
    expectedInput: "A query plus the corpus/documents to search within.",
    expectedOutput: "Matched passages with locations and a relevance-ranked answer.",
    outputFormat: "structured-json",
    riskLevel: "SAFE",
    verificationRequirements: "None beyond confirming the cited passage actually supports the extracted answer.",
    limitations: [
      "Only searches content it is given — has no independent access to external sources",
      "Cannot retrieve information that doesn't exist in the provided corpus",
    ],
    modelHint: "lightweight",
  },
  {
    id: "academic-research",
    name: "Academic Research Specialist",
    department: "research-knowledge",
    description:
      "Handles research questions requiring scholarly rigor: literature framing, methodology awareness, and citation discipline.",
    purpose: "Supports research tasks that need academic-standard sourcing and reasoning.",
    responsibilities: [
      "Identify relevant fields of study and terminology for a question",
      "Distinguish peer-reviewed/scholarly sources from general web content",
      "Summarize methodology and findings of academic sources accurately",
      "Note scholarly consensus vs. contested areas",
    ],
    capabilities: ["Scholarly source identification", "Methodology summarization", "Consensus assessment"],
    activationConditions:
      "A request explicitly needs academic/scholarly rigor or references research literature.",
    routingTags: ["academic", "scholarly", "literature", "study", "paper", "citation"],
    requiredSkills: ["academic literacy", "research methodology awareness"],
    preferredTools: ["web-search", "document-reader"],
    expectedInput: "An academic research question or a set of papers/sources to work from.",
    expectedOutput: "A structured summary of relevant literature, methodology notes, and consensus level.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Fact Checking Specialist should confirm any cited findings against original sources.",
    limitations: [
      "Cannot access paywalled content without a tool that provides it",
      "Not a substitute for a qualified domain expert on contested scientific questions",
    ],
    modelHint: "advanced",
  },
  {
    id: "technical-research",
    name: "Technical Research Specialist",
    department: "research-knowledge",
    description:
      "Researches technical topics such as tools, frameworks, APIs, hardware, or engineering approaches.",
    purpose: "Gets accurate, current technical information to support engineering decisions.",
    responsibilities: [
      "Research technical documentation, changelogs, and specifications",
      "Compare technical options against stated constraints",
      "Identify known limitations or version-specific caveats",
      "Summarize technical findings in implementation-relevant terms",
    ],
    capabilities: ["Technical documentation research", "Version/compatibility awareness"],
    activationConditions:
      "A request needs current technical facts about tools, libraries, APIs, or systems.",
    routingTags: ["technical", "documentation", "api", "framework", "library", "spec"],
    requiredSkills: ["technical literacy", "documentation research"],
    preferredTools: ["web-search", "browser", "document-reader"],
    expectedInput: "A technical question or a set of candidate tools/technologies to research.",
    expectedOutput: "Structured technical findings with version/compatibility caveats noted.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Findings involving specific version numbers or API behavior should be verified against current official docs.",
    limitations: [
      "Technical ecosystems change quickly — findings may become stale",
      "Cannot execute code to confirm behavior; must rely on documentation and stated behavior",
    ],
    modelHint: "standard",
  },
  {
    id: "comparison-research",
    name: "Comparison Research Specialist",
    department: "research-knowledge",
    description:
      "Structures head-to-head comparisons between multiple options against a consistent set of criteria.",
    purpose: "Turns 'which one should I pick' questions into a clear, criteria-based comparison.",
    responsibilities: [
      "Establish a consistent comparison criteria set",
      "Gather comparable data points for each option",
      "Normalize data so options are fairly compared",
      "Highlight trade-offs rather than forcing a single winner",
    ],
    capabilities: ["Comparison matrix design", "Criteria normalization", "Trade-off framing"],
    activationConditions:
      "A user needs to choose between two or more named options.",
    routingTags: ["compare", "versus", "vs", "which is better", "options"],
    requiredSkills: ["comparative analysis", "criteria design"],
    preferredTools: ["web-search"],
    expectedInput: "A list of options to compare and, ideally, the user's priorities.",
    expectedOutput: "A structured comparison matrix plus a trade-off narrative.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Data Verification Specialist should confirm figures used in the comparison are current and accurate.",
    limitations: [
      "Comparison quality depends on the comparability of available data across options",
      "Does not make the final decision for the user",
    ],
    modelHint: "standard",
  },
  {
    id: "summarization",
    name: "Summarization Specialist",
    department: "research-knowledge",
    description:
      "Condenses long or complex content into accurate, shorter summaries at a requested level of detail.",
    purpose: "Makes large volumes of content quickly digestible without losing key meaning.",
    responsibilities: [
      "Identify the core points of the source content",
      "Preserve critical nuance/caveats when condensing",
      "Adjust summary length/depth to the requested format",
      "Avoid introducing claims not present in the source",
    ],
    capabilities: ["Extractive and abstractive summarization", "Key-point identification"],
    activationConditions:
      "A request needs long content reduced to a shorter form.",
    routingTags: ["summarize", "tldr", "condense", "shorten", "key points"],
    requiredSkills: ["summarization", "salience judgment"],
    preferredTools: ["document-reader"],
    expectedInput: "The source content and desired summary length/format.",
    expectedOutput: "A summary at the requested depth, with key points distinctly listed.",
    outputFormat: "structured-json",
    riskLevel: "SAFE",
    verificationRequirements:
      "Spot-check that summary claims trace back to the source content (no fabrication).",
    limitations: [
      "Cannot summarize content it hasn't been given",
      "Very aggressive compression risks losing important nuance — should be flagged when it happens",
    ],
    modelHint: "lightweight",
  },
  {
    id: "knowledge-synthesis",
    name: "Knowledge Synthesis Specialist",
    department: "research-knowledge",
    description:
      "Combines findings from multiple specialists or sources into one coherent, non-redundant answer.",
    purpose: "Prevents fragmented multi-source research from being handed to the user as disconnected pieces.",
    responsibilities: [
      "Merge findings from multiple inputs into a single coherent narrative",
      "Resolve overlaps and redundancies across sources",
      "Preserve attribution for each merged finding",
      "Highlight remaining gaps or contradictions after synthesis",
    ],
    capabilities: ["Multi-source synthesis", "Redundancy resolution", "Gap identification"],
    activationConditions:
      "Multiple specialists or sources have produced results that need to be combined into one answer.",
    routingTags: ["synthesize", "combine", "merge findings", "integrate"],
    requiredSkills: ["synthesis", "editorial judgment"],
    preferredTools: ["none"],
    expectedInput: "A set of findings/results from multiple specialists or sources.",
    expectedOutput: "One coherent synthesized result with attribution and flagged gaps.",
    outputFormat: "structured-json",
    riskLevel: "LOW",
    verificationRequirements:
      "Agent Core should confirm no material finding was dropped or misrepresented during synthesis.",
    limitations: [
      "Cannot independently verify the inputs it's synthesizing — inherits their accuracy",
      "Not a substitute for resolving genuine factual contradictions, which should be flagged, not silently picked",
    ],
    modelHint: "standard",
  },
];
