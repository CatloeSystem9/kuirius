/**
 * Computer control types (Phase 5) — mouse/cursor layer.
 *
 * The browser cannot move the OS cursor; real control runs on Krisha's local
 * Express server via a pluggable MouseBackend (PowerShell/user32 on Windows).
 * Tests use a deterministic fake backend. No keyboard control here (Phase 6).
 */

export interface Point {
  x: number;
  y: number;
}

export interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ClickKind = 'left' | 'double' | 'right';

/** Classified backend failures. */
export type ControlErrorKind =
  | 'permission_denied'
  | 'invalid_coordinates'
  | 'target_unreliable'
  | 'target_not_found'
  | 'unsupported_capture_region'
  | 'backend_failed'
  | 'backend_unavailable'
  | 'timeout'
  | 'cancelled';

export class ControlError extends Error {
  kind: ControlErrorKind;
  retryable: boolean;
  constructor(kind: ControlErrorKind, message: string, retryable = false) {
    super(message);
    this.name = 'ControlError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

export interface MouseActionRecord {
  action: 'move' | 'click' | 'scroll' | 'drag';
  at: { x: number; y: number };
  detail?: string;
  timestamp: number;
}

/**
 * Pluggable OS mouse backend. Implementations must report the cursor's final
 * position where possible so the service can verify movement honestly.
 */
export interface MouseBackend {
  getPosition(): Promise<Point>;
  getScreenBounds(): Promise<ScreenBounds>;
  move(x: number, y: number): Promise<Point>;
  click(x: number, y: number, kind: ClickKind): Promise<void>;
  scroll(x: number, y: number, deltaY: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<Point>;
}

/** A semantically identified target from screen vision (spec §4–5). */
export interface SemanticTarget {
  text?: string;
  type?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  confidence?: number;
}

export interface TargetInput {
  /** Semantic target (preferred) — resolved through screen vision. */
  target?: SemanticTarget;
  /** Raw screen coordinates (last resort, spec §5). */
  coordinates?: Point;
  /** State id the target was identified from (staleness checking). */
  stateId?: string;
  /** Verify through screen observation after the action (default: true). */
  verify?: boolean;
  /** Settle time before the verification capture (ms, max 1000). */
  settleMs?: number;
}

export interface DragInput extends Omit<TargetInput, 'target' | 'coordinates'> {
  from?: SemanticTarget | Point;
  to?: SemanticTarget | Point;
}

export interface ScrollInput extends Omit<TargetInput, 'target' | 'coordinates'> {
  direction?: 'up' | 'down';
  amount?: number;
  deltaY?: number;
  coordinates?: Point;
}

/** Evidence from post-action screen verification (Phase 4 integration). */
export interface VerificationEvidence {
  strategy: 'screen_state_change' | 'self_reported';
  verified: boolean;
  changedFraction?: number;
  regions?: number;
  note?: string;
}

export interface MouseActionResult {
  action: 'move' | 'click' | 'double_click' | 'right_click' | 'scroll' | 'drag';
  intended: Point;
  final: Point;
  target?: {
    source: 'semantic_element' | 'semantic_text' | 'coordinates';
    text?: string;
    type?: string;
    confidence?: number;
    bounds?: { x: number; y: number; width: number; height: number };
    capturedAt?: number;
    reidentified?: boolean;
  };
  screenBounds: ScreenBounds;
  verification: VerificationEvidence;
  activeWindow?: { title?: string; surface?: string; available: boolean };
  summary: string;
}
