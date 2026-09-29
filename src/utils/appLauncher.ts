/**
 * Laptop & Desktop Application Launcher
 * Enables Krisha to launch, trigger, and open native applications installed on the user's laptop
 * via OS protocol schemes (e.g., vscode://, spotify://, discord://, ms-calculator:, slack://, etc.)
 * with custom app registration support.
 */

export interface LaptopApp {
  id: string;
  name: string;
  category: 'dev' | 'productivity' | 'social' | 'media' | 'gaming' | 'system';
  protocol: string; // Primary OS deep URI scheme
  fallbackUrl?: string;
  iconName: string;
  description: string;
  aliases: string[];
  isCustom?: boolean;
}

export const PRESET_LAPTOP_APPS: LaptopApp[] = [
  // Developer & Coding Tools
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    category: 'dev',
    protocol: 'vscode://',
    fallbackUrl: 'https://code.visualstudio.com',
    iconName: 'Code',
    description: 'Code editor & IDE for development',
    aliases: ['vscode', 'vs code', 'visual studio code', 'code', 'vsc'],
  },
  {
    id: 'cursor',
    name: 'Cursor AI Editor',
    category: 'dev',
    protocol: 'cursor://',
    fallbackUrl: 'https://cursor.com',
    iconName: 'Sparkles',
    description: 'AI-first code editor',
    aliases: ['cursor', 'cursor editor', 'cursor ai'],
  },
  {
    id: 'terminal',
    name: 'Windows Terminal / Console',
    category: 'dev',
    protocol: 'wt:',
    fallbackUrl: undefined,
    iconName: 'Terminal',
    description: 'Command line terminal & PowerShell',
    aliases: ['terminal', 'windows terminal', 'cmd', 'powershell', 'console', 'bash'],
  },
  {
    id: 'postman',
    name: 'Postman',
    category: 'dev',
    protocol: 'postman://',
    fallbackUrl: 'https://web.postman.co',
    iconName: 'Send',
    description: 'API development & testing platform',
    aliases: ['postman', 'post man'],
  },
  {
    id: 'sublime',
    name: 'Sublime Text',
    category: 'dev',
    protocol: 'subl://',
    fallbackUrl: 'https://www.sublimetext.com',
    iconName: 'FileCode',
    description: 'Sophisticated text editor for code',
    aliases: ['sublime', 'sublime text'],
  },

  // Productivity & Office
  {
    id: 'notion',
    name: 'Notion',
    category: 'productivity',
    protocol: 'notion://',
    fallbackUrl: 'https://www.notion.so',
    iconName: 'BookOpen',
    description: 'Connected workspace for notes, docs, and tasks',
    aliases: ['notion', 'notion app'],
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    category: 'productivity',
    protocol: 'obsidian://',
    fallbackUrl: 'https://obsidian.md',
    iconName: 'Book',
    description: 'Knowledge base & markdown notes',
    aliases: ['obsidian', 'obsidian notes'],
  },
  {
    id: 'googleearth',
    name: 'Google Earth Pro / Web',
    category: 'productivity',
    protocol: 'googleearth:',
    fallbackUrl: 'https://earth.google.com/web/',
    iconName: 'Globe',
    description: '3D satellite imagery, planetary navigation, and terrain',
    aliases: ['google earth', 'google earth pro', 'googleearth', 'earth app', 'google earth desktop'],
  },
  {
    id: 'calculator',
    name: 'Calculator',
    category: 'system',
    protocol: 'ms-calculator:',
    fallbackUrl: undefined,
    iconName: 'Calculator',
    description: 'System calculation utility',
    aliases: ['calculator', 'calc', 'maths calculator'],
  },
  {
    id: 'word',
    name: 'Microsoft Word',
    category: 'productivity',
    protocol: 'ms-word:',
    fallbackUrl: 'https://www.office.com/launch/word',
    iconName: 'FileText',
    description: 'Word processor & document editor',
    aliases: ['word', 'ms word', 'microsoft word', 'winword'],
  },
  {
    id: 'excel',
    name: 'Microsoft Excel',
    category: 'productivity',
    protocol: 'ms-excel:',
    fallbackUrl: 'https://www.office.com/launch/excel',
    iconName: 'Table',
    description: 'Spreadsheets, charts & data analysis',
    aliases: ['excel', 'ms excel', 'microsoft excel'],
  },
  {
    id: 'powerpoint',
    name: 'Microsoft PowerPoint',
    category: 'productivity',
    protocol: 'ms-powerpoint:',
    fallbackUrl: 'https://www.office.com/launch/powerpoint',
    iconName: 'Presentation',
    description: 'Presentations & slide decks',
    aliases: ['powerpoint', 'ppt', 'ms powerpoint', 'microsoft powerpoint'],
  },
  {
    id: 'onenote',
    name: 'Microsoft OneNote',
    category: 'productivity',
    protocol: 'onenote:',
    fallbackUrl: 'https://www.onenote.com',
    iconName: 'StickyNote',
    description: 'Digital notebook & sketching',
    aliases: ['onenote', 'ms onenote', 'one note'],
  },
  {
    id: 'mail',
    name: 'Mail & Outlook',
    category: 'productivity',
    protocol: 'mailto:',
    fallbackUrl: 'https://outlook.live.com',
    iconName: 'Mail',
    description: 'Email client & inbox',
    aliases: ['mail', 'email', 'outlook', 'ms outlook', 'mail app'],
  },
  {
    id: 'calendar',
    name: 'System Calendar',
    category: 'productivity',
    protocol: 'ms-calendar:',
    fallbackUrl: 'https://calendar.google.com',
    iconName: 'Calendar',
    description: 'Events, meetings & scheduling',
    aliases: ['calendar', 'events', 'schedule'],
  },

  // Social & Communication
  {
    id: 'discord',
    name: 'Discord',
    category: 'social',
    protocol: 'discord://',
    fallbackUrl: 'https://discord.com/app',
    iconName: 'MessageSquare',
    description: 'Voice, video and text chat communities',
    aliases: ['discord', 'discord app'],
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'social',
    protocol: 'slack://',
    fallbackUrl: 'https://app.slack.com',
    iconName: 'Hash',
    description: 'Workplace messaging & team collaboration',
    aliases: ['slack', 'slack app'],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp Desktop',
    category: 'social',
    protocol: 'whatsapp://',
    fallbackUrl: 'https://web.whatsapp.com',
    iconName: 'PhoneCall',
    description: 'End-to-end encrypted messaging & calls',
    aliases: ['whatsapp', 'whats app', 'whatsapp desktop'],
  },
  {
    id: 'telegram',
    name: 'Telegram Desktop',
    category: 'social',
    protocol: 'tg://',
    fallbackUrl: 'https://web.telegram.org',
    iconName: 'Send',
    description: 'Fast, secure messaging desktop app',
    aliases: ['telegram', 'tg', 'telegram desktop'],
  },
  {
    id: 'zoom',
    name: 'Zoom Workplace',
    category: 'social',
    protocol: 'zoommtg://',
    fallbackUrl: 'https://zoom.us',
    iconName: 'Video',
    description: 'Video conferencing & meetings',
    aliases: ['zoom', 'zoom app', 'zoom meeting'],
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    category: 'social',
    protocol: 'msteams://',
    fallbackUrl: 'https://teams.microsoft.com',
    iconName: 'Users',
    description: 'Team chats, video meetings and calling',
    aliases: ['teams', 'ms teams', 'microsoft teams'],
  },
  {
    id: 'skype',
    name: 'Skype',
    category: 'social',
    protocol: 'skype:',
    fallbackUrl: 'https://web.skype.com',
    iconName: 'Phone',
    description: 'Video calling and instant messaging',
    aliases: ['skype'],
  },

  // Media, Audio & Video
  {
    id: 'spotify',
    name: 'Spotify Desktop',
    category: 'media',
    protocol: 'spotify:',
    fallbackUrl: 'https://open.spotify.com',
    iconName: 'Music',
    description: 'Digital music, podcast & audio streaming',
    aliases: ['spotify', 'spotify desktop', 'spotify app', 'music player'],
  },
  {
    id: 'vlc',
    name: 'VLC Media Player',
    category: 'media',
    protocol: 'vlc://',
    fallbackUrl: 'https://www.videolan.org/vlc',
    iconName: 'Film',
    description: 'Versatile media & video player',
    aliases: ['vlc', 'vlc player', 'vlc media player'],
  },
  {
    id: 'itunes',
    name: 'Apple Music / iTunes',
    category: 'media',
    protocol: 'itms://',
    fallbackUrl: 'https://music.apple.com',
    iconName: 'Disc',
    description: 'Music library and audio store',
    aliases: ['itunes', 'apple music', 'music'],
  },
  {
    id: 'photos',
    name: 'Photos App',
    category: 'media',
    protocol: 'ms-photos:',
    fallbackUrl: undefined,
    iconName: 'Image',
    description: 'System photo library and editor',
    aliases: ['photos', 'photo viewer', 'gallery', 'pictures app'],
  },
  {
    id: 'paint',
    name: 'Paint',
    category: 'media',
    protocol: 'ms-paint:',
    fallbackUrl: undefined,
    iconName: 'Palette',
    description: 'Image creation and digital drawing',
    aliases: ['paint', 'ms paint', 'mspaint', 'drawing app'],
  },
  {
    id: 'camera',
    name: 'Camera',
    category: 'system',
    protocol: 'microsoft.windows.camera:',
    fallbackUrl: undefined,
    iconName: 'Camera',
    description: 'Webcam and camera recording',
    aliases: ['camera', 'webcam', 'camera app'],
  },

  // Gaming & Creative Design
  {
    id: 'steam',
    name: 'Steam',
    category: 'gaming',
    protocol: 'steam://open/main',
    fallbackUrl: 'https://store.steampowered.com',
    iconName: 'Gamepad2',
    description: 'PC gaming platform & library',
    aliases: ['steam', 'steam app', 'steam games'],
  },
  {
    id: 'figma',
    name: 'Figma Desktop',
    category: 'productivity',
    protocol: 'figma://',
    fallbackUrl: 'https://www.figma.com',
    iconName: 'Layout',
    description: 'Collaborative UI/UX design tool',
    aliases: ['figma', 'figma app', 'figma desktop'],
  },

  // System & OS Utilities
  {
    id: 'settings',
    name: 'Windows / System Settings',
    category: 'system',
    protocol: 'ms-settings:',
    fallbackUrl: undefined,
    iconName: 'Settings',
    description: 'System preferences, network, and displays',
    aliases: ['settings', 'system settings', 'control panel', 'preferences', 'pc settings'],
  },
  {
    id: 'clock',
    name: 'Clock & Alarms',
    category: 'system',
    protocol: 'ms-clock:',
    fallbackUrl: undefined,
    iconName: 'Clock',
    description: 'Timer, stopwatch, world clock, and alarms',
    aliases: ['clock', 'alarms', 'timer', 'stopwatch'],
  },
  {
    id: 'store',
    name: 'Microsoft Store / App Store',
    category: 'system',
    protocol: 'ms-windows-store:',
    fallbackUrl: undefined,
    iconName: 'ShoppingBag',
    description: 'App store and software manager',
    aliases: ['store', 'microsoft store', 'app store', 'windows store'],
  },
];

const CUSTOM_APPS_KEY = 'krisha_custom_laptop_apps_v1';

/**
 * Get all installed / registered apps (Presets + Custom)
 */
export function getAllLaptopApps(): LaptopApp[] {
  if (typeof window === 'undefined') return PRESET_LAPTOP_APPS;
  try {
    const raw = localStorage.getItem(CUSTOM_APPS_KEY);
    if (!raw) return PRESET_LAPTOP_APPS;
    const custom = JSON.parse(raw) as LaptopApp[];
    return [...PRESET_LAPTOP_APPS, ...custom];
  } catch {
    return PRESET_LAPTOP_APPS;
  }
}

/**
 * Save a custom laptop app
 */
export function saveCustomLaptopApp(app: Omit<LaptopApp, 'id' | 'isCustom'>): LaptopApp[] {
  if (typeof window === 'undefined') return PRESET_LAPTOP_APPS;
  const current = getAllLaptopApps().filter((a) => a.isCustom);
  const newApp: LaptopApp = {
    ...app,
    id: 'custom_app_' + Date.now(),
    isCustom: true,
  };
  const updated = [newApp, ...current];
  localStorage.setItem(CUSTOM_APPS_KEY, JSON.stringify(updated));
  return getAllLaptopApps();
}

/**
 * Delete a custom laptop app
 */
export function deleteCustomLaptopApp(id: string): LaptopApp[] {
  if (typeof window === 'undefined') return PRESET_LAPTOP_APPS;
  const current = getAllLaptopApps().filter((a) => a.isCustom && a.id !== id);
  localStorage.setItem(CUSTOM_APPS_KEY, JSON.stringify(current));
  return getAllLaptopApps();
}

/**
 * Trigger the native laptop OS app launch using protocol schemes
 */
export function launchLaptopApp(app: LaptopApp): { success: boolean; method: 'protocol' | 'fallback' } {
  if (typeof window === 'undefined') return { success: false, method: 'protocol' };

  try {
    // Attempt 1: Direct hidden anchor click with protocol scheme
    const anchor = document.createElement('a');
    anchor.href = app.protocol;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      if (anchor.parentNode) {
        document.body.removeChild(anchor);
      }
    }, 1000);

    return { success: true, method: 'protocol' };
  } catch (err) {
    console.warn('Protocol launch note:', err);
    if (app.fallbackUrl) {
      window.open(app.fallbackUrl, '_blank');
      return { success: true, method: 'fallback' };
    }
    return { success: false, method: 'protocol' };
  }
}

/**
 * Search laptop apps by query and category
 */
export function searchLaptopApps(query: string, category?: string): LaptopApp[] {
  let list = getAllLaptopApps();
  if (category && category !== 'ALL') {
    list = list.filter((a) => a.category === category);
  }

  const clean = query.trim().toLowerCase();
  if (!clean) return list;

  return list.filter((app) => {
    const nameMatch = app.name.toLowerCase().includes(clean);
    const descMatch = app.description.toLowerCase().includes(clean);
    const aliasMatch = app.aliases.some((al) => al.toLowerCase().includes(clean));
    const protoMatch = app.protocol.toLowerCase().includes(clean);
    return nameMatch || descMatch || aliasMatch || protoMatch;
  });
}

/**
 * Parse user voice or chat command for launching downloaded laptop applications
 */
export function detectAndParseAppLaunchCommand(text: string): {
  isAppCommand: boolean;
  app: LaptopApp | null;
  rawAppName: string | null;
  action: 'launch' | 'list_apps';
} {
  const clean = text.trim();
  if (!clean) return { isAppCommand: false, app: null, rawAppName: null, action: 'launch' };

  // 1. General "open downloaded apps", "open my apps", "show installed apps"
  const generalAppsRegex = /\b(?:open|show|view|list|launch|browse)\s+(?:all\s+|my\s+)?(?:downloaded\s+|installed\s+|laptop\s+|pc\s+)?apps\b/i;
  if (generalAppsRegex.test(clean) && !/\b(?:open|launch)\s+([a-z0-9_-]+)\s+app\b/i.test(clean)) {
    return {
      isAppCommand: true,
      app: null,
      rawAppName: null,
      action: 'list_apps',
    };
  }

  // 2. Specific App Commands:
  // e.g. "open spotify on my laptop", "open vs code", "launch discord", "start calculator app", "open whatsapp desktop"
  const appCommandRegex = /\b(?:open|launch|start|run|trigger|boot)\s+(?:the\s+|my\s+)?(?:app\s+)?([a-z0-9_\-\s]+?)(?:\s+(?:app|application|on\s+my\s+laptop|on\s+my\s+pc|on\s+my\s+computer|program|software|desktop))?$/i;
  const match = clean.match(appCommandRegex);

  if (match && match[1]) {
    const targetName = match[1].trim().toLowerCase();

    // Ignore generic non-app words or website search queries
    if (['website', 'web', 'page', 'video', 'song', 'file', 'folder', 'different folders', 'dancing', 'dance', 'camera'].includes(targetName)) {
      if (targetName === 'camera') {
        const cameraApp = PRESET_LAPTOP_APPS.find((a) => a.id === 'camera');
        return { isAppCommand: true, app: cameraApp || null, rawAppName: targetName, action: 'launch' };
      }
      return { isAppCommand: false, app: null, rawAppName: null, action: 'launch' };
    }

    const allApps = getAllLaptopApps();

    // Check alias matching
    for (const app of allApps) {
      if (
        app.id.toLowerCase() === targetName ||
        app.name.toLowerCase() === targetName ||
        app.aliases.some((al) => al.toLowerCase() === targetName) ||
        targetName.includes(app.name.toLowerCase()) ||
        app.aliases.some((al) => targetName.startsWith(al) || targetName.endsWith(al))
      ) {
        return {
          isAppCommand: true,
          app,
          rawAppName: targetName,
          action: 'launch',
        };
      }
    }

    // Direct match against known apps keywords
    const directFound = allApps.find(
      (a) =>
        a.name.toLowerCase().includes(targetName) ||
        a.aliases.some((al) => al.includes(targetName))
    );

    if (directFound) {
      return {
        isAppCommand: true,
        app: directFound,
        rawAppName: targetName,
        action: 'launch',
      };
    }
  }

  return {
    isAppCommand: false,
    app: null,
    rawAppName: null,
    action: 'launch',
  };
}
