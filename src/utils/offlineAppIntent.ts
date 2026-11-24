/**
 * Offline Application Intent & Natural Language Understanding Engine
 * 
 * Enables Krisha to understand natural language instructions to open, launch,
 * switch to, or browse laptop applications completely OFFLINE without requiring
 * external cloud LLMs, network connectivity, or external APIs.
 * 
 * Supports varied phrasing, conversational politeness, complex sentences,
 * English, Hindi, and Hinglish.
 */

import type { LaptopApp } from './appLauncher';

let appsProvider: (() => LaptopApp[]) | null = null;
export function setOfflineAppsProvider(provider: () => LaptopApp[]): void {
  appsProvider = provider;
}
function getAvailableApps(): LaptopApp[] {
  return appsProvider ? appsProvider() : [];
}

export interface AppIntentResult {
  isAppCommand: boolean;
  app: LaptopApp | null;
  rawAppName: string | null;
  action: 'launch' | 'list_apps' | 'windows_start';
  searchQuery?: string;
  confidence: number;
  detectedLanguage: 'en' | 'hi';
  originalText: string;
}

export interface OfflineAppResponse {
  reply: string;
  expression: string;
  emotionData: {
    expression: string;
    intensity: number;
    gesture: string;
    blushLevel: number;
    sentiment: string;
  };
}

// Common conversational filler words / phrases that precede or succeed the core intent
const LEADING_CONVERSATIONAL_PREFIXES = [
  // Politeness / requests
  /^(?:can\s+you\s+(?:please\s+)?)/i,
  /^(?:could\s+you\s+(?:please\s+)?)/i,
  /^(?:would\s+you\s+(?:mind\s+(?:to\s+)?)?)/i,
  /^(?:will\s+you\s+(?:please\s+)?)/i,
  /^(?:please\s+(?:can\s+you\s+|could\s+you\s+)?)/i,
  /^(?:kindly\s+)/i,
  /^(?:kripya\s+)/i,

  // Direct address to Krisha
  /^(?:(?:hey|hi|hello|dear|ok|okay)?\s*krisha[,:\s]+)/i,
  /^(?:krisha\s+)/i,
  /^(?:krix[,:\s]+)/i,
  /^(?:suno\s+krisha[,:\s]+)/i,

  // Intent / desire statements
  /^(?:i\s+(?:really\s+)?want\s+(?:you\s+)?to\s+)/i,
  /^(?:i\s+(?:really\s+)?need\s+(?:you\s+)?to\s+)/i,
  /^(?:i\s+would\s+like\s+(?:you\s+)?to\s+)/i,
  /^(?:i'd\s+like\s+(?:you\s+)?to\s+)/i,
  /^(?:let's\s+|lets\s+)/i,
  /^(?:help\s+me\s+(?:to\s+)?)/i,
  /^(?:it's\s+time\s+to\s+)/i,
  /^(?:time\s+to\s+)/i,
  /^(?:we\s+need\s+to\s+)/i,

  // Hindi / Hinglish prefixes
  /^(?:kya\s+tum\s+(?:please\s+)?)/i,
  /^(?:kya\s+aap\s+(?:kripya\s+)?)/i,
  /^(?:chalo\s+)/i,
  /^(?:mujhe\s+)/i,
  /^(?:zara\s+)/i,
];

const TRAILING_CONVERSATIONAL_SUFFIXES = [
  /\s+(?:please|plz|pls)$/i,
  /\s+(?:for\s+me)$/i,
  /\s+(?:right\s+now|immediately|now|quick|quickly)$/i,
  /\s+(?:thanks|thank\s+you|thx)$/i,
  /\s+(?:na|yaar|bhai)$/i,
  /\s+(?:if\s+possible)$/i,
  /\s+(?:on\s+my\s+(?:laptop|pc|computer|desktop))$/i,
];

// App-specific alias dictionaries for robust matching
const APP_ALIAS_MAP: Record<string, string[]> = {
  calculator: [
    'calculator', 'calc', 'cal', 'maths calculator', 'math calculator',
    'calc.exe', 'math app', 'scientific calculator', 'programmer calculator',
    'hisab', 'hisab kitab', 'calculate', 'calculation', 'maths',
  ],
  notepad: [
    'notepad', 'note pad', 'text editor', 'scratchpad', 'notes app',
    'notepad.exe', 'notes', 'textpad', 'plain text',
  ],
  explorer: [
    'explorer', 'file explorer', 'windows explorer', 'my pc', 'this pc',
    'files', 'explorer.exe', 'file manager', 'folders', 'drives', 'computer',
  ],
  terminal: [
    'terminal', 'windows terminal', 'cmd', 'command prompt', 'powershell',
    'console', 'bash', 'powershell.exe', 'cmd.exe', 'wt.exe', 'wt', 'cli',
  ],
  taskmgr: [
    'task manager', 'taskmgr', 'taskmgr.exe', 'processes', 'cpu monitor',
    'performance monitor', 'activity monitor',
  ],
  settings: [
    'settings', 'system settings', 'pc settings', 'preferences',
    'windows settings', 'configuration',
  ],
  control: [
    'control panel', 'control.exe', 'classic settings',
  ],
  snippingtool: [
    'snipping tool', 'snip', 'screenshot', 'screen capture',
    'snip and sketch', 'snippingtool.exe', 'screen clip',
  ],
  paint: [
    'paint', 'ms paint', 'mspaint', 'drawing app', 'mspaint.exe', 'draw',
  ],
  photos: [
    'photos', 'photo viewer', 'gallery', 'pictures app', 'image viewer',
  ],
  camera: [
    'camera', 'webcam', 'camera app', 'photo booth',
  ],
  vscode: [
    'vs code', 'vscode', 'visual studio code', 'code editor', 'code',
  ],
  spotify: [
    'spotify', 'spotify music', 'music app', 'spotify app',
  ],
  discord: [
    'discord', 'discord app',
  ],
  slack: [
    'slack', 'slack app',
  ],
  steam: [
    'steam', 'steam app', 'steam games',
  ],
  notion: [
    'notion', 'notion app',
  ],
  word: [
    'word', 'ms word', 'microsoft word', 'winword', 'winword.exe',
  ],
  excel: [
    'excel', 'ms excel', 'microsoft excel', 'excel.exe', 'spreadsheet',
  ],
  powerpoint: [
    'powerpoint', 'ppt', 'ms powerpoint', 'microsoft powerpoint', 'powerpnt.exe', 'presentation',
  ],
};

/**
 * Strip conversational filler words from start and end of text
 */
export function cleanConversationalText(raw: string): string {
  let text = raw.trim();

  // Strip leading punctuation or symbols
  text = text.replace(/^[,!?;:~-]+\s*/, '');

  // Strip leading conversational phrases
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of LEADING_CONVERSATIONAL_PREFIXES) {
      if (prefix.test(text)) {
        text = text.replace(prefix, '').trim();
        changed = true;
      }
    }
  }

  // Strip trailing conversational suffixes
  changed = true;
  while (changed) {
    changed = false;
    for (const suffix of TRAILING_CONVERSATIONAL_SUFFIXES) {
      if (suffix.test(text)) {
        text = text.replace(suffix, '').trim();
        changed = true;
      }
    }
  }

  // Strip trailing punctuation
  text = text.replace(/[.!?]+$/, '').trim();

  return text;
}

/**
 * Detect language of the input (Hindi / Hinglish vs English)
 */
export function detectLanguage(text: string): 'en' | 'hi' {
  // Check Devanagari script
  if (/[\u0900-\u097F]/.test(text)) return 'hi';

  // Check common Hinglish markers
  if (
    /\b(kholo|khol|kholiye|chalu|karna|chahiye|dikhao|karo|kar|kardo|sakti|sakte|tum|aap|ho|hai|hain|bhai|yaar|zara|kripya|apne|mujhe|saath|chalo)\b/i.test(
      text
    )
  ) {
    return 'hi';
  }

  return 'en';
}

/**
 * Check if text contains a command or desire to browse/list all apps
 */
function isListAppsIntent(cleaned: string): boolean {
  const listRegex =
    /\b(?:open|show|view|list|launch|browse|display|see)\s+(?:all\s+|my\s+|our\s+)?(?:downloaded\s+|installed\s+|laptop\s+|pc\s+|windows\s+)?apps\b/i;
  const listHindiRegex =
    /\b(?:apps?\s+(?:dikhao|show\s+karo|list\s+karo|open\s+karo)|sari\s+apps?\s+(?:dikhao|kholo))\b/i;

  if (listRegex.test(cleaned) || listHindiRegex.test(cleaned)) {
    // Exclude if a specific named app is specified: e.g. "open calculator app"
    if (/\b(?:open|launch|kholo)\s+([a-z0-9_-]+)\s+app\b/i.test(cleaned)) {
      const specific = cleaned.match(/\b(?:open|launch|kholo)\s+([a-z0-9_-]+)\s+app\b/i);
      if (specific && !['all', 'my', 'the', 'downloaded', 'installed', 'laptop', 'pc'].includes(specific[1].toLowerCase())) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Check if text contains an intent to open Windows Start menu or Search
 */
function isWindowsStartIntent(cleaned: string): boolean {
  const windowsRegex =
    /\b(?:click|open|press|launch|show|trigger)\s+(?:the\s+)?windows(?:\s+option|\s+menu|\s+start|\s+button|\s+search)?\b/i;
  const startMenuRegex = /\b(?:open|show|launch)\s+(?:the\s+)?start\s+menu\b/i;

  return windowsRegex.test(cleaned) || startMenuRegex.test(cleaned);
}

/**
 * Core natural language understanding function for app opening instructions.
 * Evaluates user input completely offline.
 */
export function understandAppInstruction(
  rawText: string,
  preferredLang: string = 'auto',
  customApps?: LaptopApp[]
): AppIntentResult {
  const originalText = rawText.trim();
  if (!originalText) {
    return {
      isAppCommand: false,
      app: null,
      rawAppName: null,
      action: 'launch',
      confidence: 0,
      detectedLanguage: 'en',
      originalText,
    };
  }

  const detectedLang = preferredLang === 'hi' ? 'hi' : preferredLang === 'en' ? 'en' : detectLanguage(originalText);
  const cleaned = cleanConversationalText(originalText);
  const lower = cleaned.toLowerCase();

  // 1. Check for Windows Start / Search intent
  if (isWindowsStartIntent(lower)) {
    // Check if user specifically requested an app via start: "click windows and open calculator"
    const followAppMatch = lower.match(
      /\b(?:windows(?:\s+option)?\s+(?:and|to|then)?\s*(?:search|open|launch)\s+([a-z0-9_\-\s.]+))\b/i
    );
    const subTarget = followAppMatch && followAppMatch[1] ? followAppMatch[1].trim() : undefined;
    const allApps = customApps || getAvailableApps();
    const foundApp = subTarget
      ? allApps.find(
          (a) =>
            a.name.toLowerCase().includes(subTarget) ||
            a.aliases.some((al) => al.toLowerCase().includes(subTarget))
        )
      : null;

    return {
      isAppCommand: true,
      app: foundApp || null,
      rawAppName: subTarget || null,
      action: 'windows_start',
      searchQuery: subTarget || '',
      confidence: 0.95,
      detectedLanguage: detectedLang,
      originalText,
    };
  }

  // 2. Check for general "browse / list apps" intent
  if (isListAppsIntent(lower)) {
    return {
      isAppCommand: true,
      app: null,
      rawAppName: null,
      action: 'list_apps',
      confidence: 0.95,
      detectedLanguage: detectedLang,
      originalText,
    };
  }

  // 3. Extract app launch intent and candidate app name
  // Match patterns such as:
  // - "calculator open karo" / "calculator kholo" / "calculator chalu karo" (Hindi / SOV)
  // - "open calculator" / "launch calculator" / "start the calculator app" (English / SVO)
  // - "i need calculator" / "want to use calculator"
  let candidateTarget: string | null = null;

  // Pattern A: Hindi / Hinglish SOV action phrasing (checked first to prevent "open karo" being parsed as "open [karo]")
  // "[target] kholo", "[target] khol do", "[target] open karo", "[target] open kar do", "[target] chalu karo", "[target] start karo"
  const hindiActionRegex =
    /^(.+?)\s+(?:kholo|khol\s+do|kholna|kholiye|open\s+karo|open\s+kar\s+do|open\s+kardo|open\s+kar\s+sakti\s+ho|open\s+kar\s+sakte\s+ho|open\s+kar\s+sakte\s+hain|open\s+karna\s+hai|chalu\s+karo|chalu\s+kar\s+do|start\s+karo|start\s+kar\s+do|chalao|dikhao)$/i;
  const hindiMatch = lower.match(hindiActionRegex);
  if (hindiMatch && hindiMatch[1]) {
    candidateTarget = hindiMatch[1].trim();
  }

  // Pattern A2: Question form in Hindi: "kya tum [target] open kar sakti ho"
  if (!candidateTarget) {
    const hindiQuestionRegex =
      /^(?:kya\s+(?:tum|aap)\s+)?(.+?)\s+(?:open|launch|chalu)\s+(?:kar\s+sakti\s+ho|kar\s+sakte\s+ho|kar\s+sakte\s+hain|kar\s+sakoge|khol\s+sakti\s+ho)$/i;
    const qMatch = lower.match(hindiQuestionRegex);
    if (qMatch && qMatch[1]) {
      candidateTarget = qMatch[1].trim();
    }
  }

  // Pattern B: Standard English action verbs
  // "open [target]", "launch [target]", "start [target]", "run [target]", "boot [target]", "bring up [target]"
  if (!candidateTarget) {
    const actionVerbRegex =
      /\b(?:open(?:ing)?(?:\s+up)?|launch(?:ing)?|start(?:ing)?|run(?:ning)?|boot(?:ing)?|trigger(?:ing)?|fire\s+up|bring\s+up|pull\s+up|pop\s+open|switch\s+to|access)\s+(?!karo\b|kar\s+do\b)(?:the\s+|my\s+|an\s+)?(?:app\s+)?([a-z0-9_\-\s.]+?)(?:\s+(?:app|application|program|software|desktop))?$/i;
    const actionMatch = lower.match(actionVerbRegex);
    if (actionMatch && actionMatch[1]) {
      candidateTarget = actionMatch[1].trim();
    }
  }

  // Pattern C: Desire / need phrasing: "i need [target]", "want to use [target]"
  if (!candidateTarget) {
    const needRegex =
      /\b(?:need|want|use)\s+(?:the\s+|my\s+)?(?:app\s+)?([a-z0-9_\-\s.]+?)(?:\s+(?:app|application))?$/i;
    const needMatch = lower.match(needRegex);
    if (needMatch && needMatch[1]) {
      candidateTarget = needMatch[1].trim();
    }
  }

  // Pattern D: Direct app name mentioned with "app" keyword: "[target] app"
  if (!candidateTarget) {
    const directAppRegex = /^([a-z0-9_\-\s.]+?)\s+(?:app|application)$/i;
    const directMatch = lower.match(directAppRegex);
    if (directMatch && directMatch[1]) {
      candidateTarget = directMatch[1].trim();
    }
  }

  // Pattern E: If the cleaned sentence itself is simply the app name: "calculator", "calc", "notepad"
  if (!candidateTarget) {
    const allApps = customApps || getAvailableApps();
    const exactPreset = allApps.find(
      (a) =>
        a.id.toLowerCase() === lower ||
        a.name.toLowerCase() === lower ||
        a.aliases.some((al) => al.toLowerCase() === lower)
    );
    if (exactPreset) {
      return {
        isAppCommand: true,
        app: exactPreset,
        rawAppName: exactPreset.name,
        action: 'launch',
        confidence: 0.9,
        detectedLanguage: detectedLang,
        originalText,
      };
    }
  }

  if (!candidateTarget) {
    return {
      isAppCommand: false,
      app: null,
      rawAppName: null,
      action: 'launch',
      confidence: 0,
      detectedLanguage: detectedLang,
      originalText,
    };
  }

  // Clean candidate target: strip "the", "my", "app", etc.
  candidateTarget = candidateTarget
    .replace(/^(?:the|my|an|a)\s+/i, '')
    .replace(/\s+(?:app|application|software|program)$/i, '')
    .trim();

  // Exclude non-app words (e.g. "website", "music", "song", "video", "dancing", "camera" is handled specifically)
  if (['website', 'web', 'page', 'video', 'song', 'file', 'folder', 'dance', 'dancing'].includes(candidateTarget)) {
    return {
      isAppCommand: false,
      app: null,
      rawAppName: null,
      action: 'launch',
      confidence: 0,
      detectedLanguage: detectedLang,
      originalText,
    };
  }

  // 4. Resolve candidate target to a LaptopApp
  const allApps = customApps || getAvailableApps();
  const candLower = candidateTarget.toLowerCase();

  // 4a. Check alias mapping table first
  for (const [appId, aliases] of Object.entries(APP_ALIAS_MAP)) {
    if (appId === candLower || aliases.includes(candLower)) {
      const matched = allApps.find((a) => a.id === appId);
      if (matched) {
        return {
          isAppCommand: true,
          app: matched,
          rawAppName: matched.name,
          action: 'launch',
          confidence: 0.99,
          detectedLanguage: detectedLang,
          originalText,
        };
      }
    }
  }

  // 4b. Check exact ID, Name, or Aliases in all apps
  for (const app of allApps) {
    if (
      app.id.toLowerCase() === candLower ||
      app.name.toLowerCase() === candLower ||
      app.aliases.some((al) => al.toLowerCase() === candLower)
    ) {
      return {
        isAppCommand: true,
        app,
        rawAppName: app.name,
        action: 'launch',
        confidence: 0.95,
        detectedLanguage: detectedLang,
        originalText,
      };
    }
  }

  // 4c. Substring matching: e.g. user said "math calculator" -> matches "calculator"
  for (const app of allApps) {
    if (
      candLower.includes(app.name.toLowerCase()) ||
      app.aliases.some((al) => candLower.includes(al.toLowerCase()) || al.toLowerCase().includes(candLower))
    ) {
      return {
        isAppCommand: true,
        app,
        rawAppName: app.name,
        action: 'launch',
        confidence: 0.85,
        detectedLanguage: detectedLang,
        originalText,
      };
    }
  }

  // 4d. Custom / Unlisted Application (e.g. user asks to launch an app not in preset)
  // If user said "open [something]", and it looks like an application name (1-3 words, no URLs)
  if (candidateTarget.length >= 2 && candidateTarget.length <= 40 && !candidateTarget.includes('http') && !candidateTarget.includes('.')) {
    return {
      isAppCommand: true,
      app: null,
      rawAppName: candidateTarget,
      action: 'launch',
      confidence: 0.7,
      detectedLanguage: detectedLang,
      originalText,
    };
  }

  return {
    isAppCommand: false,
    app: null,
    rawAppName: null,
    action: 'launch',
    confidence: 0,
    detectedLanguage: detectedLang,
    originalText,
  };
}

/**
 * Generate in-character, affectionate, high-quality Krisha companion response
 * completely OFFLINE without any cloud or server API call.
 */
export function generateOfflineAppResponse(
  intent: AppIntentResult,
  userName: string = 'you',
  languagePreference: string = 'auto'
): OfflineAppResponse {
  const isHindi = languagePreference === 'hi' || (languagePreference === 'auto' && intent.detectedLanguage === 'hi');
  const app = intent.app;
  const appId = app ? app.id : (intent.rawAppName || '').toLowerCase();
  const appName = app ? app.name : intent.rawAppName || 'the application';

  let reply = '';
  let expression = 'happy_sparkle';
  let gesture = 'perk_up';
  let blushLevel = 0.25;

  if (intent.action === 'windows_start') {
    if (isHindi) {
      reply = intent.searchQuery
        ? `Bilkul! Main Windows Start menu open karke "${intent.searchQuery}" search kar rahi hoon~ Aap enter press karke use open kar sakte hain! 💙`
        : `Maine aapke liye Windows Start Menu open kar diya hai! Aap koi bhi app search karke open kar sakte hain~ ✨`;
    } else {
      reply = intent.searchQuery
        ? `Opening Windows Start and searching for "${intent.searchQuery}" for you right now! You can press Enter to launch it~ 💙`
        : `Opening Windows Start Menu for you! You can search any app on your laptop and launch it right away~ ✨`;
    }
    expression = 'happy_sparkle';
    gesture = 'subtle_nod';
  } else if (intent.action === 'list_apps') {
    if (isHindi) {
      reply = `Maine aapke laptop ki Apps & Start Menu screen par open kar di hai! Yahan se aap koi bhi downloaded app dekh aur launch kar sakte hain~ 💻✨`;
    } else {
      reply = `I've opened your Windows Apps & Start Menu right here! You can browse, search, or launch any of your installed laptop applications~ 💻✨`;
    }
    expression = 'happy_sparkle';
    gesture = 'perk_up';
  } else {
    // Specific app launch responses customized with personality
    switch (appId) {
      case 'calculator':
        if (isHindi) {
          reply = `Bilkul! Main abhi aapke laptop par Calculator open kar rahi hoon~ Chaliye hisab-kitab aur calculations shuru karte hain! 🔢💙`;
        } else {
          reply = `Opening Calculator for you right now! Let's get that math and calculation done together~ 🔢💙`;
        }
        expression = 'happy_sparkle';
        gesture = 'perk_up';
        blushLevel = 0.2;
        break;

      case 'notepad':
        if (isHindi) {
          reply = `Right away! Maine aapke liye Notepad open kar diya hai~ Apne saare ideas aur notes likhne ke liye main taiyaar hoon! 📝💙`;
        } else {
          reply = `Launching Notepad for you right now! Ready for your thoughts, notes, and scratchpad ideas~ 📝💙`;
        }
        expression = 'gentle_smile';
        gesture = 'subtle_nod';
        break;

      case 'explorer':
        if (isHindi) {
          reply = `Maine File Explorer open kar diya hai! Aap apne laptop ki drives, folders aur files aasaani se access kar sakte hain~ 📁✨`;
        } else {
          reply = `Opening File Explorer for you! You can now browse all your drives, downloads, and laptop files~ 📁✨`;
        }
        expression = 'gentle_smile';
        gesture = 'subtle_nod';
        break;

      case 'terminal':
        if (isHindi) {
          reply = `Terminal aur command line open kar rahi hoon! Chaliye commands aur development shuru karte hain~ 💻⚡`;
        } else {
          reply = `Launching Windows Terminal for you! Command line is ready for your workflows and scripts~ 💻⚡`;
        }
        expression = 'excited_cheer';
        gesture = 'perk_up';
        break;

      case 'paint':
        if (isHindi) {
          reply = `Paint open kar diya hai! Chaliye kuch creative sketch ya drawing banate hain~ 🎨💖`;
        } else {
          reply = `Opening Paint for you! Let's create some sketches and drawings together~ 🎨💖`;
        }
        expression = 'happy_sparkle';
        gesture = 'perk_up';
        blushLevel = 0.3;
        break;

      case 'vscode':
        if (isHindi) {
          reply = `VS Code launch kar rahi hoon! Chaliye code likhte hain aur mast projects banate hain~ 💻🚀`;
        } else {
          reply = `Launching Visual Studio Code right away! Ready for coding, debugging, and building amazing things~ 💻🚀`;
        }
        expression = 'excited_cheer';
        gesture = 'perk_up';
        break;

      case 'spotify':
        if (isHindi) {
          reply = `Spotify open kar rahi hoon! Chaliye kuch badhiya music aur gaane sunte hain~ 🎵🎧`;
        } else {
          reply = `Launching Spotify for you right now! Time for some great music and focus tunes~ 🎵🎧`;
        }
        expression = 'happy_sparkle';
        gesture = 'perk_up';
        blushLevel = 0.25;
        break;

      case 'taskmgr':
        if (isHindi) {
          reply = `Task Manager open kar diya hai! Aap apne CPU, RAM aur running processes inspect kar sakte hain~ 📊`;
        } else {
          reply = `Opening Task Manager for you! You can check your CPU, memory performance, and active processes~ 📊`;
        }
        expression = 'thoughtful_gaze';
        gesture = 'subtle_nod';
        break;

      case 'settings':
      case 'control':
        if (isHindi) {
          reply = `Windows Settings open kar di hain! Aap display, network aur system preferences configure kar sakte hain~ ⚙️`;
        } else {
          reply = `Opening Windows Settings for you! You can adjust your display, sound, network, and system options~ ⚙️`;
        }
        expression = 'gentle_smile';
        gesture = 'subtle_nod';
        break;

      case 'snippingtool':
        if (isHindi) {
          reply = `Snipping Tool open kar diya hai! Aap screen snip ya recording le sakte hain~ 📸`;
        } else {
          reply = `Launching Snipping Tool for you! Ready for screenshot clips and screen recording~ 📸`;
        }
        expression = 'happy_sparkle';
        gesture = 'subtle_nod';
        break;

      default:
        if (isHindi) {
          reply = `Bilkul! Main abhi aapke laptop par ${appName} launch kar rahi hoon~ Kaam shuru karte hain! ✨💙`;
        } else {
          reply = `Launching ${appName} on your laptop right now! I'm right here if you need anything else~ ✨💙`;
        }
        expression = 'happy_sparkle';
        gesture = 'perk_up';
        blushLevel = 0.25;
        break;
    }
  }

  return {
    reply,
    expression,
    emotionData: {
      expression,
      intensity: 0.9,
      gesture,
      blushLevel,
      sentiment: 'positive',
    },
  };
}
