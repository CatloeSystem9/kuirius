/**
 * SPF detection engine — local, deterministic, dependency-free.
 *
 * Detects credentials and sensitive content in text BEFORE any external
 * transmission. Detectors are pattern/structure based and run entirely on
 * device. They never capture the matched content beyond the span needed for
 * redaction, and never report it onward.
 *
 * Honest limitations (documented in SPF-ARCHITECTURE-REPORT.md §7):
 *  - pattern-based detection cannot recognize novel secret formats;
 *  - a secret fragmented across separate strings/fields evades per-string
 *    scanning (defense: transport-level guard + upstream provenance gates);
 *  - there is no local OCR, so IMAGE decisions are context-driven
 *    (window title, question, prior texts) — see visionGate.ts.
 */
import type { SpfFinding, SpfSeverity, SpfDetectionResult } from './spfTypes';
import { maskRedactionMarkers } from './redact';

// ------------------------------------------------------------- categories

export interface SpfCategoryDef {
  id: string;
  label: string;
  severity: SpfSeverity;
}

export const SPF_CATEGORIES: Record<string, SpfCategoryDef> = {
  password: { id: 'password', label: 'Password / credential pair', severity: 'never_transmit' },
  google_credential: { id: 'google_credential', label: 'Google account credential', severity: 'never_transmit' },
  otp: { id: 'otp', label: 'One-time password / verification code', severity: 'never_transmit' },
  bank_account: { id: 'bank_account', label: 'Bank account detail', severity: 'sensitive' },
  card_number: { id: 'card_number', label: 'Payment card number', severity: 'sensitive' },
  card_cvv: { id: 'card_cvv', label: 'Card security code (CVV/CVC)', severity: 'never_transmit' },
  api_key: { id: 'api_key', label: 'API key / access token', severity: 'never_transmit' },
  auth_token: { id: 'auth_token', label: 'Authentication token / session', severity: 'never_transmit' },
  private_key: { id: 'private_key', label: 'Private key material', severity: 'never_transmit' },
  seed_phrase: { id: 'seed_phrase', label: 'Wallet recovery / seed phrase', severity: 'never_transmit' },
  national_id: { id: 'national_id', label: 'National identity number', severity: 'sensitive' },
  confidential_context: { id: 'confidential_context', label: 'Confidential document / message marker', severity: 'uncertain' },
};

// -------------------------------------------------------------- detectors

export interface RawMatch {
  start: number;
  end: number;
  /**
   * Optional narrower span to REDACT (e.g. only the secret value inside a
   * labeled pair). Used so redaction inside JSON payloads stays VALID —
   * `{"password":"x"}` becomes `{"password":"[REDACTED-SPF:password]"}`.
   */
  redactStart?: number;
  redactEnd?: number;
  confidence?: number;
}

export interface SpfDetector {
  id: string;
  category: keyof typeof SPF_CATEGORIES;
  /** Confidence for pattern matches that carry no per-match override. */
  confidence: number;
  find(text: string): RawMatch[];
}

function regexDetector(
  id: string,
  category: keyof typeof SPF_CATEGORIES,
  confidence: number,
  pattern: RegExp,
  opts: { redactGroup?: number } = {}
): SpfDetector {
  return {
    id,
    category,
    confidence,
    find(text: string): RawMatch[] {
      // The 'd' flag exposes capture-group indices for value-only redaction.
      const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
      const re = new RegExp(pattern.source, opts.redactGroup !== undefined ? flags + 'd' : flags);
      const matches: RawMatch[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
        const match: RawMatch = { start: m.index, end: m.index + m[0].length };
        if (opts.redactGroup !== undefined && (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices) {
          const groupSpan = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices![opts.redactGroup];
          if (groupSpan) {
            match.redactStart = groupSpan[0];
            match.redactEnd = groupSpan[1];
          }
        }
        matches.push(match);
        if (matches.length >= 200) break; // bounded: hostile input cannot stall the gate
      }
      return matches;
    },
  };
}

/** Luhn checksum for card-like digit runs. */
export function luhnValid(digits: string): boolean {
  const compact = digits.replace(/\D/g, '');
  if (compact.length < 13 || compact.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = compact.length - 1; i >= 0; i--) {
    let d = compact.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Verhoeff checksum — real Aadhaar numbers pass it; random 4-4-4 digit
 * groupings (card numbers, phone numbers, timestamps) almost never do.
 * Without it the pattern would redact ordinary grouped numbers.
 */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
export function verhoeffValid(digits: string): boolean {
  const compact = digits.replace(/\D/g, '');
  if (compact.length < 12) return false;
  let c = 0;
  const reversed = compact.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(reversed[i])]];
  }
  return c === 0;
}

/**
 * Password assignments: `password: x`, `passwd=x`, "password is hunter2",
 * login-form style `<input type="password">`. The VALUE is capture group 1 →
 * value-only redaction (keeps JSON payloads valid after rewrite).
 */
const PASSWORD_RE =
  /\b(?:pass(?:word|wort|code)?|passwd|pwd|passphrase|login(?:\s+password)?)\s*(?:is|:|=|：)\s*([^\s"'\\]{4,})/gi;
/** Credential pair: an email/user immediately followed by a password field. */
const CREDENTIAL_PAIR_RE =
  /\b(?:[\w.+-]+@[\w-]+\.[\w.]{2,}|user(?:name)?|login|account)\b[^;{\n]{0,60}?\bpass(?:word|wd)?\s*(?:is|:|=|：)\s*"?([^\s"'\\]{4,})/gi;
/** JSON-style credential fields: `"password":"hunter2"` (value group 1). */
const PASSWORD_JSONFIELD_RE = /\\?"(?:pass(?:word|wd|phrase)|passwort)\\?"\s*:\s*\\?"([^"\\\s]{3,})/gi;
/** Password hidden-input / autocomplete hints in HTML-ish screen text. */
const PASSWORD_FIELD_RE = /<input[^>]*type\s*=\s*["']?password["']?[^>]*>/gi;

/**
 * OTP contexts: keyword + digit group (digits = capture group 1).
 * Precision first — a bare 6-digit number is NOT an OTP unless an OTP
 * keyword is adjacent (within ~24 chars).
 */
const OTP_KEYWORD_DIGITS_RE =
  /\b(?:otp|one[\s-]?time\s*(?:password|code|pin|passcode)|verification\s*code|verify\s*code|security\s*code|login\s*code|auth(?:entication)?\s*code|2fa\s*code|authenticator\s*code|confirmation\s*code|sms\s*code|passcode)\b[^0-9"]{0,24}"?(\d{3,8})\b/gi;
/** Google-style codes (G-123456) and `code: 123456` assignments. */
const OTP_ASSIGN_RE = /\b(?:code|otp|pin)\s*(?:is|:|=|：)\s*\\?"?(\d{4,8})\b/gi;
const GOOGLE_CODE_RE = /\bG-\d{4,8}\b/g;
/** TOTP provisioning secrets (base32, otpauth:// URIs). */
const TOTP_SECRET_RE = /\botpauth:\/\/[^\s"']{8,}/gi;

/**
 * Google credentials: Google API keys, Google OAuth tokens/refresh tokens,
 * and "Sign in with Google"-style account+password adjacency handled by
 * CREDENTIAL_PAIR_RE above.
 */
/**
 * Google API keys. The prefix tolerates common OCR confusions (AIza read as
 * "Alza"/"A1za" — uppercase I vs lowercase l / digit 1) because this detector
 * runs on OCR-derived text; the trailing 35-char body requirement keeps the
 * pattern specific.
 */
const GOOGLE_API_KEY_RE = /\bA(?:I|l|1)za[0-9A-Za-z_-]{35}\b/g;
const GOOGLE_OAUTH_RE = /\b1\/\/[0-9A-Za-z_-]{24,}\b/g;

/** Bank details: IBAN, IFSC, SWIFT, routing/sort codes, labeled account numbers. */
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{2,4}){3,8}\b/g;
const BANK_LABEL_RE =
  /\b(?:account\s*(?:no|number|num)|acct\s*(?:no|number)?|iban|ifsc|swift\s*code|routing\s*(?:number|no)|sort\s*code)\b\s*(?:is|:|=|：)?\s*\\?"?([A-Za-z0-9][A-Za-z0-9 -]{4,32}[A-Za-z0-9])/gi;
/** JSON-style bank fields: `"account_number":"1234567890"` (value group 1). */
const BANK_JSONFIELD_RE = /\\?"(?:account[_-]?(?:no|number|num)|iban|ifsc|acct)\\?"\s*:\s*\\?"([A-Za-z0-9 ]{6,34})/gi;
const IFSC_RE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;

/** Payment cards: Luhn-validated 13-19 digit runs with common separators. */
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
/** JSON-style card fields: `"card_number":"4111111111111111"` (value group 1). */
const CARD_JSONFIELD_RE = /\\?"(?:card[_-]?(?:no|number|num)|card[_-]?number)\\?"\s*:\s*\\?"([\d -]{12,23})/gi;

/** Card CVV/security-code assignments — full payment credentials (group 1). */
const CVV_RE = /\b(?:cvv|cvc|csc|security\s*code(?:\s*\(card\))?)\s*(?:is|:|=|：)?\s*\\?"?(\d{3,4})\b/gi;
/** JSON-style CVV fields. */
const CVV_JSONFIELD_RE = /\\?"(?:cvv|cvc|csc|card[_-]?cvv)\\?"\s*:\s*\\?"?(\d{3,4})/gi;

/**
 * API keys and access tokens (high-confidence vendor prefixes first, then
 * labeled assignments and generic bearer/header tokens).
 */
const API_KEY_PREFIX_RE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9_-]{12,}|sk_test_[A-Za-z0-9_-]{12,}|pk_live_[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|ghr_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{15,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|npm_[A-Za-z0-9]{30,}|shpat_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|sq0atp-[A-Za-z0-9_-]{20,})\b/g;
const LABELED_KEY_RE =
  /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?token)\b\s*(?:is|:|=|：)\s*\\?"?([A-Za-z0-9._~+/=-]{8,})/gi;
/** JSON-style key fields: `"api_key":"sk-…"` (value group 1). */
const APIKEY_JSONFIELD_RE = /\\?"(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|token)\\?"\s*:\s*\\?"([^"\\\s]{8,})/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g;
const AUTH_HEADER_RE = /\b(?:authorization|proxy-authorization|x-api-key|x-auth-token)\s*:\s*([A-Za-z0-9._~+/=-]{8,})/gi;

/** Private key material (PEM headers, OpenSSH, PGP). */
const PRIVATE_KEY_RE = /-----BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE KEY(?:\s+BLOCK)?-----/g;

/** Wallet seed / recovery phrases: keyword + 12+ lowercase words. */
const SEED_PHRASE_RE =
  /\b(?:seed\s*phrase|recovery\s*phrase|secret\s*phrase|mnemonic)\b[^a-z0-9]{0,16}((?:\b[a-z]{3,8}\b[\s,]{0,2}){11,25})/gi;

/** National IDs: US SSN, Aadhaar, PAN (India), UK NINO. */
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const AADHAAR_RE = /\b\d{4}\s\d{4}\s\d{4}\b/g;
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const NINO_RE = /\b[A-CE-HJ-NP-RT-W][A-CE-HJ-NP-RT-W]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g;

/**
 * Confidential document/message markers — uncertain severity; they drive
 * conservative handling of screen-derived payloads, never redaction.
 */
const CONFIDENTIAL_RE =
  /\b(?:confidential|internal\s+use\s+only|do\s+not\s+(?:share|distribute|disclose)|trade\s+secret|proprietary\s+(?:and\s+)?(?:confidential|information)|company\s+secret|classified)\b/gi;
/** Payslips/medical/invoice context words — uncertain, precision-listed. */
const DOCUMENT_CONTEXT_RE =
  /\b(?:payslip|pay\s+stub|salary\s+slip|bank\s+statement|medical\s+record|prescription|tax\s+return|form\s+w-?2|invoice\s*(?:no|number)?\s*[:#:])/gi;

/** DB connection strings with inline credentials (password = group 1). */
const DB_URL_RE = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:([^\s/@]+)@[^\s"']{4,}/gi;

export function defaultDetectors(): SpfDetector[] {
  return [
    regexDetector('password.assign', 'password', 0.9, PASSWORD_RE, { redactGroup: 1 }),
    regexDetector('password.pair', 'password', 0.85, CREDENTIAL_PAIR_RE, { redactGroup: 1 }),
    regexDetector('password.jsonfield', 'password', 0.9, PASSWORD_JSONFIELD_RE, { redactGroup: 1 }),
    regexDetector('password.field', 'password', 0.95, PASSWORD_FIELD_RE),
    regexDetector('otp.keyword', 'otp', 0.92, OTP_KEYWORD_DIGITS_RE, { redactGroup: 1 }),
    regexDetector('otp.assign', 'otp', 0.88, OTP_ASSIGN_RE, { redactGroup: 1 }),
    regexDetector('otp.google', 'otp', 0.95, GOOGLE_CODE_RE),
    regexDetector('otp.totp', 'otp', 0.95, TOTP_SECRET_RE),
    regexDetector('google.apikey', 'google_credential', 0.95, GOOGLE_API_KEY_RE),
    regexDetector('google.oauth', 'google_credential', 0.9, GOOGLE_OAUTH_RE),
    regexDetector('bank.label', 'bank_account', 0.8, BANK_LABEL_RE, { redactGroup: 1 }),
    regexDetector('bank.jsonfield', 'bank_account', 0.85, BANK_JSONFIELD_RE, { redactGroup: 1 }),
    regexDetector('bank.iban', 'bank_account', 0.8, IBAN_RE),
    regexDetector('bank.ifsc', 'bank_account', 0.8, IFSC_RE),
    regexDetector('card.luhn', 'card_number', 0.85, CARD_CANDIDATE_RE),
    regexDetector('card.jsonfield', 'card_number', 0.85, CARD_JSONFIELD_RE, { redactGroup: 1 }),
    regexDetector('card.cvv', 'card_cvv', 0.9, CVV_RE, { redactGroup: 1 }),
    regexDetector('card.cvvjson', 'card_cvv', 0.9, CVV_JSONFIELD_RE, { redactGroup: 1 }),
    regexDetector('apikey.prefix', 'api_key', 0.92, API_KEY_PREFIX_RE),
    regexDetector('apikey.labeled', 'api_key', 0.85, LABELED_KEY_RE, { redactGroup: 1 }),
    regexDetector('apikey.jsonfield', 'api_key', 0.85, APIKEY_JSONFIELD_RE, { redactGroup: 1 }),
    regexDetector('auth.bearer', 'auth_token', 0.9, BEARER_RE),
    regexDetector('auth.jwt', 'auth_token', 0.9, JWT_RE),
    regexDetector('auth.header', 'auth_token', 0.85, AUTH_HEADER_RE, { redactGroup: 1 }),
    regexDetector('privatekey.pem', 'private_key', 0.98, PRIVATE_KEY_RE),
    regexDetector('seed.phrase', 'seed_phrase', 0.85, SEED_PHRASE_RE),
    regexDetector('id.ssn', 'national_id', 0.8, SSN_RE),
    regexDetector('id.aadhaar', 'national_id', 0.8, AADHAAR_RE),
    regexDetector('id.pan', 'national_id', 0.8, PAN_RE),
    regexDetector('id.nino', 'national_id', 0.8, NINO_RE),
    regexDetector('context.confidential', 'confidential_context', 0.65, CONFIDENTIAL_RE),
    regexDetector('context.document', 'confidential_context', 0.6, DOCUMENT_CONTEXT_RE),
    regexDetector('auth.dburl', 'auth_token', 0.85, DB_URL_RE, { redactGroup: 1 }),
  ];
}

/** IBANs are structurally validated (country prefix + length) to cut false positives. */
function plausibleIban(text: string, start: number, end: number): boolean {
  const s = text.slice(start, end);
  const compact = s.replace(/ /g, '');
  if (compact.length < 15 || compact.length > 34) return false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return false;
  // At least 8 digits — real IBANs are predominantly numeric.
  const digits = compact.replace(/\D/g, '').length;
  return digits >= 8;
}

// ------------------------------------------------------------ scan driver

export interface ScanOptions {
  /** Wall-clock deadline (ms since scan start) — exceeded → timedOut. */
  deadlineMs?: number;
  /** Use custom detectors (tests inject faulty/slow detectors). */
  detectors?: SpfDetector[];
  /** Skip structurally validated detectors (tests). */
  structural?: boolean;
}

interface AccumulatedFinding extends SpfFinding {
  _hasStructuralMatch: boolean;
}

/**
 * Scan one string. Fail-closed: any detector error marks the result
 * (decision layer converts to BLOCK). Runs detectors on the raw text; when
 * nothing is found, re-checks URI-decoded and base64-decoded variants for
 * PRESENCE (span-mapping across decodings is unreliable — presence-only
 * findings are reported with spans [0, text.length) so the decision layer
 * treats them as unmappable → BLOCK on strict transports).
 */
export function scanText(text: string, options: ScanOptions = {}): SpfDetectionResult {
  const detectors = options.detectors ?? defaultDetectors();
  const deadline = options.deadlineMs ? Date.now() + options.deadlineMs : 0;
  const findings: AccumulatedFinding[] = [];
  const detectorIds: string[] = [];
  let timedOut = false;
  let error = false;

  const runDetectors = (source: string, presenceOnly: boolean): void => {
    for (const detector of detectors) {
      if (deadline && Date.now() > deadline) {
        timedOut = true;
        return;
      }
      let matches: RawMatch[];
      try {
        matches = detector.find(source);
      } catch {
        error = true;
        return;
      }
      // Post-run check: a single slow detector must also trip the deadline
      // (the pre-run check alone only catches accumulated slowness).
      if (deadline && Date.now() > deadline) {
        timedOut = true;
        return;
      }
      if (matches.length === 0) continue;
      if (!detectorIds.includes(detector.id)) detectorIds.push(detector.id);
      const category = SPF_CATEGORIES[detector.category];
      for (const match of matches) {
        let confidence = match.confidence ?? detector.confidence;
        // Structural refinement: cards must pass Luhn, IBANs plausible, Aadhaars Verhoeff-valid.
        if (detector.category === 'card_number') {
          if (!options.structural && !luhnValid(source.slice(match.start, match.end))) continue;
        }
        if (detector.id === 'bank.ifsc' && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(source.slice(match.start, match.end))) continue;
        if (detector.id === 'bank.iban' && !plausibleIban(source, match.start, match.end)) continue;
        if (detector.id === 'id.aadhaar' && !options.structural && !verhoeffValid(source.slice(match.start, match.end))) continue;
        if (detector.id === 'bank.label' && /\b(?:iban|ifsc|swift)/i.test(source.slice(0, match.start).slice(-20) + source.slice(match.start, match.end))) {
          confidence = Math.max(confidence, 0.85);
        }
        if (presenceOnly) {
          // Variant-detected (URI/base64 decoded): unmappable span.
          findings.push({
            category: detector.category,
            severity: category.severity,
            confidence: confidence * 0.75,
            start: 0,
            end: Math.max(1, source.length),
            length: source.length,
            detectorId: detector.id + ':variant',
            _hasStructuralMatch: false,
          });
        } else {
          // Value-only redaction spans keep surrounding structure (JSON
          // quotes, labels) intact so rewrites stay valid.
          const redactStart = match.redactStart ?? match.start;
          const redactEnd = match.redactEnd ?? match.end;
          findings.push({
            category: detector.category,
            severity: category.severity,
            confidence,
            start: redactStart,
            end: redactEnd,
            length: redactEnd - redactStart,
            detectorId: detector.id,
            _hasStructuralMatch: true,
          });
        }
        if (findings.length >= 400) return;
      }
    }
  };

  try {
    runDetectors(text, false);
    // Findings that lie entirely INSIDE one of our own redaction markers are
    // false positives on our label (e.g. keyword detectors firing on
    // `[REDACTED-SPF:password]`) — the marker is not content. Drop them.
    if (findings.length > 0) {
      const markerSpans: Array<[number, number]> = [];
      const markerRe = /\[REDACTED-SPF:[a-z_]+\]/g;
      let mm: RegExpExecArray | null;
      while ((mm = markerRe.exec(text)) !== null) markerSpans.push([mm.index, mm.index + mm[0].length]);
      if (markerSpans.length > 0) {
        for (let i = findings.length - 1; i >= 0; i--) {
          const f = findings[i];
          if (markerSpans.some(([ms, me]) => f.start >= ms && f.end <= me)) findings.splice(i, 1);
        }
      }
    }
    if (!timedOut && !error && findings.length === 0 && text.length >= 8 && text.length <= 65536) {
      // Evasion-variant presence checks (URI-encoded, base64 segments).
      // Each decoded variant has markers masked BEFORE scanning: markers may
      // arrive percent-encoded (e.g. a redacted query embedded in a URL) and
      // decode into literal label text, which is not content.
      const variants = decodeVariants(text);
      for (const variant of variants) {
        if (deadline && Date.now() > deadline) {
          timedOut = true;
          break;
        }
        runDetectors(maskRedactionMarkers(variant), true);
        if (timedOut || error || findings.length > 0) break;
      }
    }
  } catch {
    error = true;
  }

  const maxSeverity = findings.reduce<SpfSeverity | null>((acc, f) => {
    if (!acc) return f.severity;
    const order: SpfSeverity[] = ['uncertain', 'sensitive', 'never_transmit'];
    return order.indexOf(f.severity) > order.indexOf(acc) ? f.severity : acc;
  }, null);

  // Findings with a Luhn-invalid card candidate were skipped; drop empties.
  const cleaned = findings.filter((f) => f.category !== 'card_number' || f._hasStructuralMatch);
  return { findings: cleaned, maxSeverity, timedOut, error, detectorIds };
}

/** Decoded variants for evasion checks. Bounded and side-effect free. */
function decodeVariants(text: string): string[] {
  const variants: string[] = [];
  // URI-encoded (single and repeated decode).
  try {
    let decoded = text;
    for (let i = 0; i < 2; i++) {
      const next = decodeURIComponent(decoded.replace(/\+/g, ' '));
      if (next === decoded) break;
      decoded = next;
    }
    if (decoded !== text) variants.push(decoded);
  } catch {
    /* malformed encoding — ignore */
  }
  // Base64 segments (data URLs, JSON payloads, long base64 runs). Segments
  // over 16KB are bulk binary (images/audio) — not inline secrets; skipping
  // them keeps the scan cheap and avoids noise from decoded binary garbage.
  const base64Re = /(?:data:[a-z0-9./+-]+;base64,|\b)[A-Za-z0-9+/=]{24,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = base64Re.exec(text)) !== null) {
    if (m[0].length > 16 * 1024) continue;
    try {
      const decoded = atobSafe(m[0].replace(/^[^,]*base64,/, ''));
      if (decoded && /[\x20-\x7E]{12,}/.test(decoded)) variants.push(decoded);
    } catch {
      /* not valid base64 */
    }
    if (variants.length >= 8) break;
  }
  return variants;
}

/** Environment-agnostic base64 decode (browser + Node, no Node APIs). */
function atobSafe(value: string): string | null {
  try {
    if (typeof atob === 'function') return atob(value);
    const globalAny = globalThis as unknown as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } };
    if (globalAny.Buffer) return globalAny.Buffer.from(value, 'base64').toString('utf8');
    return null;
  } catch {
    return null;
  }
}
