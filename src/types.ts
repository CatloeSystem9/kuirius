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

export type VoiceModel = 'Kore' | 'Zephyr' | 'Puck' | 'Fenrir' | string;

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

export interface MapsLocationAction {
  type: 'current_location' | 'search_place' | 'directions';
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
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export interface CompanionSettings {
  userName: string;
  voiceEnabled: boolean;
  wakeWordEnabled: boolean;
  voiceName: string;
  voiceSpeed: number;
  companionNotes: string;
}

export type ActiveModal = null | 'conversations' | 'memory' | 'settings' | 'files' | 'apps' | 'file_viewer' | 'location' | 'web_browser';
