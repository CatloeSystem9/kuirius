/**
 * Deterministic fake mouse backend for automated tests (Phase 5).
 * Maintains cursor state in memory, records every action, and can simulate
 * transient failures and hangs. No OS interaction.
 */
import type { ClickKind, MouseBackend, Point, ScreenBounds } from './mouseTypes';
import { ControlError } from './mouseTypes';

export class FakeMouseBackend implements MouseBackend {
  bounds: ScreenBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  position: Point = { x: 960, y: 540 };
  actions: MouseActionRecordLike[] = [];
  /** Remaining transient failures before calls succeed again. */
  transientFailures = 0;
  /** When > 0, the next call hangs for this many ms then rejects with timeout. */
  hangMs = 0;

  getPosition(): Promise<Point> {
    return this.guard(async () => this.position);
  }

  getScreenBounds(): Promise<ScreenBounds> {
    return this.guard(async () => this.bounds);
  }

  /** When set, move() reports this offset from the target (simulates OS drift). */
  moveOffset: Point | null = null;

  async move(x: number, y: number): Promise<Point> {
    await this.guard(async () => null);
    const final = this.moveOffset ? { x: x + this.moveOffset.x, y: y + this.moveOffset.y } : { x, y };
    this.position = final;
    this.actions.push({ action: 'move', at: { ...final }, timestamp: Date.now() });
    return { ...this.position };
  }

  async click(x: number, y: number, kind: ClickKind): Promise<void> {
    await this.guard(async () => null);
    this.position = { x, y };
    this.actions.push({ action: 'click', at: { x, y }, detail: kind, timestamp: Date.now() });
  }

  async scroll(x: number, y: number, deltaY: number): Promise<void> {
    await this.guard(async () => null);
    this.position = { x, y };
    this.actions.push({ action: 'scroll', at: { x, y }, detail: `delta:${deltaY}`, timestamp: Date.now() });
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<Point> {
    await this.guard(async () => null);
    this.position = { x: toX, y: toY };
    this.actions.push({ action: 'drag', at: { x: toX, y: toY }, detail: `from:${fromX},${fromY}`, timestamp: Date.now() });
    return { ...this.position };
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    if (this.hangMs > 0) {
      const wait = this.hangMs;
      this.hangMs = 0;
      await new Promise((_, reject) => setTimeout(() => reject(new ControlError('timeout', 'Fake backend hang', true)), wait));
    }
    if (this.transientFailures > 0) {
      this.transientFailures--;
      throw new ControlError('backend_failed', 'Transient backend failure', true);
    }
    return fn();
  }
}

interface MouseActionRecordLike {
  action: 'move' | 'click' | 'scroll' | 'drag';
  at: Point;
  detail?: string;
  timestamp: number;
}
