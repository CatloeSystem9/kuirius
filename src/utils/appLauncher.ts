/**
 * Windows Start & Laptop Application Launcher
 * Enables Krisha to search, navigate, and launch native applications installed
 * on the user's laptop via Windows protocol schemes, system executable launching,
 * and custom app path support.
 */

export interface AppQuickTask {
  id: string;
  label: string;
  icon?: string;
  actionParam?: string;
}

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
  publisher?: string;
  executableName?: string;
  quickTasks?: AppQuickTask[];
  isPinned?: boolean;
}

export const PRESET_LAPTOP_APPS: LaptopApp[] = [
  // System Tools & Core Windows Utilities
  {
    id: 'notepad',
    name: 'Notepad',
    category: 'system',
    protocol: 'notepad:',
    fallbackUrl: undefined,
    iconName: 'FileText',
    description: 'Fast, lightweight Windows text and code scratchpad',
    aliases: ['notepad', 'note pad', 'text editor', 'notes app', 'notepad.exe'],
    publisher: 'Microsoft Corporation',
    executableName: 'notepad.exe',
    isPinned: true,
    quickTasks: [
      { id: 'new_doc', label: 'New Text Document' },
      { id: 'open_notes', label: 'Open Scratchpad' },
    ],
  },
  {
    id: 'calculator',
    name: 'Calculator',
    category: 'system',
    protocol: 'ms-calculator:',
    fallbackUrl: undefined,
    iconName: 'Calculator',
    description: 'Windows math, programmer, and scientific calculator',
    aliases: ['calculator', 'calc', 'maths calculator', 'calc.exe', 'math'],
    publisher: 'Microsoft Windows',
    executableName: 'calc.exe',
    isPinned: true,
    quickTasks: [
      { id: 'standard', label: 'Standard Calculator' },
      { id: 'scientific', label: 'Scientific Mode' },
      { id: 'programmer', label: 'Programmer Calculator' },
    ],
  },
  {
    id: 'explorer',
    name: 'File Explorer',
    category: 'system',
    protocol: 'explorer:',
    fallbackUrl: undefined,
    iconName: 'Folder',
    description: 'Browse local computer drives, files, and folders',
    aliases: ['explorer', 'file explorer', 'windows explorer', 'my pc', 'this pc', 'files', 'explorer.exe'],
    publisher: 'Microsoft Windows',
    executableName: 'explorer.exe',
    isPinned: true,
    quickTasks: [
      { id: 'this_pc', label: 'Open This PC' },
      { id: 'downloads', label: 'Open Downloads Folder' },
      { id: 'documents', label: 'Open Documents Folder' },
    ],
  },
  {
    id: 'terminal',
    name: 'Windows Terminal / PowerShell',
    category: 'dev',
    protocol: 'wt:',
    fallbackUrl: undefined,
    iconName: 'Terminal',
    description: 'Modern tabbed command line, PowerShell & Command Prompt',
    aliases: ['terminal', 'windows terminal', 'cmd', 'powershell', 'console', 'bash', 'powershell.exe', 'cmd.exe'],
    publisher: 'Microsoft Windows',
    executableName: 'wt.exe',
    isPinned: true,
    quickTasks: [
      { id: 'admin_ps', label: 'Open PowerShell as Admin' },
      { id: 'cmd_prompt', label: 'Command Prompt (cmd)' },
      { id: 'wsl', label: 'Open WSL / Ubuntu' },
    ],
  },
  {
    id: 'taskmgr',
    name: 'Task Manager',
    category: 'system',
    protocol: 'taskmgr:',
    fallbackUrl: undefined,
    iconName: 'Activity',
    description: 'Monitor CPU, memory, performance, and running laptop tasks',
    aliases: ['task manager', 'taskmgr', 'taskmgr.exe', 'processes', 'cpu monitor', 'performance'],
    publisher: 'Microsoft Windows',
    executableName: 'taskmgr.exe',
    quickTasks: [
      { id: 'perf', label: 'Performance Graphs' },
      { id: 'startup', label: 'Startup Apps Manager' },
    ],
  },
  {
    id: 'settings',
    name: 'Windows Settings',
    category: 'system',
    protocol: 'ms-settings:',
    fallbackUrl: undefined,
    iconName: 'Settings',
    description: 'Configure Windows display, sound, network, and privacy',
    aliases: ['settings', 'system settings', 'pc settings', 'control panel', 'preferences', 'windows settings'],
    publisher: 'Microsoft Windows',
    executableName: 'SystemSettings.exe',
    isPinned: true,
    quickTasks: [
      { id: 'display', label: 'Display & Brightness' },
      { id: 'network', label: 'Wi-Fi & Network' },
      { id: 'apps_settings', label: 'Installed Apps & Features' },
    ],
  },
  {
    id: 'control',
    name: 'Control Panel',
    category: 'system',
    protocol: 'control:',
    fallbackUrl: undefined,
    iconName: 'Sliders',
    description: 'Classic Windows configuration and device control',
    aliases: ['control panel', 'control.exe', 'classic settings'],
    publisher: 'Microsoft Windows',
    executableName: 'control.exe',
    quickTasks: [
      { id: 'devices', label: 'Devices and Printers' },
      { id: 'programs', label: 'Programs and Features' },
    ],
  },
  {
    id: 'snippingtool',
    name: 'Snipping Tool (Snip & Sketch)',
    category: 'system',
    protocol: 'ms-screenclip:',
    fallbackUrl: undefined,
    iconName: 'Crop',
    description: 'Capture screenshot clips, screen recording, and annotations',
    aliases: ['snipping tool', 'snip', 'screenshot', 'screen capture', 'snip and sketch', 'snippingtool.exe'],
    publisher: 'Microsoft Windows',
    executableName: 'SnippingTool.exe',
    quickTasks: [
      { id: 'new_snip', label: 'New Screen Snip' },
      { id: 'record', label: 'Screen Recording' },
    ],
  },
  {
    id: 'paint',
    name: 'Paint',
    category: 'media',
    protocol: 'ms-paint:',
    fallbackUrl: undefined,
    iconName: 'Palette',
    description: 'Classic digital drawing and image editing',
    aliases: ['paint', 'ms paint', 'mspaint', 'drawing app', 'mspaint.exe'],
    publisher: 'Microsoft Windows',
    executableName: 'mspaint.exe',
    quickTasks: [
      { id: 'new_canvas', label: 'New Drawing Canvas' },
    ],
  },
  {
    id: 'photos',
    name: 'Photos',
    category: 'media',
    protocol: 'ms-photos:',
    fallbackUrl: undefined,
    iconName: 'Image',
    description: 'View photos, video clips, and manage gallery albums',
    aliases: ['photos', 'photo viewer', 'gallery', 'pictures app'],
    publisher: 'Microsoft Windows',
    executableName: 'Microsoft.Photos.exe',
  },
  {
    id: 'camera',
    name: 'Camera',
    category: 'system',
    protocol: 'microsoft.windows.camera:',
    fallbackUrl: undefined,
    iconName: 'Camera',
    description: 'Webcam capture, video recording, and barcode scanner',
    aliases: ['camera', 'webcam', 'camera app', 'record video'],
    publisher: 'Microsoft Windows',
  },
  {
    id: 'clock',
    name: 'Clock & Alarms',
    category: 'system',
    protocol: 'ms-clock:',
    fallbackUrl: undefined,
    iconName: 'Clock',
    description: 'Timer, stopwatch, focus sessions, and alarms',
    aliases: ['clock', 'alarms', 'timer', 'stopwatch', 'focus sessions'],
    publisher: 'Microsoft Windows',
    quickTasks: [
      { id: 'timer', label: 'Start 10 Min Timer' },
      { id: 'stopwatch', label: 'Stopwatch' },
    ],
  },
  {
    id: 'store',
    name: 'Microsoft Store',
    category: 'system',
    protocol: 'ms-windows-store:',
    fallbackUrl: undefined,
    iconName: 'ShoppingBag',
    description: 'Discover and install Windows desktop applications & games',
    aliases: ['store', 'microsoft store', 'app store', 'windows store'],
    publisher: 'Microsoft Windows',
  },
  {
    id: 'defender',
    name: 'Windows Security',
    category: 'system',
    protocol: 'windowsdefender:',
    fallbackUrl: undefined,
    iconName: 'Shield',
    description: 'Virus & threat protection, firewall, and device security',
    aliases: ['windows security', 'defender', 'windows defender', 'antivirus'],
    publisher: 'Microsoft Windows',
    quickTasks: [
      { id: 'quick_scan', label: 'Run Quick Virus Scan' },
    ],
  },

  // Web Browsers
  {
    id: 'chrome',
    name: 'Google Chrome',
    category: 'productivity',
    protocol: 'googlechrome://',
    fallbackUrl: 'https://www.google.com/chrome',
    iconName: 'Globe',
    description: 'Fast, secure web browser with Google sync',
    aliases: ['chrome', 'google chrome', 'browser', 'google-chrome', 'chrome.exe'],
    publisher: 'Google LLC',
    executableName: 'chrome.exe',
    isPinned: true,
    quickTasks: [
      { id: 'new_window', label: 'New Window' },
      { id: 'incognito', label: 'New Incognito Window' },
    ],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    category: 'productivity',
    protocol: 'microsoft-edge:',
    fallbackUrl: 'https://www.microsoft.com/edge',
    iconName: 'Globe',
    description: 'Built-in fast AI-powered Windows web browser',
    aliases: ['edge', 'ms edge', 'microsoft edge', 'msedge.exe'],
    publisher: 'Microsoft Corporation',
    executableName: 'msedge.exe',
    isPinned: true,
    quickTasks: [
      { id: 'new_window', label: 'New Window' },
      { id: 'inprivate', label: 'New InPrivate Window' },
    ],
  },
  {
    id: 'firefox',
    name: 'Mozilla Firefox',
    category: 'productivity',
    protocol: 'firefox:',
    fallbackUrl: 'https://www.mozilla.org/firefox',
    iconName: 'Globe',
    description: 'Privacy-focused independent web browser',
    aliases: ['firefox', 'mozilla firefox', 'mozilla', 'firefox.exe'],
    publisher: 'Mozilla Foundation',
    executableName: 'firefox.exe',
  },
  {
    id: 'brave',
    name: 'Brave Browser',
    category: 'productivity',
    protocol: 'brave:',
    fallbackUrl: 'https://brave.com',
    iconName: 'Globe',
    description: 'Ad-blocking crypto & private web browser',
    aliases: ['brave', 'brave browser', 'brave.exe'],
    publisher: 'Brave Software Inc',
    executableName: 'brave.exe',
  },

  // Developer & Coding Tools
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    category: 'dev',
    protocol: 'vscode://',
    fallbackUrl: 'https://code.visualstudio.com',
    iconName: 'Code',
    description: 'Code editor & IDE for development with extensions',
    aliases: ['vscode', 'vs code', 'visual studio code', 'code', 'vsc', 'code.exe'],
    publisher: 'Microsoft Corporation',
    executableName: 'code.exe',
    isPinned: true,
    quickTasks: [
      { id: 'new_window', label: 'New Window' },
      { id: 'open_folder', label: 'Open Project Folder' },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor AI Editor',
    category: 'dev',
    protocol: 'cursor://',
    fallbackUrl: 'https://cursor.com',
    iconName: 'Sparkles',
    description: 'AI-first code editor built for lightning software development',
    aliases: ['cursor', 'cursor editor', 'cursor ai', 'cursor.exe'],
    publisher: 'Anysphere',
    executableName: 'cursor.exe',
    isPinned: true,
    quickTasks: [
      { id: 'new_chat', label: 'New AI Composer Session' },
    ],
  },
  {
    id: 'postman',
    name: 'Postman',
    category: 'dev',
    protocol: 'postman://',
    fallbackUrl: 'https://web.postman.co',
    iconName: 'Send',
    description: 'API development, request testing & documentation platform',
    aliases: ['postman', 'post man', 'postman.exe'],
    publisher: 'Postman Inc',
    executableName: 'postman.exe',
  },
  {
    id: 'sublime',
    name: 'Sublime Text',
    category: 'dev',
    protocol: 'subl://',
    fallbackUrl: 'https://www.sublimetext.com',
    iconName: 'FileCode',
    description: 'Fast, clean desktop text and code editor',
    aliases: ['sublime', 'sublime text', 'subl.exe'],
    publisher: 'Sublime HQ',
  },

  // Productivity & Office
  {
    id: 'word',
    name: 'Microsoft Word',
    category: 'productivity',
    protocol: 'ms-word:',
    fallbackUrl: 'https://www.office.com/launch/word',
    iconName: 'FileText',
    description: 'Document processor, rich writing & essays',
    aliases: ['word', 'ms word', 'microsoft word', 'winword', 'winword.exe'],
    publisher: 'Microsoft Corporation',
    executableName: 'winword.exe',
    isPinned: true,
    quickTasks: [
      { id: 'blank_doc', label: 'Blank Document' },
    ],
  },
  {
    id: 'excel',
    name: 'Microsoft Excel',
    category: 'productivity',
    protocol: 'ms-excel:',
    fallbackUrl: 'https://www.office.com/launch/excel',
    iconName: 'Table',
    description: 'Spreadsheets, formulas, charts & data analysis',
    aliases: ['excel', 'ms excel', 'microsoft excel', 'excel.exe'],
    publisher: 'Microsoft Corporation',
    executableName: 'excel.exe',
    isPinned: true,
    quickTasks: [
      { id: 'blank_wb', label: 'Blank Workbook' },
    ],
  },
  {
    id: 'powerpoint',
    name: 'Microsoft PowerPoint',
    category: 'productivity',
    protocol: 'ms-powerpoint:',
    fallbackUrl: 'https://www.office.com/launch/powerpoint',
    iconName: 'Presentation',
    description: 'Presentations, slide decks & pitch templates',
    aliases: ['powerpoint', 'ppt', 'ms powerpoint', 'microsoft powerpoint', 'powerpnt.exe'],
    publisher: 'Microsoft Corporation',
    executableName: 'powerpnt.exe',
    quickTasks: [
      { id: 'new_deck', label: 'New Presentation' },
    ],
  },
  {
    id: 'onenote',
    name: 'Microsoft OneNote',
    category: 'productivity',
    protocol: 'onenote:',
    fallbackUrl: 'https://www.onenote.com',
    iconName: 'StickyNote',
    description: 'Digital notebook for notes, research & sketching',
    aliases: ['onenote', 'ms onenote', 'one note'],
    publisher: 'Microsoft Corporation',
  },
  {
    id: 'mail',
    name: 'Mail & Outlook',
    category: 'productivity',
    protocol: 'mailto:',
    fallbackUrl: 'https://outlook.live.com',
    iconName: 'Mail',
    description: 'Email client, calendar & contact manager',
    aliases: ['mail', 'email', 'outlook', 'ms outlook', 'mail app', 'outlook.exe'],
    publisher: 'Microsoft Corporation',
    executableName: 'outlook.exe',
  },
  {
    id: 'calendar',
    name: 'System Calendar',
    category: 'productivity',
    protocol: 'ms-calendar:',
    fallbackUrl: 'https://calendar.google.com',
    iconName: 'Calendar',
    description: 'Events, meetings, alerts & daily schedule',
    aliases: ['calendar', 'events', 'schedule', 'google calendar'],
    publisher: 'Microsoft Windows',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'productivity',
    protocol: 'notion://',
    fallbackUrl: 'https://www.notion.so',
    iconName: 'BookOpen',
    description: 'All-in-one workspace for notes, tasks & wikis',
    aliases: ['notion', 'notion app', 'notion.exe'],
    publisher: 'Notion Labs Inc',
    executableName: 'notion.exe',
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    category: 'productivity',
    protocol: 'obsidian://',
    fallbackUrl: 'https://obsidian.md',
    iconName: 'Book',
    description: 'Second brain, linked notes & local Markdown knowledge graph',
    aliases: ['obsidian', 'obsidian notes', 'obsidian.exe'],
    publisher: 'Obsidian',
    executableName: 'obsidian.exe',
  },
  {
    id: 'figma',
    name: 'Figma Desktop',
    category: 'productivity',
    protocol: 'figma://',
    fallbackUrl: 'https://www.figma.com',
    iconName: 'Layout',
    description: 'Collaborative UI/UX design and prototyping tool',
    aliases: ['figma', 'figma app', 'figma desktop', 'figma.exe'],
    publisher: 'Figma Inc',
  },
  {
    id: 'googleearth',
    name: 'Google Earth Pro / Web',
    category: 'productivity',
    protocol: 'googleearth:',
    fallbackUrl: 'https://earth.google.com/web/',
    iconName: 'Globe',
    description: '3D satellite imagery, planetary navigation, and terrain',
    aliases: ['google earth', 'google earth pro', 'googleearth', 'earth app'],
    publisher: 'Google LLC',
  },

  // Social & Communication
  {
    id: 'discord',
    name: 'Discord',
    category: 'social',
    protocol: 'discord://',
    fallbackUrl: 'https://discord.com/app',
    iconName: 'MessageSquare',
    description: 'Voice channels, community servers, and instant messaging',
    aliases: ['discord', 'discord app', 'discord.exe'],
    publisher: 'Discord Inc',
    executableName: 'Discord.exe',
    isPinned: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'social',
    protocol: 'slack://',
    fallbackUrl: 'https://app.slack.com',
    iconName: 'Hash',
    description: 'Workplace channels, direct messaging & team collaboration',
    aliases: ['slack', 'slack app', 'slack.exe'],
    publisher: 'Salesforce',
    executableName: 'slack.exe',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp Desktop',
    category: 'social',
    protocol: 'whatsapp://',
    fallbackUrl: 'https://web.whatsapp.com',
    iconName: 'PhoneCall',
    description: 'End-to-end encrypted messaging, voice & video calling',
    aliases: ['whatsapp', 'whats app', 'whatsapp desktop', 'whatsapp.exe'],
    publisher: 'Meta Platforms Inc',
    executableName: 'WhatsApp.exe',
    isPinned: true,
  },
  {
    id: 'telegram',
    name: 'Telegram Desktop',
    category: 'social',
    protocol: 'tg://',
    fallbackUrl: 'https://web.telegram.org',
    iconName: 'Send',
    description: 'Fast, cloud-based messaging desktop client',
    aliases: ['telegram', 'tg', 'telegram desktop', 'telegram.exe'],
    publisher: 'Telegram FZ-LLC',
    executableName: 'Telegram.exe',
  },
  {
    id: 'zoom',
    name: 'Zoom Workplace',
    category: 'social',
    protocol: 'zoommtg://',
    fallbackUrl: 'https://zoom.us',
    iconName: 'Video',
    description: 'Video meetings, screen sharing & webinars',
    aliases: ['zoom', 'zoom app', 'zoom meeting', 'zoom.exe'],
    publisher: 'Zoom Video Communications',
    executableName: 'Zoom.exe',
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    category: 'social',
    protocol: 'msteams://',
    fallbackUrl: 'https://teams.microsoft.com',
    iconName: 'Users',
    description: 'Workplace chat, video calls & team workspaces',
    aliases: ['teams', 'ms teams', 'microsoft teams', 'teams.exe'],
    publisher: 'Microsoft Corporation',
    executableName: 'ms-teams.exe',
  },
  {
    id: 'skype',
    name: 'Skype',
    category: 'social',
    protocol: 'skype:',
    fallbackUrl: 'https://web.skype.com',
    iconName: 'Phone',
    description: 'Internet telephone and video call service',
    aliases: ['skype', 'skype.exe'],
    publisher: 'Microsoft Corporation',
  },

  // Media, Audio & Video
  {
    id: 'spotify',
    name: 'Spotify Desktop',
    category: 'media',
    protocol: 'spotify:',
    fallbackUrl: 'https://open.spotify.com',
    iconName: 'Music',
    description: 'Music streaming, podcasts, playlists & audio',
    aliases: ['spotify', 'spotify desktop', 'spotify app', 'music player', 'spotify.exe'],
    publisher: 'Spotify AB',
    executableName: 'Spotify.exe',
    isPinned: true,
    quickTasks: [
      { id: 'play', label: 'Resume Last Track' },
      { id: 'liked', label: 'Liked Songs' },
    ],
  },
  {
    id: 'vlc',
    name: 'VLC Media Player',
    category: 'media',
    protocol: 'vlc://',
    fallbackUrl: 'https://www.videolan.org/vlc',
    iconName: 'Film',
    description: 'Universal video and audio format desktop player',
    aliases: ['vlc', 'vlc player', 'vlc media player', 'vlc.exe'],
    publisher: 'VideoLAN Organization',
    executableName: 'vlc.exe',
  },
  {
    id: 'itunes',
    name: 'Apple Music / iTunes',
    category: 'media',
    protocol: 'itms://',
    fallbackUrl: 'https://music.apple.com',
    iconName: 'Disc',
    description: 'Apple Music library and desktop player',
    aliases: ['itunes', 'apple music', 'music'],
    publisher: 'Apple Inc',
  },

  // Gaming
  {
    id: 'steam',
    name: 'Steam',
    category: 'gaming',
    protocol: 'steam://open/main',
    fallbackUrl: 'https://store.steampowered.com',
    iconName: 'Gamepad2',
    description: 'PC gaming client, store & community library',
    aliases: ['steam', 'steam app', 'steam games', 'steam.exe'],
    publisher: 'Valve Corporation',
    executableName: 'steam.exe',
    isPinned: true,
    quickTasks: [
      { id: 'library', label: 'Game Library' },
      { id: 'store', label: 'Steam Store' },
      { id: 'friends', label: 'Friends & Chat' },
    ],
  },
  {
    id: 'xbox',
    name: 'Xbox App',
    category: 'gaming',
    protocol: 'ms-xbox:',
    fallbackUrl: 'https://www.xbox.com',
    iconName: 'Gamepad2',
    description: 'Xbox PC Game Pass, cloud gaming & achievements',
    aliases: ['xbox', 'xbox app', 'game pass'],
    publisher: 'Microsoft Corporation',
  },
  {
    id: 'epic',
    name: 'Epic Games Launcher',
    category: 'gaming',
    protocol: 'com.epicgames.launcher:',
    fallbackUrl: 'https://store.epicgames.com',
    iconName: 'Gamepad2',
    description: 'Epic games library, Unreal Engine & store',
    aliases: ['epic', 'epic games', 'epic launcher'],
    publisher: 'Epic Games Inc',
  },
];

const CUSTOM_APPS_KEY = 'krisha_custom_laptop_apps_v1';
const PINNED_APPS_KEY = 'krisha_pinned_laptop_apps_v1';
const RECENT_APPS_KEY = 'krisha_recent_laptop_apps_v1';

/**
 * Get all installed / registered apps (Presets + Custom)
 */
export function getAllLaptopApps(): LaptopApp[] {
  if (typeof window === 'undefined') return PRESET_LAPTOP_APPS;
  try {
    const rawCustom = localStorage.getItem(CUSTOM_APPS_KEY);
    const rawPinned = localStorage.getItem(PINNED_APPS_KEY);
    const pinnedSet = rawPinned ? new Set(JSON.parse(rawPinned)) : null;

    const custom: LaptopApp[] = rawCustom ? JSON.parse(rawCustom) : [];
    const all = [...PRESET_LAPTOP_APPS, ...custom];

    if (pinnedSet) {
      return all.map((app) => ({
        ...app,
        isPinned: pinnedSet.has(app.id) ?? app.isPinned,
      }));
    }
    return all;
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
 * Toggle pin status for an app in Windows Start
 */
export function togglePinLaptopApp(appId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = localStorage.getItem(PINNED_APPS_KEY);
    const set: string[] = raw ? JSON.parse(raw) : PRESET_LAPTOP_APPS.filter((a) => a.isPinned).map((a) => a.id);
    const index = set.indexOf(appId);
    let nextPinned = false;
    if (index >= 0) {
      set.splice(index, 1);
      nextPinned = false;
    } else {
      set.push(appId);
      nextPinned = true;
    }
    localStorage.setItem(PINNED_APPS_KEY, JSON.stringify(set));
    return nextPinned;
  } catch {
    return false;
  }
}

/**
 * Record an app launch into Recent Apps
 */
export function recordRecentApp(appId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(RECENT_APPS_KEY);
    let list: string[] = raw ? JSON.parse(raw) : [];
    list = [appId, ...list.filter((id) => id !== appId)].slice(0, 8);
    localStorage.setItem(RECENT_APPS_KEY, JSON.stringify(list));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Get recently launched apps
 */
export function getRecentApps(): LaptopApp[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_APPS_KEY);
    if (!raw) return [];
    const list: string[] = JSON.parse(raw);
    const all = getAllLaptopApps();
    return list.map((id) => all.find((a) => a.id === id)).filter(Boolean) as LaptopApp[];
  } catch {
    return [];
  }
}

/**
 * Trigger the native laptop OS app launch using protocol schemes and backend bridge
 */
export function launchLaptopApp(
  app: LaptopApp,
  options?: { asAdmin?: boolean; taskParam?: string }
): { success: boolean; method: 'protocol' | 'fallback' | 'host_bridge' } {
  if (typeof window === 'undefined') return { success: false, method: 'protocol' };

  recordRecentApp(app.id);

  // 1. Try host server-side launch bridge if available
  if (app.executableName || app.name) {
    fetch('/api/app/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: app.executableName || app.name,
        asAdmin: options?.asAdmin,
      }),
    }).catch(() => {
      // Backend bridge is optional; protocol click handles client-side OS launch
    });
  }

  try {
    // 2. Direct hidden anchor click with protocol scheme
    const targetUri = options?.taskParam ? `${app.protocol}${options.taskParam}` : app.protocol;
    const anchor = document.createElement('a');
    anchor.href = targetUri;
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
 * Launch an arbitrary app query or custom executable path entered by the user
 */
export function launchCustomExecutable(
  queryOrPath: string,
  asAdmin = false
): { success: boolean; name: string } {
  const clean = queryOrPath.trim();
  if (!clean) return { success: false, name: '' };

  const isPath = /[\\/]|\.exe$/i.test(clean);
  const appName = isPath ? clean.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') || clean : clean;

  // 1. Backend bridge
  fetch('/api/app/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      isPath
        ? { path: clean, asAdmin }
        : { name: clean, asAdmin }
    ),
  }).catch(() => {});

  // 2. Browser protocol fallback
  const proto = isPath ? `file:///${clean.replace(/\\/g, '/')}` : `${clean.toLowerCase()}:`;
  try {
    const a = document.createElement('a');
    a.href = proto;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      if (a.parentNode) document.body.removeChild(a);
    }, 1000);
  } catch {
    // ignore
  }

  return { success: true, name: appName };
}

/**
 * Search laptop apps by query and category
 */
export function searchLaptopApps(query: string, category?: string): LaptopApp[] {
  let list = getAllLaptopApps();

  if (category && category !== 'ALL') {
    if (category === 'pinned') {
      list = list.filter((a) => a.isPinned);
    } else {
      list = list.filter((a) => a.category === category);
    }
  }

  const clean = query.trim().toLowerCase();
  if (!clean) return list;

  return list.filter((app) => {
    const nameMatch = app.name.toLowerCase().includes(clean);
    const descMatch = app.description.toLowerCase().includes(clean);
    const aliasMatch = app.aliases.some((al) => al.toLowerCase().includes(clean));
    const protoMatch = app.protocol.toLowerCase().includes(clean);
    const execMatch = app.executableName?.toLowerCase().includes(clean);
    const pubMatch = app.publisher?.toLowerCase().includes(clean);
    return nameMatch || descMatch || aliasMatch || protoMatch || execMatch || pubMatch;
  });
}

/**
 * Parse user voice or chat command for launching downloaded laptop applications
 * Supports direct Windows option clicks, search bar intent, and app launches.
 */
export function detectAndParseAppLaunchCommand(text: string): {
  isAppCommand: boolean;
  app: LaptopApp | null;
  rawAppName: string | null;
  action: 'launch' | 'list_apps' | 'windows_start';
  searchQuery?: string;
} {
  const clean = text.trim();
  if (!clean) return { isAppCommand: false, app: null, rawAppName: null, action: 'launch' };

  const lower = clean.toLowerCase();

  // 1. Windows Start / Search intents:
  // e.g. "click windows", "click windows option", "open windows", "windows search", "open start menu"
  const windowsOptionRegex = /\b(?:click|open|press|launch|show)\s+(?:the\s+)?windows(?:\s+option|\s+menu|\s+start|\s+button|\s+search)?\b/i;
  const windowsWorkflowRegex = /\b(?:click\s+windows\s+(?:option\s+)?(?:then\s+)?search\s+(?:for\s+)?([a-z0-9_\-\s.]+?)(?:\s+(?:and|to)\s+open(?:\s+it)?)?)\b/i;

  const workflowMatch = lower.match(windowsWorkflowRegex);
  if (workflowMatch && workflowMatch[1]) {
    const target = workflowMatch[1].trim();
    const all = getAllLaptopApps();
    const found = all.find(
      (a) =>
        a.name.toLowerCase().includes(target) ||
        a.aliases.some((al) => al.toLowerCase().includes(target))
    );
    return {
      isAppCommand: true,
      app: found || null,
      rawAppName: target,
      action: 'windows_start',
      searchQuery: target,
    };
  }

  if (windowsOptionRegex.test(lower)) {
    // Check if a specific app was mentioned after: e.g. "click windows option and open notepad"
    const followAppMatch = lower.match(/\b(?:windows(?:\s+option)?\s+(?:and|to|then)?\s*(?:search|open|launch)\s+([a-z0-9_\-\s.]+))\b/i);
    const query = followAppMatch && followAppMatch[1] ? followAppMatch[1].trim() : undefined;
    const all = getAllLaptopApps();
    const found = query
      ? all.find(
          (a) =>
            a.name.toLowerCase().includes(query) ||
            a.aliases.some((al) => al.toLowerCase().includes(query))
        )
      : null;

    return {
      isAppCommand: true,
      app: found,
      rawAppName: query || null,
      action: 'windows_start',
      searchQuery: query || '',
    };
  }

  // 2. Search on search bar intent:
  // e.g. "search notepad on search bar", "search for calculator in windows"
  const searchBarRegex = /\bsearch\s+(?:for\s+)?([a-z0-9_\-\s.]+?)\s+(?:on|in)\s+(?:the\s+)?(?:search\s+bar|windows\s+search|windows)\b/i;
  const searchBarMatch = lower.match(searchBarRegex);
  if (searchBarMatch && searchBarMatch[1]) {
    const target = searchBarMatch[1].trim();
    const all = getAllLaptopApps();
    const found = all.find(
      (a) =>
        a.name.toLowerCase().includes(target) ||
        a.aliases.some((al) => al.toLowerCase().includes(target))
    );
    return {
      isAppCommand: true,
      app: found || null,
      rawAppName: target,
      action: 'windows_start',
      searchQuery: target,
    };
  }

  // 3. General "open downloaded apps", "open my apps", "show installed apps"
  const generalAppsRegex = /\b(?:open|show|view|list|launch|browse)\s+(?:all\s+|my\s+)?(?:downloaded\s+|installed\s+|laptop\s+|pc\s+|windows\s+)?apps\b/i;
  if (generalAppsRegex.test(clean) && !/\b(?:open|launch)\s+([a-z0-9_-]+)\s+app\b/i.test(clean)) {
    return {
      isAppCommand: true,
      app: null,
      rawAppName: null,
      action: 'list_apps',
    };
  }

  // 4. Specific App Commands:
  // e.g. "open spotify on my laptop", "open vs code", "launch discord", "start calculator app", "open notepad"
  const appCommandRegex = /\b(?:open|launch|start|run|trigger|boot)\s+(?:the\s+|my\s+)?(?:app\s+)?([a-z0-9_\-\s.]+?)(?:\s+(?:app|application|on\s+my\s+laptop|on\s+my\s+pc|on\s+my\s+computer|program|software|desktop))?$/i;
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
