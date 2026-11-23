export type AvatarExpression =
  | 'neutral'
  | 'gentle_smile'
  | 'playful_smirk'
  | 'pout_jealous'
  | 'curious_tilt'
  | 'flustered_blush'
  | 'thoughtful_gaze'
  | 'happy_sparkle'
  | 'listening_attentive'
  // Backward compatibility presets:
  | 'warm'
  | 'playful'
  | 'pout'
  | 'happy'
  | 'listening';

export type VoiceModel = 'Aoede' | 'Zephyr' | 'Leda' | 'Kore' | 'Puck' | 'Fenrir' | string;

export interface EmotionAnalysis {
  expression: AvatarExpression;
  intensity: number; // 0.0 to 1.0
  gesture: 'none' | 'tilt_left' | 'tilt_right' | 'subtle_nod' | 'glance_away' | 'shyness' | 'perk_up';
  blushLevel: number; // 0.0 to 1.0
  sentiment:
    | 'positive'
    | 'teasing'
    | 'affectionate'
    | 'comforting'
    | 'jealous'
    | 'curious'
    | 'reflective'
    | 'neutral';
}

export interface WebAction {
  type: 'open_website' | 'search_website';
  siteName: string;
  query?: string;
  url: string;
  icon?: string;
  category?: string;
}

export interface LocalFileAction {
  type: 'search_file' | 'open_file' | 'list_files' | 'scan_folder';
  query?: string;
  folderName?: string;
  matchedFiles?: {
    id: string;
    name: string;
    folderName?: string;
    folderPath?: string;
    size: number;
    extension: string;
    category: string;
    blobUrl?: string;
  }[];
}

export interface LaptopAppAction {
  type: 'launch_app' | 'list_apps';
  appName: string;
  protocol?: string;
  fallbackUrl?: string;
  category?: string;
  description?: string;
}

export interface UserLocation {
  lat: number;
  lng: number;
  accuracy?: number;
  formattedAddress?: string;
  city?: string;
  neighborhood?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  street?: string;
  googleMapsUrl: string;
  embedUrl?: string;
  source?: string;
  timestamp: number;
  googleMapsPriority?: boolean;
  usedAlternative?: boolean;
  mapsFailureReason?: string;
  gpsFailureReason?: string;
}

export interface MapsGroundingPlace {
  title: string;
  uri: string;
  address?: string;
  reviewSnippets?: string[];
}

export interface MapsLocationAction {
  type: 'current_location' | 'search_place' | 'directions' | 'grounding';
  lat?: number;
  lng?: number;
  accuracy?: number;
  formattedAddress?: string;
  city?: string;
  neighborhood?: string;
  country?: string;
  googleMapsUrl: string;
  embedUrl?: string;
  query?: string;
  destination?: string;
  googleMapsPriority?: boolean;
  usedAlternative?: boolean;
  source?: string;
  mapsFailureReason?: string;
  gpsFailureReason?: string;
  mapsGrounding?: MapsGroundingPlace[];
  groundingUsed?: boolean;
}

export interface GlobeAction {
  type: 'fly_to' | 'set_layer' | 'reset_view' | 'open_globe' | 'wind_on' | 'wind_off' | 'zoom_detail' | 'set_detail_mode';
  lat?: number;
  lng?: number;
  zoom?: number;
  locationName?: string;
  layer?: 'satellite' | 'dark' | 'standard' | 'terrain';
  detailLevel?: 'globe' | 'regional' | 'city' | 'photorealistic_3d';
  engineMode?: 'threejs' | 'google_earth';
}

export type HabitCategory = 'health' | 'productivity' | 'mindfulness' | 'fitness' | 'learning' | 'routine';
export type HabitTimeOfDay = 'morning' | 'afternoon' | 'evening' | 'anytime';
export type HabitFrequency = 'daily' | 'weekdays' | 'weekends';

export interface DailyHabit {
  id: string;
  title: string;
  description?: string;
  category: HabitCategory;
  timeOfDay: HabitTimeOfDay;
  targetTime?: string; // HH:mm
  frequency: HabitFrequency;
  completedDates: string[]; // YYYY-MM-DD
  streak: number;
  bestStreak: number;
  createdAt: number;
  reminderEnabled?: boolean;
  icon?: string;
  color?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  time?: string; // HH:mm
  category?: HabitCategory | 'general';
  completed?: boolean;
  notes?: string;
  habitId?: string;
}

export interface HabitAction {
  type: 'check_in' | 'complete_habit' | 'add_habit' | 'view_habits' | 'reminder';
  habitId?: string;
  habitTitle?: string;
  summary?: string;
  todayProgress: {
    completed: number;
    total: number;
    percentage: number;
  };
  habits: {
    id: string;
    title: string;
    category: HabitCategory;
    timeOfDay: HabitTimeOfDay;
    targetTime?: string;
    completed: boolean;
    streak: number;
  }[];
}

export interface DetectedScreenText {
  text: string;
  kind?: string;
  confidence?: number;
}

export interface DetectedScreenElement {
  type: string;
  text?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  confidence?: number;
  actionable?: boolean;
}

export interface ScreenVisionAction {
  type: 'observe' | 'read_text' | 'detect_changes' | 'active_window';
  question?: string;
  summary: string;
  application?: string;
  activeWindowTitle?: string;
  textSummary?: string;
  texts: DetectedScreenText[];
  elements?: DetectedScreenElement[];
  dialogs?: { kind: string; text?: string; confidence?: number }[];
  errors?: string[];
  warnings?: string[];
  snapshotUrl?: string;
  timestamp: number;
}

export interface Message {
  id: string;
  role: 'user' | 'model';
  content: string;
  timestamp: number;
  expression?: AvatarExpression;
  emotionData?: EmotionAnalysis;
  webAction?: WebAction;
  fileAction?: LocalFileAction;
  appAction?: LaptopAppAction;
  mapsAction?: MapsLocationAction;
  globeAction?: GlobeAction;
  habitAction?: HabitAction;
  screenVisionAction?: ScreenVisionAction;
  mapsGrounding?: MapsGroundingPlace[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export type LanguagePreference = 'auto' | 'en' | 'hi' | 'multilingual';

export interface CompanionSettings {
  userName: string;
  voiceEnabled: boolean;
  wakeWordEnabled: boolean;
  voiceName: string;
  voiceSpeed: number;
  voicePitch?: number;
  languagePreference?: LanguagePreference;
  companionNotes: string;
  voiceEngine?: 'auto' | 'gemini' | 'browser';
  // Offline vision (default ON): Krix's computer use, screen targeting and
  // agent screen observation run fully on-device — screenshots are never
  // uploaded. The "look at screen" button uses local OCR instead of cloud
  // vision while this is on. Stored settings without the key fall back to ON.
  offlineVision?: boolean;
  // Step 4 — Proactive Conversations (all optional: stored settings without
  // these keys fall back to the defaults below).
  proactiveConversations?: boolean;
  proactiveInactivityMinutes?: number;
  proactiveMinIntervalHours?: number;
  proactiveQuietHoursEnabled?: boolean;
  proactiveQuietHoursStart?: number;
  proactiveQuietHoursEnd?: number;
}

export type ActiveModal =
  | null
  | 'conversations'
  | 'memory'
  | 'vault'
  | 'settings'
  | 'files'
  | 'apps'
  | 'file_viewer'
  | 'location'
  | 'web_browser'
  | 'globe'
  | 'transcribe'
  | 'habits'
  | 'arcade'
  | 'screen_vision';
