/**
 * Permission Manager (Phase 3).
 *
 * Tools declare the permission domains they need; the manager tracks what is
 * currently granted and exposes policy hooks (confirmation thresholds) that
 * later phases (18) will enforce with real confirmation UI.
 * Defaults are conservative: capabilities that exist today (browser tabs,
 * reading indexed files, launching apps via protocol, location, memory) are
 * granted; everything touching the desktop or recording hardware is denied
 * until its phase arrives.
 */
import type { ToolPermission, ToolRiskLevel } from './types';

export const RISK_ORDER: Record<ToolRiskLevel, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const ALL_PERMISSIONS: ToolPermission[] = [
  'screen.observation',
  'mouse.control',
  'keyboard.control',
  'browser.interaction',
  'filesystem.read',
  'filesystem.write',
  'application.launch',
  'terminal.execution',
  'camera.access',
  'microphone.access',
  'location.access',
  'memory.access',
  // LPV (Local Private Vault): the MODEL is default-deny on both domains.
  // Management is the operator UI's own authority (server-side baseline);
  // retrieval is only ever satisfied by approval-issued single-use grants.
  'vault.manage',
  'vault.retrieve',
];

export type PermissionGrants = Partial<Record<ToolPermission, boolean>>;

function defaultGrants(): PermissionGrants {
  return {
    'browser.interaction': true,
    'filesystem.read': true,
    'application.launch': true,
    'location.access': true,
    'memory.access': true,
    'screen.observation': false,
    'mouse.control': false,
    'keyboard.control': false,
    'filesystem.write': false,
    'terminal.execution': false,
    'camera.access': false,
    'microphone.access': false,
    'vault.manage': false,
    'vault.retrieve': false,
  };
}

export class PermissionManager {
  private grants: Map<ToolPermission, boolean>;
  /** Risks at/above this level require user confirmation before execution. */
  confirmationThreshold: ToolRiskLevel = 'high';

  constructor(initial?: PermissionGrants) {
    this.grants = new Map(Object.entries({ ...defaultGrants(), ...(initial ?? {}) }) as [ToolPermission, boolean][]);
  }

  isGranted(permission: ToolPermission): boolean {
    return this.grants.get(permission) === true;
  }

  /** True when the id is a known permission domain (Phase 18 fail-closed support). */
  isKnown(permission: string): boolean {
    return (ALL_PERMISSIONS as string[]).includes(permission);
  }

  grant(permission: ToolPermission): void {
    this.grants.set(permission, true);
  }

  revoke(permission: ToolPermission): void {
    this.grants.set(permission, false);
  }

  /** All missing permissions for a requested set. */
  missing(permissions: ToolPermission[] | undefined): ToolPermission[] {
    return (permissions ?? []).filter((p) => !this.isGranted(p));
  }

  list(): { permission: ToolPermission; granted: boolean }[] {
    return ALL_PERMISSIONS.map((permission) => ({ permission, granted: this.isGranted(permission) }));
  }

  /** Policy hook: would this risk level require user confirmation? (Phase 18 enforces.) */
  requiresConfirmation(riskLevel: ToolRiskLevel): boolean {
    return RISK_ORDER[riskLevel] >= RISK_ORDER[this.confirmationThreshold];
  }
}
