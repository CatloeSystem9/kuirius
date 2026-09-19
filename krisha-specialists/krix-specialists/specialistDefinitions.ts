/**
 * specialistDefinitions.ts
 *
 * Aggregates all 100 specialist definitions from the department files into
 * a single flat array. This is the single source of truth the registry
 * loads from.
 */
import type { SpecialistDefinition } from "./specialistTypes";
import { productivitySpecialists } from "./departments/productivity";
import { researchSpecialists } from "./departments/research";
import { computerSpecialists } from "./departments/computer";
import { engineeringSpecialists } from "./departments/engineering";
import { securitySpecialists } from "./departments/security";
import { writingSpecialists } from "./departments/writing";
import { businessSpecialists } from "./departments/business";
import { dataSpecialists } from "./departments/data";
import { multimodalSpecialists } from "./departments/multimodal";
import { learningSpecialists } from "./departments/learning";

export const ALL_SPECIALISTS: SpecialistDefinition[] = [
  ...productivitySpecialists, // Department 1 (10)
  ...researchSpecialists, // Department 2 (10)
  ...computerSpecialists, // Department 3 (10)
  ...engineeringSpecialists, // Department 4 (10)
  ...securitySpecialists, // Department 5 (10)
  ...writingSpecialists, // Department 6 (10)
  ...businessSpecialists, // Department 7 (10)
  ...dataSpecialists, // Department 8 (10)
  ...multimodalSpecialists, // Department 9 (10)
  ...learningSpecialists, // Department 10 (10)
];

export {
  productivitySpecialists,
  researchSpecialists,
  computerSpecialists,
  engineeringSpecialists,
  securitySpecialists,
  writingSpecialists,
  businessSpecialists,
  dataSpecialists,
  multimodalSpecialists,
  learningSpecialists,
};
