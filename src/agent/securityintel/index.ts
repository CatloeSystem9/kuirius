/**
 * Security Intelligence, Correlation and Response Readiness (Phase E).
 *
 * Public surface of the additive intelligence layer. Everything here is
 * LOCAL, metadata-only, bounded, read-only or recommendation-only:
 *  - SecurityEventIntel (E.1): normalized events from existing subsystems.
 *  - CorrelationEngine (E.2): evidence-linked, time-bounded relationships.
 *  - AssessmentEngine (E.3): severity/confidence-separated assessments.
 *  - SecuritySituation (E.4): read-only dependency health view.
 *  - ResponseRecommender (E.5): safe recommendations, never authorization.
 *
 * NODE-ONLY module (crypto for ids): imported by server.ts and tests only.
 * The browser-safe tool wrappers live in tools.ts.
 */
export * from './eventTypes';
export { SecurityEventIntel } from './intel';
export { CorrelationEngine, type CorrelationResult, type CorrelationWindows } from './correlation';
export {
  AssessmentEngine,
  type ThreatAssessment,
  type AssessmentSeverity,
  type AssessmentConfidenceLabel,
  type RecommendedActionHint,
  type AssessmentOptions,
} from './assessment';
export {
  SecuritySituation,
  type SecuritySituationView,
  type SituationSources,
  type SituationComponent,
  type ComponentState,
  type MonitorStatusLike,
  type DetectionHealthLike,
  type ExecGateHealthLike,
  type StopSnapshotLike,
  type E5StorageLike,
  type ContainmentAuthorityLike,
  type LpvStatusLike,
} from './situation';
export {
  ResponseRecommender,
  ALLOWED_ACTIONS,
  FORBIDDEN_ACTIONS,
  type ResponseRecommendation,
  type SafeResponseAction,
  type ApprovalAvailability,
  type RecommendationOptions,
} from './response';
