/**
 * Verification Test Suite: Offline App Intent Understanding & Launching
 * 
 * Verifies that Krisha can understand instructions like 'open calculator'
 * across diverse natural language phrasing, polite expressions, desires,
 * Hindi/Hinglish, and execute/generate responses completely offline.
 */

import {
  understandAppInstruction,
  generateOfflineAppResponse,
  detectLanguage,
  cleanConversationalText,
} from '../src/utils/offlineAppIntent';
import {
  detectAndParseAppLaunchCommand,
  getAllLaptopApps,
} from '../src/utils/appLauncher';
import {
  appDiscover,
  appLaunchByName,
} from '../systemAgentServer';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n=== 1. Testing Offline Natural Language Understanding (English & Polite Phrasing) ===');

  const englishTestCases = [
    'open calculator',
    'can you open calculator',
    'could you please open the calculator app',
    'please open up calculator for me',
    'open up calculator',
    'i want to open calculator',
    'i need calculator',
    'bring up the calculator',
    'launch calc',
    'start calculator',
    'fire up calculator',
    'open the app calculator',
    'hey krisha, open calculator please',
    'would you mind opening calculator',
  ];

  for (const phrase of englishTestCases) {
    const res = understandAppInstruction(phrase);
    assert(
      res.isAppCommand && res.app?.id === 'calculator',
      `"${phrase}" -> recognizes Calculator (action: ${res.action}, app: ${res.app?.name})`
    );
  }

  console.log('\n=== 2. Testing Offline NLU (Hindi & Hinglish Phrasing) ===');

  const hindiTestCases = [
    { phrase: 'calculator kholo', expectedApp: 'calculator' },
    { phrase: 'calculator khol do', expectedApp: 'calculator' },
    { phrase: 'calculator open karo', expectedApp: 'calculator' },
    { phrase: 'calculator open kar do', expectedApp: 'calculator' },
    { phrase: 'calculator chalu karo', expectedApp: 'calculator' },
    { phrase: 'kya tum calculator open kar sakti ho', expectedApp: 'calculator' },
    { phrase: 'notepad khol do', expectedApp: 'notepad' },
    { phrase: 'notepad open karo na', expectedApp: 'notepad' },
  ];

  for (const { phrase, expectedApp } of hindiTestCases) {
    const res = understandAppInstruction(phrase);
    assert(
      res.isAppCommand && res.app?.id === expectedApp,
      `"${phrase}" (Hindi/Hinglish) -> recognizes ${expectedApp} (detectedLang: ${res.detectedLanguage})`
    );
  }

  console.log('\n=== 3. Testing Other Common Native Apps ===');

  const appTestCases = [
    { phrase: 'open notepad', expectedId: 'notepad' },
    { phrase: 'launch terminal', expectedId: 'terminal' },
    { phrase: 'open command prompt', expectedId: 'terminal' },
    { phrase: 'open file explorer', expectedId: 'explorer' },
    { phrase: 'open task manager', expectedId: 'taskmgr' },
    { phrase: 'open paint', expectedId: 'paint' },
    { phrase: 'open settings', expectedId: 'settings' },
    { phrase: 'launch vs code', expectedId: 'vscode' },
    { phrase: 'open spotify for me', expectedId: 'spotify' },
  ];

  for (const { phrase, expectedId } of appTestCases) {
    const res = understandAppInstruction(phrase);
    assert(
      res.isAppCommand && res.app?.id === expectedId,
      `"${phrase}" -> recognizes ${expectedId} (${res.app?.name})`
    );
  }

  console.log('\n=== 4. Testing General App Catalog & Start Menu Intents ===');

  const catalogCases = [
    { phrase: 'open apps', expectedAction: 'list_apps' },
    { phrase: 'show my installed apps', expectedAction: 'list_apps' },
    { phrase: 'browse downloaded apps', expectedAction: 'list_apps' },
    { phrase: 'click windows option', expectedAction: 'windows_start' },
    { phrase: 'open start menu', expectedAction: 'windows_start' },
  ];

  for (const { phrase, expectedAction } of catalogCases) {
    const res = understandAppInstruction(phrase);
    assert(
      res.isAppCommand && res.action === expectedAction,
      `"${phrase}" -> recognizes ${expectedAction}`
    );
  }

  console.log('\n=== 5. Testing Offline Companion Response Generation ===');

  const calcIntent = understandAppInstruction('open calculator');
  const enResp = generateOfflineAppResponse(calcIntent, 'User', 'en');
  assert(
    enResp.reply.toLowerCase().includes('calculator') && enResp.reply.includes('math'),
    `English offline response mentions calculator and math: "${enResp.reply}"`
  );
  assert(
    enResp.expression === 'happy_sparkle' && Boolean(enResp.emotionData),
    `English offline response has valid emotion & expression (${enResp.expression})`
  );

  const hiResp = generateOfflineAppResponse(calcIntent, 'User', 'hi');
  assert(
    hiResp.reply.toLowerCase().includes('calculator') && hiResp.reply.includes('hisab'),
    `Hindi offline response is natural in-character Hindi: "${hiResp.reply}"`
  );

  console.log('\n=== 6. Testing detectAndParseAppLaunchCommand Integration ===');

  const detectCalc = detectAndParseAppLaunchCommand('can you please open calculator');
  assert(
    detectCalc.isAppCommand && detectCalc.app?.id === 'calculator',
    `detectAndParseAppLaunchCommand recognizes "can you please open calculator"`
  );

  const detectHindi = detectAndParseAppLaunchCommand('notepad open karo');
  assert(
    detectHindi.isAppCommand && detectHindi.app?.id === 'notepad',
    `detectAndParseAppLaunchCommand recognizes "notepad open karo"`
  );

  console.log('\n=== 7. Testing System Server App Discovery & Offline Launch Mapping ===');

  const discovered = await appDiscover();
  const hasCalc = discovered.some((a) => a.name.toLowerCase().includes('calc') || a.target.includes('calc'));
  const hasNotepad = discovered.some((a) => a.name.toLowerCase().includes('note') || a.target.includes('notepad'));
  assert(hasCalc, 'appDiscover() includes Calculator');
  assert(hasNotepad, 'appDiscover() includes Notepad');

  // Verify appLaunchByName resolves Calculator to ms-calculator: without errors
  // (We test the resolution and safe dispatch)
  try {
    const launchResult = await appLaunchByName('calculator');
    assert(
      launchResult.launched === 'Calculator' && launchResult.target === 'ms-calculator:',
      `appLaunchByName("calculator") maps to target "${launchResult.target}"`
    );
  } catch (err: any) {
    assert(false, `appLaunchByName("calculator") threw: ${err.message}`);
  }

  try {
    const launchNotepad = await appLaunchByName('notepad');
    assert(
      launchNotepad.launched === 'Notepad' && launchNotepad.target === 'notepad.exe',
      `appLaunchByName("notepad") maps to target "${launchNotepad.target}"`
    );
  } catch (err: any) {
    assert(false, `appLaunchByName("notepad") threw: ${err.message}`);
  }

  console.log(`\n========================================`);
  console.log(`Tests Completed: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
