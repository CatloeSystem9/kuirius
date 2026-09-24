/**
 * tests/specialistRegistry.test.ts
 *
 * Deterministic tests for the Krix specialist library: schema validity,
 * counts, uniqueness, retrieval, search, and routing.
 */
import { describe, it, expect } from "vitest";
import { ALL_SPECIALISTS } from "../specialistDefinitions";
import {
  SpecialistRegistry,
  SpecialistRegistryError,
} from "../specialistRegistry";
import { SpecialistRouter } from "../specialistRouter";
import {
  DEPARTMENTS,
  RISK_LEVELS,
  isValidKebabCase,
  validateSpecialistDefinition,
  type SpecialistDefinition,
  type SpecialistResult,
} from "../specialistTypes";
import {
  validateSpecialistResult,
  createEmptyResult,
  requiresFurtherVerification,
} from "../specialistResult";

const registry = new SpecialistRegistry();
const router = new SpecialistRouter(registry);

// ---------------------------------------------------------------------------
// 1. Exactly 100 specialists exist
// ---------------------------------------------------------------------------
describe("specialist count", () => {
  it("has exactly 100 specialists in ALL_SPECIALISTS", () => {
    expect(ALL_SPECIALISTS.length).toBe(100);
  });

  it("registry reports size 100", () => {
    expect(registry.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 2. Every specialist has a unique ID
// ---------------------------------------------------------------------------
describe("unique IDs", () => {
  it("has no duplicate IDs across all specialists", () => {
    const ids = ALL_SPECIALISTS.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// 3. Every specialist has a unique name
// ---------------------------------------------------------------------------
describe("unique names", () => {
  it("has no duplicate names across all specialists", () => {
    const names = ALL_SPECIALISTS.map((s) => s.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// 4. All 10 departments exist
// ---------------------------------------------------------------------------
describe("departments exist", () => {
  it("defines exactly 10 departments", () => {
    expect(DEPARTMENTS.length).toBe(10);
  });

  it("every specialist belongs to one of the 10 known departments", () => {
    for (const s of ALL_SPECIALISTS) {
      expect(DEPARTMENTS).toContain(s.department);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Every department contains exactly 10 specialists
// ---------------------------------------------------------------------------
describe("department counts", () => {
  it("has exactly 10 specialists per department", () => {
    const counts = registry.getDepartmentCounts();
    for (const dept of DEPARTMENTS) {
      expect(counts[dept]).toBe(10);
    }
  });

  it("sums to 100 across departments", () => {
    const counts = registry.getDepartmentCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 6. Every specialist has the required schema
// ---------------------------------------------------------------------------
describe("schema completeness", () => {
  it("every specialist passes schema validation with zero errors", () => {
    for (const s of ALL_SPECIALISTS) {
      const errors = validateSpecialistDefinition(s);
      expect(errors, `${s.id}: ${errors.join("; ")}`).toEqual([]);
    }
  });

  it("every specialist has 3-6 responsibilities", () => {
    for (const s of ALL_SPECIALISTS) {
      expect(s.responsibilities.length).toBeGreaterThanOrEqual(3);
      expect(s.responsibilities.length).toBeLessThanOrEqual(6);
    }
  });

  it("every specialist has at least one capability, limitation, and required skill", () => {
    for (const s of ALL_SPECIALISTS) {
      expect(s.capabilities.length).toBeGreaterThan(0);
      expect(s.limitations.length).toBeGreaterThan(0);
      expect(s.requiredSkills.length).toBeGreaterThan(0);
    }
  });

  it("every specialist declares structured-json output format", () => {
    for (const s of ALL_SPECIALISTS) {
      expect(s.outputFormat).toBe("structured-json");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. IDs are valid kebab-case
// ---------------------------------------------------------------------------
describe("ID formatting", () => {
  it("every ID is valid kebab-case", () => {
    for (const s of ALL_SPECIALISTS) {
      expect(isValidKebabCase(s.id), `Invalid ID: ${s.id}`).toBe(true);
    }
  });

  it("rejects invalid kebab-case examples", () => {
    expect(isValidKebabCase("Web-Research")).toBe(false);
    expect(isValidKebabCase("web_research")).toBe(false);
    expect(isValidKebabCase("web research")).toBe(false);
    expect(isValidKebabCase("-web-research")).toBe(false);
    expect(isValidKebabCase("web-research-")).toBe(false);
    expect(isValidKebabCase("web-research")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Routing tags exist
// ---------------------------------------------------------------------------
describe("routing tags", () => {
  it("every specialist has at least 3 routing tags", () => {
    for (const s of ALL_SPECIALISTS) {
      expect(s.routingTags.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Risk levels are valid
// ---------------------------------------------------------------------------
describe("risk levels", () => {
  it("every specialist has a valid risk level", () => {
    for (const s of ALL_SPECIALISTS) {
      expect(RISK_LEVELS).toContain(s.riskLevel);
    }
  });

  it("high-autonomy computer-operation specialists are rated HIGH or CRITICAL risk", () => {
    const computerOp = registry.getById("computer-operation");
    const browserOp = registry.getById("browser-operation");
    const filesystem = registry.getById("filesystem");
    expect(computerOp?.riskLevel).toBe("HIGH");
    expect(browserOp?.riskLevel).toBe("HIGH");
    expect(filesystem?.riskLevel).toBe("HIGH");
  });
});

// ---------------------------------------------------------------------------
// 10. Invalid specialist definitions are rejected
// ---------------------------------------------------------------------------
describe("invalid definitions are rejected", () => {
  it("validateSpecialistDefinition flags a definition missing required fields", () => {
    const bad: Partial<SpecialistDefinition> = { id: "broken-one" };
    const errors = validateSpecialistDefinition(bad);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("validateSpecialistDefinition flags an invalid department", () => {
    const bad = {
      ...ALL_SPECIALISTS[0],
      department: "not-a-real-department" as SpecialistDefinition["department"],
    };
    const errors = validateSpecialistDefinition(bad);
    expect(errors.some((e) => e.includes("department"))).toBe(true);
  });

  it("validateSpecialistDefinition flags an invalid risk level", () => {
    const bad = {
      ...ALL_SPECIALISTS[0],
      riskLevel: "EXTREME" as SpecialistDefinition["riskLevel"],
    };
    const errors = validateSpecialistDefinition(bad);
    expect(errors.some((e) => e.includes("Risk level"))).toBe(true);
  });

  it("validateSpecialistDefinition flags a bad kebab-case ID", () => {
    const bad = { ...ALL_SPECIALISTS[0], id: "Not Kebab Case" };
    const errors = validateSpecialistDefinition(bad);
    expect(errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  it("validateSpecialistDefinition flags too few responsibilities", () => {
    const bad = { ...ALL_SPECIALISTS[0], responsibilities: ["only one"] };
    const errors = validateSpecialistDefinition(bad);
    expect(errors.some((e) => e.includes("Responsibilities"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Specialists can be retrieved by ID
// ---------------------------------------------------------------------------
describe("retrieval by ID", () => {
  it("retrieves a known specialist by ID", () => {
    const s = registry.getById("web-research");
    expect(s).not.toBeNull();
    expect(s?.name).toBe("Web Research Specialist");
  });

  it("returns null for an unknown ID", () => {
    expect(registry.getById("does-not-exist")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 12. Specialists can be searched by department
// ---------------------------------------------------------------------------
describe("search by department", () => {
  it("returns exactly the 10 engineering specialists for that department", () => {
    const results = registry.getByDepartment("software-engineering");
    expect(results.length).toBe(10);
    expect(results.every((s) => s.department === "software-engineering")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. Specialists can be searched by capability
// ---------------------------------------------------------------------------
describe("search by capability", () => {
  it("finds specialists whose capabilities/description mention 'debug'", () => {
    const results = registry.searchByCapability("debug");
    const ids = results.map((s) => s.id);
    expect(ids).toContain("debugging");
  });

  it("returns an empty array for a nonsense query", () => {
    const results = registry.searchByCapability("zzzznonexistentcapabilityzzzz");
    expect(results).toEqual([]);
  });

  it("returns empty array for empty query", () => {
    expect(registry.searchByCapability("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 14. Specialists can be matched using routing tags
// ---------------------------------------------------------------------------
describe("tag matching", () => {
  it("matches specialists by exact tag", () => {
    const results = registry.getByTag("security");
    expect(results.some((s) => s.id === "security-review")).toBe(true);
  });

  it("matchByTags ranks specialists with more matching tags higher", () => {
    const ranked = registry.matchByTags(["debug", "bug", "error"]);
    expect(ranked.length).toBeGreaterThan(0);
    // scores should be non-increasing
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].matchCount).toBeGreaterThanOrEqual(ranked[i].matchCount);
    }
  });

  it("matchByTags is case-insensitive", () => {
    const lower = registry.matchByTags(["security"]);
    const upper = registry.matchByTags(["SECURITY"]);
    expect(lower.map((r) => r.specialist.id)).toEqual(upper.map((r) => r.specialist.id));
  });
});

// ---------------------------------------------------------------------------
// 15. Multi-specialist selection works
// ---------------------------------------------------------------------------
describe("multi-specialist routing", () => {
  it("routes a laptop comparison request to research/comparison/data specialists", () => {
    const candidates = router.route(
      "Research three laptops, compare their specifications, and analyze which one best matches my requirements"
    );
    const ids = candidates.map((c) => c.specialist.id);
    expect(ids.length).toBeGreaterThan(0);
    // Should surface at least one of the clearly relevant specialists.
    const relevant = ["web-research", "comparison-research", "data-analysis"];
    expect(relevant.some((id) => ids.includes(id))).toBe(true);
  });

  it("routes a crashing-application request toward troubleshooting/debugging", () => {
    const candidates = router.route("Find out why this application keeps crashing");
    const ids = candidates.map((c) => c.specialist.id);
    expect(
      ["desktop-troubleshooting", "debugging", "troubleshooting"].some((id) => ids.includes(id))
    ).toBe(true);
  });

  it("routeMultiDepartment spreads results across multiple departments", () => {
    const candidates = router.routeMultiDepartment(
      "Build a small website with a frontend, test it, and review the code for security issues"
    );
    const departments = new Set(candidates.map((c) => c.specialist.department));
    expect(departments.size).toBeGreaterThan(1);
  });

  it("route() respects maxResults", () => {
    const candidates = router.route("research plan analysis verify writing translate", {
      maxResults: 3,
    });
    expect(candidates.length).toBeLessThanOrEqual(3);
  });

  it("route() can filter by maxRiskLevel", () => {
    const candidates = router.route("click the button and type into the form on screen", {
      maxRiskLevel: "LOW",
    });
    expect(candidates.every((c) => ["SAFE", "LOW"].includes(c.specialist.riskLevel))).toBe(true);
  });

  it("route() can filter by department", () => {
    const candidates = router.route("help me write and edit some content", {
      departments: ["writing-communication"],
    });
    expect(candidates.every((c) => c.specialist.department === "writing-communication")).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// 16. Duplicate IDs are rejected
// ---------------------------------------------------------------------------
describe("duplicate ID rejection", () => {
  it("throws when constructing a registry with duplicate IDs", () => {
    const duplicated: SpecialistDefinition[] = [ALL_SPECIALISTS[0], ALL_SPECIALISTS[0]];
    expect(() => new SpecialistRegistry(duplicated)).toThrow(SpecialistRegistryError);
  });

  it("throws when constructing a registry with duplicate names but different IDs", () => {
    const clone: SpecialistDefinition = {
      ...ALL_SPECIALISTS[1],
      id: "a-totally-different-id",
      name: ALL_SPECIALISTS[1].name, // duplicate name on purpose
    };
    const withDupeName = [ALL_SPECIALISTS[0], ALL_SPECIALISTS[1], clone];
    expect(() => new SpecialistRegistry(withDupeName)).toThrow(SpecialistRegistryError);
  });
});

// ---------------------------------------------------------------------------
// 17. Malformed definitions are rejected
// ---------------------------------------------------------------------------
describe("malformed definition rejection", () => {
  it("throws when a specialist is missing required fields", () => {
    const malformed = { id: "malformed-one" } as unknown as SpecialistDefinition;
    expect(() => new SpecialistRegistry([malformed])).toThrow(SpecialistRegistryError);
  });

  it("throws when a specialist has an invalid risk level", () => {
    const malformed: SpecialistDefinition = {
      ...ALL_SPECIALISTS[0],
      id: "bad-risk-specialist",
      name: "Bad Risk Specialist Unique Name",
      riskLevel: "EXTREME" as SpecialistDefinition["riskLevel"],
    };
    expect(() => new SpecialistRegistry([malformed])).toThrow(SpecialistRegistryError);
  });

  it("throws when a specialist has a non-kebab-case ID", () => {
    const malformed: SpecialistDefinition = {
      ...ALL_SPECIALISTS[0],
      id: "Bad ID Format",
      name: "Bad ID Specialist Unique Name",
    };
    expect(() => new SpecialistRegistry([malformed])).toThrow(SpecialistRegistryError);
  });
});

// ---------------------------------------------------------------------------
// Bonus: specialist result structure validation
// ---------------------------------------------------------------------------
describe("specialist result schema", () => {
  it("createEmptyResult produces a valid result skeleton", () => {
    const result = createEmptyResult("web-research", "SUCCESS");
    expect(validateSpecialistResult(result)).toEqual([]);
  });

  it("validateSpecialistResult rejects an out-of-range confidence", () => {
    const result = { ...createEmptyResult("web-research", "SUCCESS"), confidence: 1.5 };
    const errors = validateSpecialistResult(result);
    expect(errors.some((e) => e.includes("confidence"))).toBe(true);
  });

  it("validateSpecialistResult rejects an invalid status", () => {
    const result = {
      ...createEmptyResult("web-research", "SUCCESS"),
      status: "MAYBE" as unknown as SpecialistResult["status"],
    };
    const errors = validateSpecialistResult(result);
    expect(errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("requiresFurtherVerification is true for UNCERTAIN status", () => {
    const result = createEmptyResult("fact-checking", "UNCERTAIN");
    expect(requiresFurtherVerification(result)).toBe(true);
  });

  it("requiresFurtherVerification is false for a clean SUCCESS with no pending verification", () => {
    const result = createEmptyResult("summarization", "SUCCESS");
    expect(requiresFurtherVerification(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bonus: preferredTools never includes an implementation, only capability names
// ---------------------------------------------------------------------------
describe("specialist vs tool separation", () => {
  const allowedTools = new Set([
    "browser",
    "filesystem",
    "screen-vision",
    "keyboard",
    "mouse",
    "code-execution",
    "document-reader",
    "web-search",
    "data-analysis",
    "spreadsheet-engine",
    "image-analysis",
    "video-analysis",
    "clipboard",
    "terminal",
    "version-control",
    "calendar",
    "none",
  ]);

  it("every preferredTools entry is a recognized generic capability name", () => {
    for (const s of ALL_SPECIALISTS) {
      for (const tool of s.preferredTools) {
        expect(allowedTools.has(tool), `${s.id} has unrecognized tool "${tool}"`).toBe(true);
      }
    }
  });

  it("every specialist's limitations mention what it cannot do (non-empty, non-trivial)", () => {
    for (const s of ALL_SPECIALISTS) {
      for (const limitation of s.limitations) {
        expect(limitation.length).toBeGreaterThan(10);
      }
    }
  });
});
