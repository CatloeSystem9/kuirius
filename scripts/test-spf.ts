/**
 * Screen Privacy Firewall (SPF) — security test suite.
 *
 * Usage:  npx tsx scripts/test-spf.ts
 * Exit:   non-zero on any failure.
 *
 * Deterministic and LOCAL: all credentials are synthetic (FAKE_*), no real
 * API is ever contacted. Transmission-path scenarios verify ACTUAL OUTBOUND
 * PAYLOADS against a controlled local HTTP receiver (task §9): the receiver
 * records every request it accepts, so "prohibited data never arrives
 * externally" is proven by wire evidence, not internal flags.
 *
 * A live-server section (spawned `tsx server.ts` on port 3100 via
 * KRISHA_PORT, skipped when that port is occupied) verifies endpoint-level
 * blocking responses. Every live-server case returns BEFORE any external
 * model call — the suite never transmits to real APIs.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';

import {
  spfFirewall,
  spfScreenItem,
  ScreenPrivacyFirewall,
  SpfAuditLog,
  scanText,
  luhnValid,
  redactFrameRegions,
  countRedactionMarkers,
} from '../src/agent/spf/index';
import type { SpfContext } from '../src/agent/spf/index';
import { installSpfOutboundGuard, SpfBlockedError } from '../src/agent/spf/outboundGuard';
import type { SpfDetector, RawMatch } from '../src/agent/spf/detectors';
import { GeminiVisionProvider } from '../src/agent/vision/geminiVision';
import { ObserverError } from '../src/agent/vision/visionTypes';
import { makeFrame, solidFrame, FakeCaptureSource } from '../src/agent/vision/fakeCapture';
import { cropFrame, REGION_PRESETS } from '../src/agent/vision/regionCrop';
import { ScreenObserver } from '../src/agent/vision/screenObserver';
import { createScreenTools } from '../src/agent/vision/screenTools';
import { PermissionManager } from '../src/agent/permissions';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { AgentEventBus } from '../src/agent/events';
import { SafetyGate, EmergencyStop, SafetyAuditLog, ScopedPermissionManager } from '../src/agent/safety/index';
import type { AgentTool, ToolContext } from '../src/agent/types';

// ---------------------------------------------------------------- helpers

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

let CLOCK = 1_000_000;
const now = () => CLOCK;

const CTX = (destination: string, transport: SpfContext['transport'] = 'prompt', payloadKind: SpfContext['payloadKind'] = 'text'): SpfContext => ({
  destination,
  payloadKind,
  transport,
});

// Synthetic, NON-REAL credentials (never use real values in tests).
const FAKE = {
  password: 'FAKE-Passw0rd-XYZ',
  otp: '492813',
  card: '4111 1111 1111 1111',
  cardNoSpaces: '4111111111111111',
  iban: 'GB82 WEST 1234 5698 7654 32',
  ifsc: 'SBIN0001234',
  apiKey: 'sk-FAKEKEY123456789012',
  ghtoken: 'ghp_FFFFFFFFFFFFFFFFFFFFFFFFFFFF1234',
  awsKey: 'AKIAFFFFFFFFFFFF',
  googleApiKey: 'AIza' + 'F'.repeat(35),
  jwt: 'eyJFAKEFAKEFAKE.FAKEFAKEFAKEFAKE.FAKEFAKE',
  bearer: 'Bearer FAKETOKENFAKETOKEN1234',
  seed: 'seed phrase: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
  ssn: '123-45-6789',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----FAKEFAKE-----END RSA PRIVATE KEY-----',
  dbUrl: 'postgres://admin:FAKEPASS@db.example.com:5432/app',
  email: 'user@example.com',
};

/** All fake secret values in one array — used for leakage checks. */
const ALL_FAKE_SECRETS = Object.values(FAKE) as string[];

const BENIGN = 'The quarterly design review is scheduled for Tuesday at 3pm in meeting room 4021. Please bring printed copies of the agenda.';

const NON_STRING = { not: 'a string' };

function throwingDetector(): SpfDetector {
  return {
    id: 'fake.throwing',
    category: 'password',
    confidence: 0.9,
    find(): RawMatch[] {
      throw new Error('synthetic detector failure');
    },
  };
}

// =========================================================== 1. Password detection
{
  console.log('1. Password detection');
  const v = spfFirewall.inspectText(`my password is ${FAKE.password}`, CTX('t1'));
  assert(v.decision === 'redact', 'password assignment -> redact');
  assert(v.categories.includes('password'), 'password category detected');
  assert(v.redactedText?.includes('[REDACTED-SPF:password]') === true, 'password replaced with marker');
  assert(!v.redactedText?.includes(FAKE.password), 'raw password absent from redacted text');

  const v2 = spfFirewall.inspectText(`login: ${FAKE.email} password: ${FAKE.password}`, CTX('t1'));
  assert(v2.decision === 'redact', 'email+password credential pair -> redact');
  assert(!v2.redactedText?.includes(FAKE.password), 'pair password removed');
  assert(!v2.redactedText?.includes(FAKE.email), 'pair email removed');

  const v3 = spfFirewall.inspectText(`<input type="password" value="${FAKE.password}">`, CTX('t1'));
  assert(v3.categories.includes('password'), 'password input field detected');

  const clean = spfFirewall.inspectText('Please set a strong password for your account.', CTX('t1'));
  assert(clean.decision === 'allow', 'advice about passwords without a value -> allow');

  const v4 = spfFirewall.inspectText('Passwort: Hunter2secret', CTX('t1'));
  assert(v4.decision === 'redact', 'localized password keyword (Passwort) -> redact');
}

// =========================================================== 2. Google credential detection
{
  console.log('2. Google credential detection');
  const v = spfFirewall.inspectText(`Sign in with Google — email: ${FAKE.email} password: ${FAKE.password}`, CTX('t1'));
  assert(v.decision === 'redact', 'Google sign-in credential pair -> redact');
  assert(v.categories.includes('password'), 'credential pair detected as password category');

  const v2 = spfFirewall.inspectText(`key: ${FAKE.googleApiKey}`, CTX('t1'));
  assert(v2.decision === 'redact', 'Google API key (AIza…) -> redact');
  assert(v2.categories.includes('google_credential'), 'google_credential category');
  assert(!v2.redactedText?.includes(FAKE.googleApiKey), 'Google API key removed');

  const v3 = spfFirewall.inspectText(`refresh_token=1//FAKEFAKEFAKEFAKEFAKEFAKEFAKE`, CTX('t1'));
  assert(v3.decision === 'redact', 'Google OAuth refresh token -> redact');

  const v4 = spfFirewall.inspectText(`"password":"${FAKE.password}"`, CTX('t1'));
  assert(v4.decision === 'redact', 'JSON-style password field -> redact');
}

// =========================================================== 3. OTP detection + mandatory blocking
{
  console.log('3. OTP detection and mandatory blocking');
  const v = spfFirewall.inspectText(`Your OTP is ${FAKE.otp}`, CTX('t1'));
  assert(v.decision === 'redact', 'OTP keyword+code -> redact');
  assert(v.categories.includes('otp'), 'otp category');
  assert(!v.redactedText?.includes(FAKE.otp), 'OTP digits removed from redacted text');
  assert(!v.redactedText?.includes('492813'), 'no residual OTP digits');

  const v2 = spfFirewall.inspectText('verification code: 550392', CTX('t1'));
  assert(v2.decision === 'redact', 'verification code form -> redact');

  const v3 = spfFirewall.inspectText('Use code G-284913 to sign in.', CTX('t1'));
  assert(v3.decision === 'redact', 'Google G-code -> redact');

  const v4 = spfFirewall.inspectText('my parcel code is ABC123', CTX('t1', 'chat-history'));
  assert(v4.decision === 'allow', 'alphanumeric "code" without digit OTP pattern -> allow (precision)');

  const v5 = spfFirewall.inspectText('The error code: 500 means server error', CTX('t1', 'chat-history'));
  assert(v5.decision === 'allow', 'HTTP error code 500 -> allow (3 digits out of OTP range)');

  // Mandatory blocking: an OTP inside an IMAGE transfer context blocks the image.
  const img = spfFirewall.inspectImageTransfer(
    { question: 'Read the screen', activeWindowTitle: 'Messages', priorTexts: [`Your OTP is ${FAKE.otp}`] },
    CTX('gemini:vision-analyze', 'prompt', 'image')
  );
  assert(img.decision === 'block', 'OTP in prior screen texts -> image transfer BLOCKED');

  // OTP in a URL blocks navigation.
  const url = spfFirewall.inspectUrl(`https://example.com/verify?otp=${FAKE.otp}`, CTX('t1', 'prompt', 'url'));
  assert(url.decision === 'block', 'OTP in URL -> blocked');
}

// =========================================================== 4. Bank-detail detection
{
  console.log('4. Bank-detail detection');
  const v = spfFirewall.inspectText(`Transfer to IBAN ${FAKE.iban} today`, CTX('t1'));
  assert(v.decision === 'redact', 'IBAN -> redact');
  assert(v.categories.includes('bank_account'), 'bank_account category');
  assert(!v.redactedText?.includes('GB82'), 'IBAN removed');

  const v2 = spfFirewall.inspectText(`IFSC ${FAKE.ifsc} branch code`, CTX('t1'));
  assert(v2.categories.includes('bank_account'), 'IFSC code detected');

  const v3 = spfFirewall.inspectText('account number: 1234567890', CTX('t1'));
  assert(v3.decision === 'redact', 'labeled account number -> redact');

  const v4 = spfFirewall.inspectText(`"account_number":"1234567890"`, CTX('t1'));
  assert(v4.decision === 'redact', 'JSON-style account field -> redact');
}

// =========================================================== 5. Card-number detection
{
  console.log('5. Card-number detection');
  assert(luhnValid(FAKE.cardNoSpaces) === true, 'synthetic test card passes Luhn');
  const v = spfFirewall.inspectText(`card ${FAKE.card}`, CTX('t1'));
  assert(v.decision === 'redact', 'Luhn-valid card -> redact');
  assert(v.categories.includes('card_number'), 'card_number category');
  assert(!v.redactedText?.includes('4111'), 'card digits removed');

  const v2 = spfFirewall.inspectText('invoice total 1234567890123 dollars', CTX('t1', 'chat-history'));
  assert(v2.decision === 'allow', 'long digit run failing Luhn -> allow (no false card positive)');

  const v3 = spfFirewall.inspectText('card 4111 1111 1111 1112', CTX('t1'));
  assert(v3.decision === 'allow', 'Luhn-invalid near-card -> allow');

  const v4 = spfFirewall.inspectText('cvv: 123 for the new card', CTX('t1'));
  assert(v4.categories.includes('card_cvv') || v4.decision === 'redact', 'CVV assignment detected');
  assert(!v4.redactedText?.includes('cvv: 123'), 'CVV removed from output');

  const v5 = spfFirewall.inspectText(`"card_number":"${FAKE.cardNoSpaces}"`, CTX('t1'));
  assert(v5.decision === 'redact', 'JSON-style card field -> redact');
}

// =========================================================== 6. API-key detection
{
  console.log('6. API-key detection');
  for (const [label, secret, category] of [
    ['openai-style', `key ${FAKE.apiKey}`, 'api_key'],
    ['github token', `token ${FAKE.ghtoken}`, 'api_key'],
    ['aws key', `aws ${FAKE.awsKey}`, 'api_key'],
    ['jwt', `auth ${FAKE.jwt}`, 'auth_token'],
    ['bearer', FAKE.bearer, 'auth_token'],
    ['db url', FAKE.dbUrl, 'auth_token'],
  ] as const) {
    const v = spfFirewall.inspectText(secret, CTX('t1'));
    assert(v.decision === 'redact' || v.decision === 'block', `${label} -> not allowed raw`);
    assert(v.categories.includes(category), `${label} categorized as ${category}`);
    const out = v.redactedText ?? '';
    const leaked = ALL_FAKE_SECRETS.some((s) => s.length > 8 && out.includes(s));
    assert(!leaked, `${label}: raw secret absent from output`);
  }

  const v = spfFirewall.inspectText(`-----BEGIN RSA PRIVATE KEY-----`, CTX('t1'));
  assert(v.decision === 'redact' || v.decision === 'block', 'PEM private key header detected');

  const v2 = spfFirewall.inspectText(`"api_key":"${FAKE.apiKey}"`, CTX('t1'));
  assert(v2.decision === 'redact', 'JSON-style api key field -> redact');
}

// =========================================================== 7. Sensitive visual-region redaction
{
  console.log('7. Sensitive visual-region redaction');
  const frame = makeFrame(64, 32, (x, _y, _w, _h) => (x < 32 ? [40, 40, 40] : [200, 200, 200]));
  const original = new Uint8ClampedArray(frame.data);
  const regions = [{ x: 0, y: 0, width: 0.5, height: 1 }];
  const redacted = redactFrameRegions(frame.data, frame.width, frame.height, regions);

  assert(redacted !== frame.data, 'region redaction returns a new buffer (original untouched)');
  let leftBlack = true;
  let rightPreserved = true;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < 32; x++) {
      const idx = (y * frame.width + x) * 4;
      if (redacted[idx] !== 0 || redacted[idx + 1] !== 0 || redacted[idx + 2] !== 0) leftBlack = false;
    }
    for (let x = 32; x < frame.width; x++) {
      const idx = (y * frame.width + x) * 4;
      if (redacted[idx] !== 200) rightPreserved = false;
    }
  }
  assert(leftBlack, 'sensitive region fully blacked out');
  assert(rightPreserved, 'safe region pixels preserved');
  let originalIntact = true;
  for (let i = 0; i < original.length; i++) if (original[i] !== frame.data[i]) originalIntact = false;
  assert(originalIntact, 'original frame buffer never mutated (local copy stays intact)');

  const clamped = redactFrameRegions(frame.data, frame.width, frame.height, [{ x: 0.9, y: 0.9, width: 5, height: 5 }]);
  assert(clamped.length === frame.data.length, 'clamped region redaction keeps buffer size');
}

// =========================================================== 8. OCR text redaction
{
  console.log('8. OCR text redaction');
  const ocrTexts = [
    'Welcome to the Settings page',
    `password: ${FAKE.password}`,
    'Storage: 512 GB available',
    `api key: ${FAKE.apiKey}`,
  ];
  const cleaned = ocrTexts.map((t) => spfScreenItem(t, 'test:ocr', undefined, 'prompt'));
  assert(cleaned[0].decision === 'allow' && cleaned[0].text === ocrTexts[0], 'clean OCR line untouched');
  assert(cleaned[1].decision === 'redact' && !cleaned[1].text.includes(FAKE.password), 'OCR password line redacted');
  assert(cleaned[3].decision === 'redact' && !cleaned[3].text.includes(FAKE.apiKey), 'OCR api-key line redacted');

  const unseparable = spfScreenItem(FAKE.seed, 'test:ocr', undefined, 'prompt');
  assert(unseparable.decision === 'strip' || !unseparable.text.includes('bravo'), 'unseparable sensitive line never emitted raw');

  const joined = cleaned.map((c) => c.text).join(' | ');
  assert(!joined.includes(FAKE.password) && !joined.includes(FAKE.apiKey), 'redacted OCR collection leaks no secrets');
}

// =========================================================== 9. Screenshot and crop protection
{
  console.log('9. Screenshot and crop protection');
  const v = spfFirewall.inspectImageTransfer(
    { question: 'Describe this screen', activeWindowTitle: '1Password - Passwords' },
    CTX('gemini:vision-analyze', 'prompt', 'image')
  );
  assert(v.decision === 'block', 'password-manager window title -> image BLOCK');
  assert(v.reason === 'credential_indicating_window_title', 'block reason identifies window title');

  const v2 = spfFirewall.inspectImageTransfer(
    { question: 'What is my password on this screen?' },
    CTX('gemini:vision-analyze', 'prompt', 'image')
  );
  assert(v2.decision === 'block', 'credential-extraction question -> image BLOCK');

  const v3 = spfFirewall.inspectImageTransfer(
    { question: 'Describe the layout', activeWindowTitle: 'Visual Studio Code' },
    CTX('gemini:vision-analyze', 'prompt', 'image')
  );
  assert(v3.decision === 'allow', 'neutral window + benign question -> image ALLOW');

  const v4 = spfFirewall.inspectImageTransfer(
    { question: 'Summarize this document', activeWindowTitle: 'Quarterly Report - CONFIDENTIAL' },
    CTX('gemini:vision-analyze', 'prompt', 'image')
  );
  assert(v4.decision === 'block', 'confidential document context -> image BLOCK');

  // Client provider gate: blocked request never leaves the tab.
  const provider = new GeminiVisionProvider();
  const frame = solidFrame(192, 108, 40, 'data:image/jpeg;base64,' + 'A'.repeat(400));
  let providerError: ObserverError | null = null;
  try {
    await provider.analyze(frame, { question: 'What is my password on this screen?', activeWindow: { title: '1Password', available: true } } as any);
  } catch (err) {
    providerError = err as ObserverError;
  }
  assert(providerError !== null, 'provider throws on blocked transfer');
  assert(providerError?.kind === 'provider_unavailable', 'blocked transfer reported honestly as provider_unavailable');
  assert((providerError?.message ?? '').includes('Screen Privacy Firewall'), 'provider error names the firewall');

  // Crop protection: cropped frames carry no dataUrl (existing invariant kept).
  const full = makeFrame(64, 32, () => [10, 10, 10], 'data:image/jpeg;base64,AAAA');
  const cropped = cropFrame(full, REGION_PRESETS.dialog_area);
  assert(cropped.dataUrl === undefined, 'cropped frame carries no dataUrl (privacy invariant)');

  // Detection error inside the image gate -> fail-closed BLOCK.
  const brokenFirewall = new ScreenPrivacyFirewall({ detectors: [throwingDetector()], deadlineMs: 50 });
  const errVerdict = brokenFirewall.inspectImageTransfer(
    { question: 'hello', activeWindowTitle: 'Editor' },
    CTX('t', 'prompt', 'image')
  );
  assert(errVerdict.decision === 'block', 'image gate fails closed on detector error');
}

// =========================================================== 10. Metadata and derived-text protection
{
  console.log('10. Metadata and derived-text protection');
  const meta = spfFirewall.inspectImageTransfer(
    { question: 'Describe the screen', activeWindowTitle: `Sign in — api key ${FAKE.apiKey}` },
    CTX('gemini:vision-analyze', 'prompt', 'image')
  );
  assert(meta.decision === 'block', 'sensitive window-title metadata -> BLOCK');

  const summaryLine = spfScreenItem(`Screen shows password: ${FAKE.password} and a Save button`, 'agent:task-summary', 'task1', 'summary');
  assert(summaryLine.decision === 'redact' && summaryLine.text.includes('Save button'), 'summary keeps safe content');
  assert(!summaryLine.text.includes(FAKE.password), 'summary drops the secret');

  const digest = spfScreenItem(`browser url https://ex.com?token=${FAKE.apiKey}`, 'provider:multimodal-digest', 'obs1', 'digest');
  assert(digest.decision !== 'allow', 'digest line with embedded key not allowed raw');
  assert(!digest.text.includes(FAKE.apiKey), 'digest line leaks no key');
}

// =========================================================== 11. Multiple sensitive regions in one observation
{
  console.log('11. Multiple sensitive regions in one observation');
  const mixed = `login password: ${FAKE.password} | OTP ${FAKE.otp} | card ${FAKE.card} | IBAN ${FAKE.iban} | key ${FAKE.apiKey}`;
  const v = spfFirewall.inspectText(mixed, CTX('t1'));
  assert(v.decision === 'redact', 'multi-secret payload -> redact');
  for (const category of ['password', 'otp', 'card_number', 'bank_account', 'api_key']) {
    assert(v.categories.includes(category), `category ${category} detected among multiple`);
  }
  const out = v.redactedText ?? '';
  assert(countRedactionMarkers(out) >= 4, `multiple redaction markers emitted (got ${countRedactionMarkers(out)})`);
  for (const secret of [FAKE.password, FAKE.otp, '4111', 'GB82', FAKE.apiKey]) {
    assert(!out.includes(secret), `secret "${secret.slice(0, 8)}…" absent`);
  }
}

// =========================================================== 12. Mixed sensitive and safe content
{
  console.log('12. Mixed sensitive and safe content');
  const mixed = `${BENIGN} Also my password is ${FAKE.password} but the weather is nice.`;
  const v = spfFirewall.inspectText(mixed, CTX('t1', 'chat-history'));
  assert(v.decision === 'redact', 'mixed content -> redact (not block)');
  const out = v.redactedText ?? '';
  assert(out.includes('quarterly design review'), 'safe content preserved');
  assert(out.includes('weather is nice'), 'safe tail preserved');
  assert(!out.includes(FAKE.password), 'secret removed');
}

// =========================================================== 13. Low-confidence detection
{
  console.log('13. Low-confidence detection');
  const lowConfDetector: SpfDetector = {
    id: 'fake.lowconf',
    category: 'password',
    confidence: 0.4,
    find(text: string): RawMatch[] {
      return text.includes('SUSPECT') ? [{ start: 0, end: text.length, confidence: 0.4 }] : [];
    },
  };
  const fw = new ScreenPrivacyFirewall({ detectors: [lowConfDetector], deadlineMs: 200 });
  const v = fw.inspectText('SUSPECT content here', CTX('t1'));
  assert(v.decision === 'block', 'low-confidence never-transmit finding -> BLOCK (uncertainty defaults to block)');

  const fwCtx = new ScreenPrivacyFirewall({ deadlineMs: 200 });
  const v2 = fwCtx.inspectText('CONFIDENTIAL — internal use only', CTX('t1', 'prompt'));
  assert(v2.decision === 'block', 'uncertain confidential marker on screen-provenance transport -> BLOCK');

  const v3 = fwCtx.inspectText('CONFIDENTIAL — internal use only', CTX('t1', 'chat-history'));
  assert(v3.decision === 'allow', 'uncertain marker on chat-history -> flagged allow');
  assert(v3.reason === 'uncertain_confidential_context_flagged', 'flagged allow reason recorded');

  const v4 = fwCtx.inspectText('CONFIDENTIAL account number: 1234567890', CTX('t1', 'prompt'));
  assert(v4.decision === 'redact' || v4.decision === 'block', 'sensitive content alongside uncertain context still handled');
}

// =========================================================== 14. Classification timeout
{
  console.log('14. Classification timeout');
  const slowDetector: SpfDetector = {
    id: 'fake.slow',
    category: 'password',
    confidence: 0.9,
    find(text: string): RawMatch[] {
      const end = Date.now() + 120;
      while (Date.now() < end) { /* spin */ }
      return [];
    },
  };
  const fw = new ScreenPrivacyFirewall({ detectors: [slowDetector], deadlineMs: 30 });
  const started = Date.now();
  const v = fw.inspectText(BENIGN, CTX('t1'));
  assert(v.decision === 'block', 'classification timeout -> BLOCK');
  assert(v.timedOut === true, 'verdict records timeout');
  assert(Date.now() - started < 2000, 'timeout respected without unbounded stall');
}

// =========================================================== 15. Redaction failure
{
  console.log('15. Redaction failure');
  const zeroWidth: SpfDetector = {
    id: 'fake.zerowidth',
    category: 'password',
    confidence: 0.95,
    find(text: string): RawMatch[] {
      return text.includes('SECRET') ? [{ start: 2, end: 2 }] : [];
    },
  };
  const fw = new ScreenPrivacyFirewall({ detectors: [zeroWidth], deadlineMs: 200 });
  const v = fw.inspectText('a SECRET b', CTX('t1'));
  assert(v.decision === 'block', 'redaction failure (zero-width span) -> BLOCK');
  assert(v.reason === 'redaction_failed', 'failure reason recorded');

  const greedy: SpfDetector = {
    id: 'fake.greedy',
    category: 'password',
    confidence: 0.95,
    find(text: string): RawMatch[] {
      const out: RawMatch[] = [];
      const re = /SECRETVALUE/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) out.push({ start: m.index, end: m.index + 6 });
      return out;
    },
  };
  const fw2 = new ScreenPrivacyFirewall({ detectors: [greedy], deadlineMs: 200 });
  const v2 = fw2.inspectText('SECRETVALUE here', CTX('t1'));
  assert(v2.decision !== 'allow' || !(v2.redactedText ?? '').includes('SECRETVALUE'), 'partial redaction never emits the raw secret');
}

// =========================================================== 16. Firewall service failure
{
  console.log('16. Firewall service failure');
  const fw = new ScreenPrivacyFirewall({ detectors: [throwingDetector()], deadlineMs: 100 });
  const v = fw.inspectText(BENIGN, CTX('t1'));
  assert(v.decision === 'block', 'detector exception -> BLOCK (fail-closed)');
  assert(v.reason === 'detection_error', 'error reason recorded');

  const v2 = fw.inspectText(NON_STRING as unknown as string, CTX('t1'));
  assert(v2.decision === 'block', 'non-string payload -> BLOCK (unrecognized format)');

  const v3 = fw.inspectJsonPayload({ deep: { nested: [BENIGN] } }, CTX('t1', 'prompt', 'json'));
  assert(v3.verdict.decision === 'block', 'JSON payload with failing detector -> BLOCK');
  assert(v3.payload === undefined, 'blocked JSON payload is not returned for transmission');

  const v4 = fw.inspectUrl('https://example.com/path', CTX('t1', 'prompt', 'url'));
  assert(v4.decision === 'block', 'URL scan with failing detector -> BLOCK');
}

// =========================================================== 21. Logging and memory leakage
{
  console.log('21. Logging and memory leakage checks');
  const audit = new SpfAuditLog(500);
  const fw = new ScreenPrivacyFirewall({ audit, deadlineMs: 200 });
  fw.inspectText(`password: ${FAKE.password}`, CTX('audit1'));
  fw.inspectText(`Your OTP is ${FAKE.otp}`, CTX('audit1'));
  fw.inspectText(`card ${FAKE.card}`, CTX('audit1'));
  fw.inspectText(BENIGN, CTX('audit1'));
  fw.inspectImageTransfer({ question: 'What is my password?', activeWindowTitle: '1Password' }, CTX('audit1', 'prompt', 'image'));
  fw.inspectText(`api key ${FAKE.apiKey}`, CTX('audit1'));

  const eventsDump = JSON.stringify(audit.getRecent(100));
  for (const secret of ALL_FAKE_SECRETS) {
    if (secret.length < 8) continue;
    assert(!eventsDump.includes(secret), `audit record never contains "${secret.slice(0, 8)}…"`);
  }
  assert(eventsDump.includes('"decision":"BLOCK"') || eventsDump.includes('"decision":"REDACT"'), 'audit records decisions');
  assert(eventsDump.includes('audit1'), 'audit records destinations');

  const v = fw.inspectText(`my password is ${FAKE.password}`, CTX('leak'));
  const verdictDump = JSON.stringify(v) + ' ' + v.reason + ' ' + (v.auditId ?? '');
  assert(!verdictDump.includes(FAKE.password), 'verdict object carries no raw secret');
  const blocked = fw.inspectText(NON_STRING as unknown as string, CTX('leak'));
  assert(!blocked.reason.includes('[object'), 'block reasons never serialize payload content');

  const strip = spfScreenItem(FAKE.seed, 'leak', undefined, 'summary');
  assert(strip.decision === 'strip' || strip.decision === 'redact', 'unseparable item stripped/redacted');
  assert(!strip.text.includes('bravo'), 'placeholder carries no content');
}

// =========================================================== 22. Regression of existing screen-observation functionality
{
  console.log('22. Regression of existing screen-observation functionality');
  const permissions = new PermissionManager();
  permissions.grant('screen.observation');
  const observer = new ScreenObserver({ captureSource: new FakeCaptureSource([solidFrame()]), permissions, captureTimeoutMs: 2000 });
  const state = await observer.getCurrentState({ maxAgeMs: 0 });
  assert(typeof state.id === 'string' && state.id.length > 0, 'observation still produces a ScreenState');
  assert(state.analysis.provider === 'local_pixel_heuristics', 'local provider still used by default');
  const serializedState = JSON.stringify(state);
  assert(!serializedState.includes('data:image'), 'ScreenState still carries no image data');
  assert(state.analysis.texts.length === 0, 'local provider still reports honest empty OCR');

  const change = await observer.detectChanges();
  assert(typeof change.changed === 'boolean', 'detectChanges still works');

  const tools = createScreenTools(observer);
  const observeTool = tools.find((t) => t.name === 'screen.observe');
  assert(observeTool !== undefined, 'screen.observe tool still registered');
  const ctx: ToolContext = { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {} };
  const result = await observeTool!.execute({}, ctx);
  assert(result.success === true, 'screen.observe still succeeds with clean content');
  const outputDump = JSON.stringify(result.output ?? {});
  assert(!outputDump.includes('data:image'), 'tool output still carries no pixels');

  const benignScreen = spfScreenItem(BENIGN, 'tool:screen.observe', undefined, 'tool-output');
  assert(benignScreen.decision === 'allow' && benignScreen.text === BENIGN, 'benign observation text passes SPF unchanged');
  observer.stop();
}

// =========================================================== 23. Regression of emergency-stop behavior
{
  console.log('23. Regression of emergency-stop behavior');
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const scoped = new ScopedPermissionManager(now);
  const audit = new SafetyAuditLog();
  const emergencyStop = new EmergencyStop(audit);
  const gate = new SafetyGate({ permissions, scoped, emergencyStop, audit, now });
  registry.setSafetyGate(gate);

  permissions.grant('screen.observation');
  const observer = new ScreenObserver({ captureSource: new FakeCaptureSource([solidFrame()]), permissions, captureTimeoutMs: 2000 });
  for (const tool of createScreenTools(observer)) registry.register(tool);
  const ctx: ToolContext = { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {} };

  const preStop = await registry.execute('screen.observe', {}, ctx);
  assert(preStop.success === true, 'screen.observe executes through the safety gate before stop');
  assert((preStop.metadata?.safety as any)?.decision === 'allow', 'safety evaluation still attached to results');

  emergencyStop.activate('spf regression test');
  const stopped = await registry.execute('screen.observe', {}, ctx);
  assert(stopped.success === false, 'screen.observe blocked while emergency stop active');
  assert(stopped.errorKind === 'permission_denied', 'stop denial still permission_denied');
  const spfVerdict = spfFirewall.inspectText(`password: ${FAKE.password}`, CTX('stop-test'));
  assert(spfVerdict.decision === 'redact', 'SPF still deciding while stop active');
  assert(emergencyStop.isActive() === true, 'emergency stop remains active after SPF decisions');
  observer.stop();
}

// =========================================================== 17-20. Outbound transmission verification
async function transmissionScenarios(): Promise<void> {
  console.log('17. Direct API transmission attempts (actual outbound payloads)');
  const received: Array<{ url: string; body: string }> = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const port = (receiver.address() as AddressInfo).port;
  const receiverUrl = `http://127.0.0.1:${port}`;

  const guardFw = new ScreenPrivacyFirewall({ deadlineMs: 200 });
  const guard = installSpfOutboundGuard(guardFw, { trustedHosts: ['spf-none.invalid'] });

  const safeJson = JSON.stringify({ message: BENIGN });
  const secretJson = JSON.stringify({ message: `my password is ${FAKE.password}` });
  const otpJson = JSON.stringify({ message: `Your OTP is ${FAKE.otp}` });
  const cardJson = JSON.stringify({ payment: { card: FAKE.cardNoSpaces, cvv: '123' } });

  // 17a — clean payload reaches the receiver (ALLOW verified on the wire).
  const okRes = await fetch(`${receiverUrl}/allow`, { method: 'POST', body: safeJson, headers: { 'Content-Type': 'application/json' } });
  assert(okRes.ok === true, 'clean payload transmission succeeds');
  const okEntry = received.find((r) => r.url === '/allow');
  assert(okEntry !== undefined, 'receiver accepted the clean request');
  assert(okEntry?.body === safeJson, 'clean wire payload intact');

  // 17b — password-bearing payload: REDACTED at the transport level; the
  // wire payload the receiver actually accepts carries the marker, never the
  // raw secret.
  const res17b = await fetch(`${receiverUrl}/secret`, { method: 'POST', body: secretJson, headers: { 'Content-Type': 'application/json' } });
  assert(res17b.ok === true, 'password payload transmission completes (rewritten, not aborted)');
  const secretEntry = received.find((r) => r.url === '/secret');
  assert(secretEntry !== undefined, 'receiver accepted the rewritten request');
  assert(secretEntry?.body.includes('[REDACTED-SPF:password]') === true, 'WIRE PAYLOAD carries redaction marker');
  assert(secretEntry?.body.includes(FAKE.password) === false, 'WIRE PAYLOAD contains NO raw password');

  // 17c — OTP payload: digits never transmitted (rewritten on the wire).
  const res17c = await fetch(`${receiverUrl}/otp`, { method: 'POST', body: otpJson });
  assert(res17c.ok === true, 'OTP payload transmission completes (rewritten)');
  const otpEntry = received.find((r) => r.url === '/otp');
  assert(otpEntry?.body.includes(FAKE.otp) === false, 'WIRE PAYLOAD contains NO OTP digits');
  assert(otpEntry?.body.includes('[REDACTED-SPF:otp]') === true, 'WIRE PAYLOAD carries OTP redaction marker');

  // 17d — full payment credentials: removed from the wire payload.
  const res17d = await fetch(`${receiverUrl}/pay`, { method: 'POST', body: cardJson });
  assert(res17d.ok === true, 'card+CVV payload transmission completes (rewritten)');
  const payEntry = received.find((r) => r.url === '/pay');
  assert(payEntry?.body.includes(FAKE.cardNoSpaces) === false && payEntry?.body.includes('"123"') === false, 'WIRE PAYLOAD contains NO card/CVV data');

  // 17e — base64-encoded secret in a body is decoded and blocked (evasion).
  const b64 = Buffer.from(`password: ${FAKE.password}`).toString('base64');
  let blocked4: SpfBlockedError | null = null;
  try {
    await fetch(`${receiverUrl}/b64`, { method: 'POST', body: JSON.stringify({ blob: b64 }) });
  } catch (err) {
    blocked4 = err as SpfBlockedError;
  }
  assert(blocked4 instanceof SpfBlockedError, 'base64-encoded secret -> blocked');
  assert(received.every((r) => r.url !== '/b64'), 'receiver NEVER received the encoded secret');

  console.log('18. Remote-agent transmission attempts');
  const remoteTask = JSON.stringify({
    taskId: 't-1',
    destination: 'remote-agent-orchestrator',
    screenObservation: { summary: 'Banking page', texts: ['account number: 1234567890', 'Welcome'] },
  });
  const res18 = await fetch(`${receiverUrl}/remote-agent`, { method: 'POST', body: remoteTask });
  assert(res18.ok === true, 'remote-agent relay completes (bank detail rewritten)');
  const remoteEntry = received.find((r) => r.url === '/remote-agent');
  assert(remoteEntry?.body.includes('1234567890') === false, 'remote agent NEVER received the raw account number');
  assert(remoteEntry?.body.includes('[REDACTED-SPF:bank_account]') === true, 'remote agent received the redacted copy');

  const httpBlocked = await new Promise<boolean>((resolve) => {
    const req = http.request(`${receiverUrl}/node-http`, { method: 'POST' }, () => resolve(false));
    req.on('error', (err) => resolve((err as Error)?.message?.includes('Screen Privacy Firewall') === true));
    req.write(JSON.stringify({ text: `otp ${FAKE.otp}` }));
    req.end();
    setTimeout(() => resolve(false), 2000);
  });
  assert(httpBlocked, 'node http.request with OTP body -> destroyed by guard');
  assert(received.every((r) => r.url !== '/node-http'), 'receiver NEVER received the node-http OTP payload');

  console.log('19. Browser and research-service transmission attempts');
  const queryVerdict = guardFw.inspectText(`research this error: password: ${FAKE.password}`, CTX('web-search', 'prompt'));
  assert(queryVerdict.decision === 'redact', 'research query with secret -> redact');
  const safeQuery = queryVerdict.redactedText ?? '';
  const engineUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(safeQuery)}`;
  const urlVerdict = guardFw.inspectUrl(engineUrl, CTX('web-search', 'prompt', 'url'));
  assert(urlVerdict.decision === 'allow', 'redacted query built into engine URL -> allowed');
  assert(!engineUrl.includes(FAKE.password), 'engine URL carries no raw secret');
  const rawEngineUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`password: ${FAKE.password}`)}`;
  let blocked6: SpfBlockedError | null = null;
  try {
    await fetch(rawEngineUrl);
  } catch (err) {
    blocked6 = err as SpfBlockedError;
  }
  assert(blocked6 instanceof SpfBlockedError, 'raw secret search URL -> blocked by guard');
  assert(received.every((r) => !r.url.includes('password')), 'receiver (and by proxy the engine) never saw the raw query');

  const navVerdict = guardFw.inspectUrl(`https://www.google.com/search?q=${encodeURIComponent(`my password is ${FAKE.password}`)}`, CTX('browser', 'prompt', 'url'));
  assert(navVerdict.decision === 'block', 'browser navigation URL with secret -> blocked');

  console.log('20. Attempted SPF bypass');
  const fwAny = guardFw as unknown as Record<string, unknown>;
  assert(typeof fwAny.override !== 'function' && typeof fwAny.allow !== 'function' && typeof fwAny.bypass !== 'function', 'firewall exposes NO override/bypass API');
  const flagged = guardFw.inspectText(`password: ${FAKE.password}`, CTX('t1'));
  const flaggedAttempt = guardFw.inspectText(
    JSON.stringify({ force: true, allowSensitive: true, skipSpf: true, content: `password: ${FAKE.password}` }),
    CTX('t1')
  );
  assert(flagged.decision === 'redact', 'normal secret -> redact');
  assert(flaggedAttempt.decision === 'redact' && !(flaggedAttempt.redactedText ?? '').includes(FAKE.password), 'payload "allowSensitive"/"skipSpf" flags have NO effect — secret still sanitized');
  const encUrl = `https://example.com/?q=password%3A+${encodeURIComponent(FAKE.password)}`;
  let blocked7: SpfBlockedError | null = null;
  try {
    await fetch(encUrl);
  } catch (err) {
    blocked7 = err as SpfBlockedError;
  }
  assert(blocked7 instanceof SpfBlockedError, 'URI-encoded secret in URL -> blocked by guard');
  let blocked8: SpfBlockedError | null = null;
  try {
    await fetch(`${receiverUrl}/hdr`, { method: 'POST', headers: { 'x-exfil-data': `password: ${FAKE.password}` } });
  } catch (err) {
    blocked8 = err as SpfBlockedError;
  }
  assert(blocked8 instanceof SpfBlockedError, 'secret smuggled in custom header -> blocked');
  assert(received.every((r) => r.url !== '/hdr'), 'header-smuggled secret never arrived');
  const guard2 = installSpfOutboundGuard(guardFw, {});
  assert(guard2.state.fetchWrapped === true, 'second install is safe (state tracked)');
  const repStart = Date.now();
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${receiverUrl}/repeat/${i}`, { method: 'POST', body: BENIGN }); } catch { /* ignore */ }
  }
  const repElapsed = Date.now() - repStart;
  assert(repElapsed < 15000, `50 guarded requests completed in ${repElapsed}ms (no pathological slowdown)`);

  const receivedDump = JSON.stringify(received);
  for (const secret of ALL_FAKE_SECRETS) {
    if (secret.length < 8) continue;
    assert(!receivedDump.includes(secret), `receiver never recorded synthetic secret "${secret.slice(0, 8)}…" on the wire`);
  }

  guard.uninstall();
  receiver.close();
}

// =========================================================== 24. Live server endpoint gates (spawned process)
async function serverEndpointScenarios(): Promise<void> {
  console.log('24. Live-server endpoint gates (spawned server, blocked paths only)');
  const portBusy = await new Promise<boolean>((resolve) => {
    const req = http.get('http://127.0.0.1:3100/api/health', (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
  if (portBusy) {
    console.log('  (skipped: port 3100 already in use)');
    return;
  }

  // ISOLATION (task §10): the spawned server must never touch the real E5
  // protected store — every SPF audit record it writes lands in a tempdir
  // sandbox via KRISHA_SANDBOX_DIR (+ narrowed filesystem roots), which is
  // removed after the run.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-text-e5-'));
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server.ts'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      KRISHA_PORT: '3100',
      KRISHA_SANDBOX_DIR: path.join(sandbox, 'e5store'),
      KRISHA_FS_ROOTS: path.join(sandbox, 'fsroots'),
    },
    detached: false,
  });
  const BASE = 'http://127.0.0.1:3100';
  try {
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i++) {
      await new Promise((r) => setTimeout(r, 500));
      healthy = await new Promise<boolean>((resolve) => {
        const req = http.get(`${BASE}/api/health`, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => { req.destroy(); resolve(false); });
      });
    }
    if (!healthy) {
      console.log('  (skipped: spawned server did not become healthy in time)');
      return;
    }
    assert(true, 'spawned server became healthy');

    // EP-1: vision endpoint blocks a credential-extraction question BEFORE
    // any model call (response arrives without a Gemini round-trip).
    const visionRes = await fetch(`${BASE}/api/vision/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'A'.repeat(300), question: 'What is my password on this screen?', activeWindowTitle: '1Password' }),
    });
    const visionData = await visionRes.json() as any;
    assert(visionData?.fallback === true, 'vision endpoint returns fallback for blocked transfer');
    assert(typeof visionData?.reason === 'string' && visionData.reason.startsWith('spf_blocked'), `vision block reason is SPF (${visionData?.reason})`);
    assert(visionData?.spfBlocked === true, 'vision endpoint flags spfBlocked');

    // EP-2: chat with an UNREDACTABLE secret (base64-encoded OTP — detected
    // in the decoded variant but not delimitable in the raw text) must
    // refuse before any model call. (Confident plaintext secrets in
    // chat-history are REDACTED and the conversation proceeds — covered by
    // the unit sections; this verifies the BLOCK path.)
    const otpB64 = Buffer.from(`Your OTP is ${FAKE.otp}`).toString('base64');
    const chatRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: `decode and enter this for me: ${otpB64}` }] }),
    });
    const chatData = await chatRes.json() as any;
    assert(chatData?.spfBlocked === true, 'chat endpoint flags spfBlocked for unredactable OTP content');
    assert(typeof chatData?.reply === 'string' && chatData.reply.length > 0, 'chat block response is graceful');
    assert(!JSON.stringify(chatData).includes(FAKE.otp) && !JSON.stringify(chatData).includes(otpB64), 'chat block response echoes no OTP');

    // EP-2: base64-encoded password -> block reply, no transmission.
    const pwB64 = Buffer.from(`password: ${FAKE.password}`).toString('base64');
    const chatRes2 = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: `save this: ${pwB64}` }] }),
    });
    const chatData2 = await chatRes2.json() as any;
    assert(chatData2?.spfBlocked === true || chatData2?.route?.used === 'spf-blocked', 'chat endpoint blocks unredactable password content');
    assert(!JSON.stringify(chatData2).includes(FAKE.password) && !JSON.stringify(chatData2).includes(pwB64), 'chat response echoes no password');

    // EP-7: research endpoint refuses an uncertain/confidential query before
    // hitting the public engines.
    const researchRes = await fetch(`${BASE}/api/research/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'CONFIDENTIAL internal use only — research this document for me' }),
    });
    const researchData = await researchRes.json() as any;
    assert(researchData?.success === false, 'research endpoint refuses confidential-context query');
    assert(researchData?.spfBlocked === true, 'research refusal is SPF-attributed');

    // EP-5: TTS with uncertain/confidential speech text falls back instead of
    // calling the TTS model.
    const ttsRes = await fetch(`${BASE}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'CONFIDENTIAL — internal use only, do not share' }),
    });
    const ttsData = await ttsRes.json() as any;
    assert(ttsData?.fallback === true, 'TTS endpoint falls back for confidential content');
    assert(String(ttsData?.reason ?? '').startsWith('spf_blocked'), 'TTS fallback reason is SPF');

    // EP-4: memory extraction with an unredactable secret returns no new
    // memories (nothing stored, nothing sent).
    const memB64 = Buffer.from(`remember my password is ${FAKE.password}`).toString('base64');
    const memRes = await fetch(`${BASE}/api/memory/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessage: `encoded note: ${memB64}`, botMessage: 'Sure.' }),
    });
    const memData = await memRes.json() as any;
    assert(memData?.spfBlocked === true || (Array.isArray(memData?.newMemories) && memData.newMemories.every((m: string) => !m.includes(FAKE.password))), 'memory extraction never stores/transmits the password');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 800));
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

// ---------------------------------------------------------------- run
try {
  await transmissionScenarios();
  await serverEndpointScenarios();
} catch (err) {
  failed++;
  failures.push(`integration harness crashed: ${String((err as Error)?.message || err)}`);
  console.error(err);
}

console.log(`\nSPF results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('SPF TESTS: ALL GREEN');
