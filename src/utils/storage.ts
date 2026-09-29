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
  voiceName: 'Aoede',
  voiceSpeed: 1.0,
  voicePitch: 1.0,
  languagePreference: 'auto',
  companionNotes: 'Speaks sweetly and warmly in English & Hindi with an affectionate, natural charm.',
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
    const parsed = JSON.parse(raw);
    // Upgrade legacy default 'Kore' to the sweeter feminine 'Aoede' voice
    if (parsed.voiceName === 'Kore' && !parsed.voicePitch) {
      parsed.voiceName = 'Aoede';
      parsed.voicePitch = 1.25;
    }
    return { ...DEFAULT_SETTINGS, ...parsed };
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

export interface KrishaBackupBundle {
  version: number;
  exportedAt: string;
  sourceOrigin?: string;
  conversations?: Conversation[];
  activeConversationId?: string | null;
  memories?: string[];
  memoriesV2?: unknown;
  settings?: CompanionSettings;
  location?: unknown;
}

export function createKrishaBackupBundle(): KrishaBackupBundle {
  let settings: CompanionSettings | undefined;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (raw) settings = JSON.parse(raw);
  } catch {}

  let conversations: Conversation[] | undefined;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CONVERSATIONS);
    if (raw) conversations = JSON.parse(raw);
  } catch {}

  let memories: string[] | undefined;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.MEMORIES);
    if (raw) memories = JSON.parse(raw);
  } catch {}

  let memoriesV2: unknown = undefined;
  try {
    const raw = localStorage.getItem('krisha_agent_memory_v2');
    if (raw) memoriesV2 = JSON.parse(raw);
  } catch {}

  let activeId: string | null = null;
  try {
    activeId = localStorage.getItem(STORAGE_KEYS.ACTIVE_ID);
  } catch {}

  let location: unknown = undefined;
  try {
    const raw = localStorage.getItem('krisha_cached_location');
    if (raw) location = JSON.parse(raw);
  } catch {}

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    settings,
    conversations,
    activeConversationId: activeId,
    memories,
    memoriesV2,
    location,
  };
}

export function restoreKrishaBackupBundle(bundle: KrishaBackupBundle): {
  success: boolean;
  restoredMemoriesCount: number;
  restoredConversationsCount: number;
  message?: string;
} {
  try {
    if (!bundle || typeof bundle !== 'object') {
      return { success: false, restoredMemoriesCount: 0, restoredConversationsCount: 0, message: 'Invalid backup file format' };
    }

    if (bundle.settings) {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(bundle.settings));
    }

    let convoCount = 0;
    if (Array.isArray(bundle.conversations)) {
      localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(bundle.conversations));
      convoCount = bundle.conversations.length;
    }

    if (bundle.activeConversationId) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_ID, bundle.activeConversationId);
    }

    let memCount = 0;
    if (Array.isArray(bundle.memories)) {
      localStorage.setItem(STORAGE_KEYS.MEMORIES, JSON.stringify(bundle.memories));
      memCount = bundle.memories.length;
    }

    if (bundle.memoriesV2) {
      localStorage.setItem('krisha_agent_memory_v2', JSON.stringify(bundle.memoriesV2));
    }

    if (bundle.location) {
      localStorage.setItem('krisha_cached_location', JSON.stringify(bundle.location));
    }

    return {
      success: true,
      restoredMemoriesCount: memCount,
      restoredConversationsCount: convoCount,
    };
  } catch (err) {
    return {
      success: false,
      restoredMemoriesCount: 0,
      restoredConversationsCount: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
