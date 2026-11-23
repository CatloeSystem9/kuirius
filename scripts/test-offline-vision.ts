/**
 * Offline-vision enforcement test — proves the ScreenObserver offline
 * guarantee: with offlineVision ON (default), an explicit analyze:'cloud'
 * request NEVER reaches a cloud provider (downgraded to local + event
 * emitted); with it OFF, cloud runs normally.
 */
import { ScreenObserver } from '../src/agent/vision/screenObserver';
import { AgentEventBus } from '../src/agent/events';
import { solidFrame } from '../src/agent/vision/fakeCapture';
import type { ActiveWindowInfo, CaptureSource, CapturedFrame, VisionAnalysis, VisionProvider } from '../src/agent/vision/visionTypes';

class StaticCaptureSource implements CaptureSource {
  async capture(): Promise<CapturedFrame> {
    return solidFrame(64, 48, 40);
  }
  getActiveWindowInfo(): ActiveWindowInfo {
    return { available: true, title: 'Test Window', surface: 'window', source: 'display_media_track' };
  }
  stop(): void {}
}

const cloudCalls: { count: number } = { count: 0 };
const cloudProvider: VisionProvider = {
  name: 'fake_cloud (must never run offline)',
  available: () => true,
  async analyze(): Promise<VisionAnalysis> {
    cloudCalls.count += 1;
    return {
      provider: 'fake_cloud',
      summary: 'CLOUD WAS CALLED',
      texts: [],
      elements: [],
      dialogs: [],
      errors: [],
      warnings: [],
      confidence: 0.9,
    };
  },
};

const localProvider: VisionProvider = {
  name: 'fake_local',
  available: () => true,
  async analyze(): Promise<VisionAnalysis> {
    return {
      provider: 'fake_local',
      summary: 'local analysis',
      texts: [],
      elements: [],
      dialogs: [],
      errors: [],
      warnings: [],
      confidence: 0.5,
    };
  },
};

async function main() {
  const bus = new AgentEventBus();
  let downgradeEvents = 0;
  bus.on('SCREEN_CLOUD_DOWNGRADED', () => {
    downgradeEvents += 1;
  });

  // 1. Offline ON (default) — cloud request must be downgraded.
  const offlineObserver = new ScreenObserver({
    captureSource: new StaticCaptureSource(),
    events: bus,
    providers: [localProvider, cloudProvider],
    offlineVision: true,
  });
  const s1 = await offlineObserver.getCurrentState({ analyze: 'cloud', maxAgeMs: 0 });
  if (s1.analysis.provider !== 'fake_local') throw new Error(`FAIL offline: provider was ${s1.analysis.provider}`);
  if (cloudCalls.count !== 0) throw new Error('FAIL offline: cloud provider was called!');
  if (downgradeEvents !== 1) throw new Error(`FAIL offline: expected 1 downgrade event, got ${downgradeEvents}`);
  console.log('offline ON: cloud request downgraded to local, event emitted [ok]');

  // 2. Default option (no analyze) — local, no cloud, no event.
  const s2 = await offlineObserver.getCurrentState({ maxAgeMs: 0 });
  if (s2.analysis.provider !== 'fake_local') throw new Error(`FAIL default: provider was ${s2.analysis.provider}`);
  if (downgradeEvents !== 1) throw new Error('FAIL default: downgrade event emitted without a cloud request');
  console.log('default request: local provider, no spurious events [ok]');

  // 3. Offline OFF — the same explicit cloud request now reaches the provider.
  offlineObserver.setOfflineVision(false);
  const s3 = await offlineObserver.getCurrentState({ analyze: 'cloud', maxAgeMs: 0 });
  if (s3.analysis.provider !== 'fake_cloud') throw new Error(`FAIL online: provider was ${s3.analysis.provider}`);
  if (cloudCalls.count !== 1) throw new Error(`FAIL online: cloud calls = ${cloudCalls.count}`);
  console.log('offline OFF (user opted out): cloud provider runs normally [ok]');

  console.log('OFFLINE-VISION ENFORCEMENT TEST: PASS');
}

main().catch((err) => {
  console.error('OFFLINE-VISION ENFORCEMENT TEST: FAIL —', err.message);
  process.exit(1);
});
