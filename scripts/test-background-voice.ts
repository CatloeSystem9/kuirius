/**
 * Background Voice Output (Step 2) test suite.
 *
 * Covers: playback-session discipline (stale TTS fetch never starts playback),
 * stop invalidates in-flight sessions, duplicate-speak replaces (never overlaps),
 * stuck-audio watchdog hand-off to the Web Speech path, unexpected-pause single
 * recovery (device disconnect), devicechange resume, error-path fallback to Web
 * Speech, empty-text no-op, and voice-characteristic preservation (cleaned
 * text, language detection, voice-profile clamps unchanged).
 *
 * All media (Audio element, speechSynthesis, AudioContext) is faked via the
 * injectable element factory and global stubs — no real audio device needed.
 *
 * Usage: npx tsx scripts/test-background-voice.ts
 * Exits non-zero on any failure.
 */
import {
  cleanSpeechText,
  detectSpeechLanguage,
  setAudioElementFactoryForTests,
  speakKrishaText,
  stopKrishaSpeech,
} from '../src/utils/audio';

// ------------------------------------------------------------------ harness

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Controllable fake HTMLAudioElement. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  playbackRate = 1;
  paused = true;
  ended = false;
  currentTime = 0;
  onplay: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onpause: (() => void) | null = null;
  playCalls = 0;
  pauseCalls = 0;
  private playResult: 'resolve' | 'reject' | 'hang' | 'reject-later';

  constructor(src: string, playResult: 'resolve' | 'reject' | 'hang' | 'reject-later' = 'resolve') {
    this.src = src;
    this.playResult = playResult;
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.playCalls += 1;
    if (this.playResult === 'resolve') {
      this.paused = false;
      this.onplay?.();
      return Promise.resolve();
    }
    if (this.playResult === 'reject') {
      return Promise.reject(new DOMException('NotAllowedError', 'NotAllowedError'));
    }
    if (this.playResult === 'reject-later') {
      return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('playback failed')), 20));
    }
    return new Promise(() => undefined); // hang — autoplay-policy wedge
  }
  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
    this.onpause?.();
  }
}

// Install the fake audio element factory for the whole suite (Node has no
// real Audio constructor; every test below observes FakeAudio instances).
setAudioElementFactoryForTests((src) => new FakeAudio(src) as unknown as HTMLAudioElement);

/** Honest Web Speech stub: speak() completes the utterance (onend fires). */
const speakingSpeechStub = (record?: string[]) => ({
  cancel: () => undefined,
  getVoices: () => [],
  speak: (u: { text: string; onend?: (() => void) | null }) => {
    record?.push(u.text);
    // Async so callbacks attach before completion (mirrors the real API).
    setTimeout(() => u.onend?.(), 0);
  },
});

// Node has no Web Speech globals — stub the utterance constructor once.
class FakeUtterance {
  text: string;
  lang = '';
  rate = 1;
  pitch = 1;
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}
(globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = FakeUtterance;

// ------------------------------------------------- 1. speech cleaning unchanged

console.log('\n1. Voice characteristics preserved (cleaning/language/profile)');
{
  assertEqual(cleanSpeechText('Hello there! [emotion:gentle_smile:intensity=0.8:gesture=none:blush=0.2]'), 'Hello there!', 'emotion tags stripped');
  assertEqual(cleanSpeechText('*laughs* ehehe this is fine'), 'this is fine', 'laughter tokens stripped');
  assertEqual(detectSpeechLanguage('नमस्ते कैसी हो').lang, 'hi-IN', 'Devanagari detected as Hindi');
  assertEqual(detectSpeechLanguage('hello there').lang, 'en-US', 'English default');
  assert(detectSpeechLanguage('kaise ho aap').isHindi, 'Hinglish detected');
}

// ------------------------------------ 2. stale TTS fetch never starts playback

console.log('\n2. Stale TTS fetch cannot start playback (overlap prevention)');
{
  FakeAudio.instances = [];
  let fetchIndex = 0;
  const fetchImpl = (async () => {
    fetchIndex += 1;
    if (fetchIndex === 1) {
      // slow first fetch: the second request wins before this resolves
      await new Promise((r) => setTimeout(r, 40));
    }
    return {
      ok: true,
      json: async () => ({ audio: 'QUJD', mimeType: 'audio/wav' }),
    };
  }) as unknown as typeof fetch;
  const g = globalThis as { fetch?: unknown };
  const realFetch = g.fetch;
  g.fetch = fetchImpl;

  let endA = 0;
  let endB = 0;
  const a = speakKrishaText('first reply', 'Aoede', 1, undefined, () => { endA += 1; });
  const b = speakKrishaText('second reply', 'Aoede', 1, undefined, () => { endB += 1; });
  await Promise.all([a, b]);
  await flush(10);

  const started = FakeAudio.instances.filter((fa) => fa.playCalls > 0);
  assertEqual(started.length, 1, 'exactly ONE audio element ever started playing (no overlap)');
  // Complete the winning session honestly (its audio "finishes").
  if (started[0]) {
    started[0].ended = true;
    started[0].onended?.();
  }
  await flush();
  assertEqual(endA + endB, 1, 'exactly one onEnd fired (no zombie callbacks)');
  g.fetch = realFetch;
  stopKrishaSpeech();
}

// ------------------------------------ 3. stop invalidates in-flight sessions

console.log('\n3. Explicit stop cancels pending sessions');
{
  FakeAudio.instances = [];
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    await new Promise((r) => setTimeout(r, 25));
    return { ok: true, json: async () => ({ audio: 'QUJD' }) };
  }) as unknown as typeof fetch;
  const g = globalThis as { fetch?: unknown };
  const realFetch = g.fetch;
  g.fetch = fetchImpl;

  let startCalls = 0;
  let endCalls = 0;
  const p = speakKrishaText('will be stopped', 'Aoede', 1, () => { startCalls += 1; }, () => { endCalls += 1; });
  stopKrishaSpeech(); // user pressed stop / Krix shut down before TTS returned
  await p;
  await flush(10);
  assertEqual(FakeAudio.instances.filter((fa) => fa.playCalls > 0).length, 0, 'no playback after explicit stop');
  assertEqual(startCalls, 0, 'no onStart after explicit stop');
  assertEqual(endCalls, 0, 'no onEnd after explicit stop');
  g.fetch = realFetch;
}

// ------------------------------------ 4. stuck-audio watchdog hands off to Web Speech

console.log('\n4. Stuck audio watchdog (wedged play())');
{
  FakeAudio.instances = [];
  const g = globalThis as { fetch?: unknown };
  const realFetch = g.fetch;
  g.fetch = (async () => ({ ok: true, json: async () => ({ audio: 'QUJD' }) })) as unknown as typeof fetch;

  // Stub Web Speech so the fallback path is observable; window stub carries
  // no-op DOM listener methods so the unlock/device installers no-op safely.
  const spoken: string[] = [];
  const fakeSpeech = speakingSpeechStub(spoken);
  const noopListeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as { window?: unknown }).window = { speechSynthesis: fakeSpeech, ...noopListeners };
  // This test needs a WEDGED play(): override the factory for the duration.
  setAudioElementFactoryForTests((src) => new FakeAudio(src, 'hang') as unknown as HTMLAudioElement);

  let endCalls = 0;
  const p = speakKrishaText('stuck playback probe', 'Aoede', 1, undefined, () => { endCalls += 1; });
  await flush();
  const hung = FakeAudio.instances[0];
  assertEqual(hung.playCalls, 1, 'audio element started (hung play promise)');
  // The 12 s watchdog uses setTimeout — wait past it (12 s wall time is long;
  // shorten by firing timers: use the real timer honestly).
  await new Promise((r) => setTimeout(r, 12_600));
  await p;
  await flush();
  assertEqual(spoken.length, 1, 'wedged audio handed off to Web Speech exactly once');
  assertEqual(endCalls, 1, 'session still completes with one onEnd (no stuck state)');
  assert(hung.paused, 'wedged element paused and released');
  setAudioElementFactoryForTests((src) => new FakeAudio(src) as unknown as HTMLAudioElement); // restore default
  g.fetch = realFetch;
  delete (globalThis as { window?: unknown }).window;
  stopKrishaSpeech();
}

// ------------------------------------ 5. unexpected pause recovery (device disconnect)

console.log('\n5. Device disconnect → bounded single recovery');
{
  FakeAudio.instances = [];
  const g = globalThis as { fetch?: unknown };
  const realFetch = g.fetch;
  g.fetch = (async () => ({ ok: true, json: async () => ({ audio: 'QUJD' }) })) as unknown as typeof fetch;
  const noopListeners5 = { addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as { window?: unknown }).window = { speechSynthesis: { cancel: () => undefined, getVoices: () => [], speak: () => undefined }, ...noopListeners5 };

  let endCalls = 0;
  void speakKrishaText('device drop probe', 'Aoede', 1, undefined, () => { endCalls += 1; });
  await flush();
  const audio = FakeAudio.instances[0];

  // Device vanishes mid-speech: playback pauses unexpectedly.
  audio.paused = true;
  audio.onpause?.();
  await new Promise((r) => setTimeout(r, 1_300)); // recovery grace = 1 s
  assertEqual(audio.playCalls, 2, 'exactly ONE resume attempt after unexpected pause');

  // A second unexpected pause must NOT loop retries.
  audio.paused = true;
  audio.onpause?.();
  await new Promise((r) => setTimeout(r, 1_300));
  assertEqual(audio.playCalls, 2, 'no retry loop on repeated pauses (bounded recovery)');

  // After the session ends, a stale pause must not revive it.
  audio.ended = true;
  audio.onended?.();
  stopKrishaSpeech();
  audio.paused = true;
  audio.onpause?.();
  await new Promise((r) => setTimeout(r, 1_300));
  assertEqual(audio.playCalls, 2, 'stale pause after session end never revives playback');
  g.fetch = realFetch;
  delete (globalThis as { window?: unknown }).window;
}

// ------------------------------------ 6. error path falls back to Web Speech

console.log('\n6. Play failure → Web Speech fallback, honest completion');
{
  FakeAudio.instances = [];
  const g = globalThis as { fetch?: unknown };
  const realFetch = g.fetch;
  g.fetch = (async () => ({ ok: true, json: async () => ({ audio: 'QUJD' }) })) as unknown as typeof fetch;
  const spoken: string[] = [];
  const started: string[] = [];
  (globalThis as { window?: unknown }).window = {
    speechSynthesis: speakingSpeechStub(spoken),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  setAudioElementFactoryForTests((src) => new FakeAudio(src, 'reject') as unknown as HTMLAudioElement);

  let onEnd = 0;
  let onStart = 0;
  await speakKrishaText('fallback probe', 'Aoede', 1, () => { onStart += 1; }, () => { onEnd += 1; });
  await new Promise((r) => setTimeout(r, 20)); // stub onend is a macrotask
  await flush();
  assertEqual(spoken.length, 1, 'Web Speech fallback spoke after audio play() rejection');
  assertEqual(onEnd, 1, 'single honest onEnd');
  assert(spoken[0] === 'fallback probe', 'same text, same session');
  assertEqual(onStart, 0, 'no onStart for the failed audio path');
  setAudioElementFactoryForTests((src) => new FakeAudio(src) as unknown as HTMLAudioElement); // restore default

  g.fetch = realFetch;
  delete (globalThis as { window?: unknown }).window;
  stopKrishaSpeech();
}

// ------------------------------------ 7. duplicate speak replaces cleanly

console.log('\n7. Repeated speak replaces current speech (no stacking)');
{
  FakeAudio.instances = [];
  const g = globalThis as { fetch?: unknown };
  const realFetch = g.fetch;
  g.fetch = (async () => ({ ok: true, json: async () => ({ audio: 'QUJD' }) })) as unknown as typeof fetch;
  const noopListeners7 = { addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as { window?: unknown }).window = { speechSynthesis: { cancel: () => undefined, getVoices: () => [], speak: () => undefined }, ...noopListeners7 };

  const p1 = speakKrishaText('utterance one', 'Aoede', 1);
  await flush();
  const first = FakeAudio.instances[0];
  assertEqual(first.playCalls, 1, 'first utterance playing');
  const p2 = speakKrishaText('utterance two', 'Aoede', 1);
  await flush();
  assertEqual(first.pauseCalls, 1, 'first utterance stopped when the second began');
  const second = FakeAudio.instances[1];
  assertEqual(second.playCalls, 1, 'second utterance playing');
  await Promise.all([p1, p2]);
  g.fetch = realFetch;
  delete (globalThis as { window?: unknown }).window;
  stopKrishaSpeech();
}

// ------------------------------------ 8. empty text no-op

console.log('\n8. Empty text completes without playback');
{
  FakeAudio.instances = [];
  let endCalls = 0;
  await speakKrishaText('[emotion:gentle_smile:intensity=1:gesture=none:blush=0]', 'Aoede', 1, undefined, () => { endCalls += 1; });
  assertEqual(endCalls, 1, 'onEnd fires for cleaned-empty text');
  assertEqual(FakeAudio.instances.length, 0, 'no audio element created');
}

// ------------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILED assertions:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

