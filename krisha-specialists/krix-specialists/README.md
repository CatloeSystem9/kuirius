# krix-specialists

A standalone, implementation-ready library of **100 specialist AI agent
definitions** for **Krix**, an AI assistant intended to eventually operate a
computer autonomously.

This package is **not integrated into Krix**. It is a self-contained
registry that can later be copied or imported into the real Krix
repository. See [Section 11](#11-future-krix-integration) for what that
would involve.

---

## 1. What is Krix?

Krix is an AI assistant designed to eventually operate a computer
autonomously, following a capability chain:

```
SEEING → UNDERSTANDING → THINKING → PLANNING → CLICKING → TYPING
  → USING WEBSITES → USING APPLICATIONS → WORKING WITH FILES
  → VERIFYING → LEARNING → ADAPTING → COMPLETING TASKS
```

At the center of Krix sits the **Agent Core** — the main brain. The Agent
Core understands a user's request, decides what's needed, executes actions
through tools, and verifies results.

## 2. What are specialist agents?

A **specialist** is not a separate AI system. It is a **lightweight,
structured definition** — identity, purpose, responsibilities, expected
input/output, risk level, and routing metadata — that tells the Agent Core
*when* and *how* to draw on a particular kind of expertise.

Specialists provide **reasoning and expertise**. They do not act on the
world themselves. See [Section 8](#8-specialist-vs-tool).

## 3. Why 100 specialists?

Because the range of tasks Krix will eventually face — research, coding,
computer operation, writing, business analysis, data work, multimodal
understanding, and more — is broad enough that a single generic "assistant"
persona reasons less precisely than a set of well-scoped specialists. 100
was chosen to give meaningful coverage across 10 clearly distinct
departments (10 specialists each) without descending into meaningless
variations like "Research Agent 1/2/3." Every specialist here has a
distinct, non-overlapping core purpose.

## 4. Why not 100 separate LLMs?

Specialists are **static structured data**, not running processes. There
are no background workers, no always-on agents, no 100 parallel model
instances, and no swarm. At rest, this library is just TypeScript objects.
A specialist only "does something" when the Agent Core selects it and
sends its definition (plus task context) as part of a single prompt to
whatever model is appropriate for that task — see
[Section 9](#9-model-agnostic-design).

## 5. Directory structure

```
krix-specialists/
│
├── README.md                     ← this file
├── package.json
├── tsconfig.json                 ← standard build config
├── tsconfig.test.json            ← local, offline test-run config (see Section 13)
│
├── specialistTypes.ts            ← universal schema + validation helpers
├── specialistDefinitions.ts      ← aggregates all 100 specialists into one array
├── specialistRegistry.ts         ← in-memory registry: load, validate, index, retrieve
├── specialistRouter.ts           ← lightweight keyword-based routing
├── specialistResult.ts           ← universal specialist-result schema + helpers
│
├── departments/
│   ├── productivity.ts           ← Dept 1: Productivity & Execution      (10)
│   ├── research.ts               ← Dept 2: Research & Knowledge          (10)
│   ├── computer.ts               ← Dept 3: Computer & Digital Operations (10)
│   ├── engineering.ts            ← Dept 4: Software Engineering          (10)
│   ├── security.ts               ← Dept 5: Security, Safety & Quality    (10)
│   ├── writing.ts                ← Dept 6: Writing & Communication       (10)
│   ├── business.ts               ← Dept 7: Business & Strategy           (10)
│   ├── data.ts                   ← Dept 8: Data & Analytics              (10)
│   ├── multimodal.ts             ← Dept 9: Multimodal & Reasoning        (10)
│   └── learning.ts               ← Dept 10: Language, Learning & Support (10)
│
└── tests/
    ├── specialistRegistry.test.ts   ← the real, deterministic test suite
    └── _local-harness/              ← offline-only vitest-API shim (see Section 13)
```

## 6. The universal specialist schema

Every specialist (`specialistTypes.ts` → `SpecialistDefinition`) has:

| Field | Purpose |
|---|---|
| `id` | Stable, unique, kebab-case identifier (e.g. `web-research`) |
| `name` | Human-readable name |
| `department` | One of the 10 departments |
| `description` / `purpose` | What it does and why it exists |
| `responsibilities` (3–6) | Concrete duties |
| `capabilities` | What it can reason about |
| `activationConditions` | When the Agent Core should consider it |
| `routingTags` | Keywords for lightweight routing |
| `requiredSkills` | Expertise areas it draws on |
| `preferredTools` | **Generic capability names** it would use if granted (browser, filesystem, screen-vision, etc.) — never a specific implementation |
| `expectedInput` / `expectedOutput` | Interface contract with the Agent Core |
| `outputFormat` | Always `"structured-json"` |
| `riskLevel` | `SAFE` / `LOW` / `MEDIUM` / `HIGH` / `CRITICAL` |
| `verificationRequirements` | How the Agent Core should check the result |
| `limitations` | Explicit statement of what it must **not** claim to do |
| `modelHint` *(optional)* | Suggested model class for future routing |

`specialistTypes.ts` also exports `validateSpecialistDefinition()`, used by
the registry to reject malformed data at load time — the registry never
silently accepts an invalid specialist.

## 7. The universal result schema

Specialists don't return free-form prose to the Agent Core. They return a
`SpecialistResult` (`specialistTypes.ts` / helpers in `specialistResult.ts`):

```ts
{
  specialistId,
  status,              // SUCCESS | PARTIAL | UNCERTAIN | FAILED | REQUIRES_VERIFICATION
  summary,
  findings: [{ label, detail, source? }],
  recommendations,
  evidence,
  confidence,           // 0–1
  uncertainties,
  requiredVerification,
  errors,
}
```

`specialistResult.ts` provides `createEmptyResult()`,
`validateSpecialistResult()`, and `requiresFurtherVerification()` — a
convenience check the Agent Core can use to decide whether a result needs
another pass before being trusted.

## 8. Specialist vs. Tool

This distinction is enforced throughout the library:

- A **tool** performs an action (clicks, types, reads a file, runs code).
- A **specialist** provides expertise/reasoning about *what* to do and *how*.

Example: **Browser Operation Specialist** does not have browser access. It
plans navigation and interaction steps. Actual clicking/typing happens only
through a `browser` tool that Krix supplies, invoked by the Agent Core.

Every specialist's `limitations` array makes this explicit — e.g. the
Filesystem Specialist's limitations state it "has no direct filesystem
access itself — only plans operations." No specialist's definition or
description implies it can act unilaterally.

## 9. Model-agnostic design

No specialist definition names a specific LLM. Each optionally carries a
`modelHint` (`lightweight | standard | advanced | coding | vision`) — a
hint for a future routing layer to pick an appropriately capable model per
task (e.g. `lightweight` for language detection, `coding` for backend
development, `vision` for screen analysis). The routing/model-selection
system itself is **not implemented here** — only the compatibility hooks
are.

## 10. Routing architecture

`specialistRouter.ts` implements a deliberately simple, dependency-free
router:

1. Extract lowercase keywords (and bigrams) from the request text.
2. Match extracted keywords against each specialist's `routingTags`
   (exact match first, with a conservative prefix-stem fallback so
   "crashing" still matches the tag "crash").
3. Rank specialists by number of matching tags.
4. Optionally filter by max risk level or department.

```
USER REQUEST
      ↓
extractKeywords()
      ↓
registry.matchByTags()
      ↓
ranked RoutingCandidate[]
      ↓
Agent Core makes the final call
```

This is a **first-pass filter**, not a decision-maker. No embeddings, no
vector database, no ML model — just structured data plus indexing.
`route()` returns top candidates; `routeMultiDepartment()` spreads
candidates across departments for requests that plausibly need several
kinds of expertise at once (see the worked examples in
`specialistRouter.ts`'s tests).

The Agent Core always makes the final orchestration decision. The router
only narrows the field.

## 11. Multi-specialist cooperation

Specialists communicate only through structured `SpecialistResult` objects,
handed back to the Agent Core, which decides what happens next:

```
Agent Core
   ↓
Research Specialist        → SpecialistResult
   ↓
Fact Checking Specialist   → SpecialistResult
   ↓
Comparison Research        → SpecialistResult
   ↓
Output Quality Specialist  → SpecialistResult
   ↓
Agent Core (final decision)
```

There is no direct specialist-to-specialist conversation and no loops.
Every hop passes through the Agent Core, which prevents runaway chains and
keeps orchestration auditable.

## 12. Safety & permissions

Every specialist:

- Has an explicit `riskLevel`. Specialists that plan real-world or
  irreversible actions (`computer-operation`, `browser-operation`,
  `filesystem`, `database`, `safety`, `security-review`,
  `permission-control`) are rated `HIGH` or `CRITICAL`.
- States in `verificationRequirements` how the Agent Core should check its
  output before trusting it.
- States in `limitations` what it explicitly cannot or must not claim to
  do — including that it has no inherent tool access.

Actual execution of any action always remains under the Agent Core's
control and Krix's future tool/permission system. No specialist can bypass
that.

Business/finance specialists (Department 7) are explicitly scoped to
information, analysis, research, and strategy — none of them are designed
to execute financial transactions.

## 13. Tests

`tests/specialistRegistry.test.ts` is the real, deterministic test suite,
written against the standard [vitest](https://vitest.dev) API
(`describe` / `it` / `expect`). It verifies, among other things:

- Exactly 100 specialists exist, each with a unique ID and name
- All 10 departments exist with exactly 10 specialists each
- Every specialist satisfies the full schema (responsibilities count,
  required arrays, valid risk level, valid kebab-case ID, ≥3 routing tags)
- Invalid/malformed specialist definitions are rejected by the registry
  (duplicate IDs, duplicate names, missing fields, bad risk levels, bad ID
  format)
- Specialists can be retrieved by ID, searched by department, searched by
  capability text, and matched by routing tag
- Multi-specialist routing produces sensible results for realistic
  multi-part requests
- The universal `SpecialistResult` schema is validated correctly
- `preferredTools` only ever contains recognized generic capability names,
  never a specific product/implementation

**In a normal environment with npm registry access**, run:

```bash
npm install
npm run test        # runs the real vitest suite
npm run typecheck    # tsc --noEmit
```

**In this sandbox**, the npm registry is unreachable (`bash_tool` has no
network access), so `vitest` could not be installed. To still *actually
execute* the exact same test file rather than just eyeballing it, a small
dependency-free shim implementing the subset of the vitest API the test
file uses (`describe`, `it`, `expect(...).toBe/toEqual/toContain/...`,
`toThrow`) was added at `tests/_local-harness/vitest.ts`, wired in via a
`node_modules/vitest` shim and `tsconfig.test.json`. This is a sandbox-only
workaround — `specialistRegistry.test.ts` itself is completely standard and
untouched by it; delete `tests/_local-harness/` and `tsconfig.test.json`
once real `vitest` is installable.

### Test run results (this sandbox, via the local harness)

```
Passed: 49
Failed: 0
Total:  49
```

The suite caught and led to two real fixes during development:

1. `Debugging Specialist`'s description didn't contain the word "debug",
   so capability-text search missed it — description text was corrected.
2. The router's exact-tag matching didn't handle simple morphological
   variants ("crashing" vs. the tag "crash"), so a natural-language query
   about a crashing app failed to surface
   `desktop-troubleshooting`/`debugging` — a conservative prefix-stem
   fallback was added to `matchByTags()`.

## 14. Adding specialist #101

1. Decide which department it belongs to (or propose an 11th department —
   not done here, since the brief fixed 10×10).
2. Add a new `SpecialistDefinition` object to the relevant
   `departments/*.ts` file, following the existing schema exactly.
3. Give it a new, unique, kebab-case `id` and a unique `name`.
4. Run the test suite — `SpecialistRegistry`'s constructor will throw
   immediately if the new entry is malformed, duplicates an ID/name, or is
   missing required fields, so problems surface at load time, not runtime.
5. Update `specialistDefinitions.ts` only if a brand-new department array
   was introduced (existing department arrays are already spread into
   `ALL_SPECIALISTS`).

## 15. Future Krix integration

This library is intentionally self-contained so it can be dropped into the
real Krix repository later. Conceptually, it would sit here:

```
Krix
│
├── Agent Core
│     │
│     ├── Specialist Router  ← specialistRouter.ts + specialistRegistry.ts
│     │       │
│     │       ├── Research Specialists     ← departments/research.ts
│     │       ├── Engineering Specialists  ← departments/engineering.ts
│     │       ├── Computer Specialists     ← departments/computer.ts
│     │       ├── Security Specialists     ← departments/security.ts
│     │       └── ... (6 more departments)
│     │
│     ├── Tool Registry       ← NOT part of this package; Krix supplies
│     │                          the actual browser/filesystem/screen-vision/
│     │                          etc. implementations that specialists'
│     │                          `preferredTools` names refer to
│     ├── Memory
│     ├── Vision
│     ├── Browser Agent
│     ├── Computer-Use Agent
│     ├── Filesystem/Application Agent
│     └── Error Recovery
│
└── User
```

**What this package provides:** the specialist definitions, registry,
router, and result schema — pure structured data and lightweight logic
with zero Krix-specific dependencies.

**What integration would still require (not built here, per the brief):**

- Wiring `specialistRegistry.ts` / `specialistRouter.ts` into the real
  Agent Core's orchestration loop.
- Implementing the actual tools referenced by `preferredTools` (a real
  `browser`, `filesystem`, `screen-vision`, `code-execution`, etc.) and a
  permission system that enforces each specialist's stated `riskLevel` and
  `verificationRequirements`.
- Implementing the model-routing layer that uses each specialist's
  `modelHint` to pick an actual model/provider per invocation.
- Deciding how specialist prompts are actually constructed from a
  `SpecialistDefinition` (this package defines the *data*, not the prompt
  templates) and how a model's free-text output gets parsed into a
  `SpecialistResult`.
- Persistent logging/auditing of specialist invocations for the
  verification/safety requirements each specialist declares.
- Real `vitest` in the Krix repo's own toolchain (this package's sandbox
  workaround should not be carried over — see Section 13).

## 16. Limitations of this library, as built

- It is data plus lightweight logic. It has never been exercised against a
  real Krix Agent Core, real tools, or a real model — behavioral
  correctness of routing/selection in production is unverified beyond
  what the test suite covers.
- The keyword-based router is intentionally simple; it will under-match on
  requests that don't share vocabulary with any specialist's routing tags.
  It's a first-pass filter, not a substitute for the Agent Core's own
  judgment.
- `preferredTools` names generic capabilities only — none of these tools
  are implemented in this package, by design (see Section 20 of the
  original brief: no fake capabilities).
- The test suite runs in this sandbox via a local, dependency-free shim
  because the npm registry was unreachable; it has not been run against
  the real `vitest` package.
