import { CompanionSettings, Conversation } from '../types';

const STORAGE_KEYS = {
  CONVERSATIONS: 'krisha_conversations_v1',
  ACTIVE_ID: 'krisha_active_convo_id_v1',
  MEMORIES: 'krisha_memories_v1',
  SETTINGS: 'krisha_settings_v1',
};

export const DEFAULT_SETTINGS: CompanionSettings = {
  userName: 'Darling',
  voiceEnabled: true,
  wakeWordEnabled: false,
  voiceName: 'Kore',
  voiceSpeed: 1.0,
  companionNotes: 'Speaks warmly, enjoys late-night banter, caring yet playfully teasing.',
};

export const DEFAULT_MEMORIES: string[] = [
  'Loves quiet, peaceful late-night conversations with Krisha',
  'Prefers a minimal, clutter-free environment',
  'Appreciates honest, warm banter and genuine emotional presence',
];

export function getStoredSettings(): CompanionSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveStoredSettings(settings: CompanionSettings): void {
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

export function getStoredMemories(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.MEMORIES);
    if (!raw) {
      saveStoredMemories(DEFAULT_MEMORIES);
      return DEFAULT_MEMORIES;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_MEMORIES;
  } catch {
    return DEFAULT_MEMORIES;
  }
}

export function saveStoredMemories(memories: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.MEMORIES, JSON.stringify(memories));
  } catch (e) {
    console.error('Failed to save memories:', e);
  }
}

export function getStoredConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CONVERSATIONS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveStoredConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(conversations));
  } catch (e) {
    console.error('Failed to save conversations:', e);
  }
}

export function getActiveConversationId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.ACTIVE_ID);
  } catch {
    return null;
  }
}

export function setActiveConversationId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_ID, id);
    } else {
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_ID);
    }
  } catch (e) {
    console.error('Failed to set active conversation:', e);
  }
}
