import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Volume2, Move, RotateCcw, Compass, ExternalLink } from 'lucide-react';
import {
  AvatarExpression,
  CompanionSettings,
  Conversation,
  Message,
  ActiveModal,
  EmotionAnalysis,
  WebAction,
  LocalFileAction,
  LaptopAppAction,
  MapsLocationAction,
  UserLocation,
  GlobeAction,
  DailyHabit,
  CalendarEvent,
  HabitAction,
  ScreenVisionAction,
} from './types';
import {
  getStoredSettings,
  saveStoredSettings,
  getStoredConversations,
  saveStoredConversations,
  getActiveConversationId,
  setActiveConversationId,
  DEFAULT_SETTINGS,
} from './utils/storage';
import { speakKrishaText, stopKrishaSpeech, playWakeChime } from './utils/audio';
import { analyzeSentimentAndKeywords, normalizeExpression } from './utils/sentimentEngine';
import { detectAndParseWebAction, openExternalUrl } from './utils/webActions';
import {
  detectAndParseAppLaunchCommand,
  launchLaptopApp,
  LaptopApp,
} from './utils/appLauncher';
import {
  getStoredLocation,
  detectBackgroundLocation,
  requestBrowserGps,
  acquireFreshGpsLocationAndAddress,
  acquireLocationWithPriority,
  isLocationIntent,
  shouldOpenGoogleMaps,
  parseLocationStatement,
  geocodeAddress,
  buildMapsActionFromLocation,
} from './utils/locationService';
import { wakeWordManager, WakeWordResult, WakeWordStatus } from './utils/wakeWordListener';
import { OPEN_METEO_WIND_QUERY } from './components/globe/environment/envService';
import {
  parseFileCommand,
  searchLocalFiles,
  loadIndexedFiles,
  openOrDownloadFile,
  pickAndAddFiles,
  LocalIndexedFile,
} from './utils/fileSystemAccess';
import { KrishaAvatar, VideoAnimationPose } from './components/KrishaAvatar';
import { KrixAvatar, startKrixAudioAnalysis, stopKrixAudioAnalysis } from './components/KrixAvatar3D';
import { createAgentSystem, runAgentTask, isMultiStepRequest, isScreenIntent, isMouseIntent, isKeyboardIntent, isSystemIntent, isResearchIntent, type AgentSystem } from './agent/bridge';
import { spfScreenItem } from './agent/spf/index';
import { getMemoryService } from './agent/memory/memoryService';
import { attachMemoryToSystem } from './agent/memory/memoryBridge';
import { SidebarNav } from './components/SidebarNav';
import { ConversationsModal } from './components/ConversationsModal';
import { MemoryModal } from './components/MemoryModal';
import { LocalVaultModal } from './components/LocalVaultModal';
import { LpvApprovalCard } from './components/LpvApprovalCard';
import { SettingsModal } from './components/SettingsModal';
import { LocalFilesModal } from './components/LocalFilesModal';
import { AppsModal } from './components/AppsModal';
import { DirectChatInput } from './components/DirectChatInput';
import { ActivityStream } from './components/ActivityStream';
import { createActivityFeed, attachActivityFeedToSystem, type ActivityFeed, type ActivityEntry } from './utils/activityFeed';
import { WebActionCard } from './components/WebActionCard';
import { LocalFileActionCard } from './components/LocalFileActionCard';
import { AppActionCard } from './components/AppActionCard';
import { MapsLocationCard } from './components/MapsLocationCard';
import { RollbackApprovalCard } from './components/RollbackApprovalCard';
import { LocationDetailsModal } from './components/LocationDetailsModal';
import { DocumentViewerModal } from './components/DocumentViewerModal';
import { WebBrowserModal } from './components/WebBrowserModal';
import { GlobeModal } from './components/globe/GlobeModal';
import { AudioTranscriptionModal } from './components/AudioTranscriptionModal';
import { HabitActionCard } from './components/HabitActionCard';
import { HabitsModal } from './components/HabitsModal';
import { ScreenVisionCard } from './components/ScreenVisionCard';
import { ScreenVisionModal } from './components/ScreenVisionModal';
import { ArcadeModal } from './components/arcade/ArcadeModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { GameId } from './components/arcade/types';
import {
  loadHabits,
  loadCalendarEvents,
  toggleHabitCompletion,
  addHabit,
  deleteHabit,
  addCalendarEvent,
  deleteCalendarEvent,
  toggleCalendarEvent,
  formatHabitContextForPrompt,
  matchHabitInText,
  isHabitIntent,
  isCalendarIntent,
  isHabitCompletionReport,
  buildHabitAction,
  getTodayDateString,
} from './utils/habitStorage';

export default function App() {
  // State
  const [settings, setSettings] = useState<CompanionSettings>(getStoredSettings);
  // Memory state is the display view of the structured memory service (Phase 2).
  const [memories, setMemories] = useState<string[]>(() => getMemoryService().displayMemories());
  const [conversations, setConversations] = useState<Conversation[]>(getStoredConversations);
  const [activeConvoId, setActiveConvoId] = useState<string | null>(getActiveConversationId);

  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [arcadeInitialGame, setArcadeInitialGame] = useState<GameId | null>(null);
  const [initialFileSearch, setInitialFileSearch] = useState<string>('');
  const [initialFolderFilter, setInitialFolderFilter] = useState<string>('ALL');
  const [activeViewerFile, setActiveViewerFile] = useState<LocalIndexedFile | null>(null);
  const [availableIndexedFiles, setAvailableIndexedFiles] = useState<LocalIndexedFile[]>([]);

  // Background Google Maps Location State
  const [userLocation, setUserLocation] = useState<UserLocation | null>(getStoredLocation);
  const [activeLocationAction, setActiveLocationAction] = useState<MapsLocationAction | null>(null);
  const [isRefreshingLocation, setIsRefreshingLocation] = useState(false);

  // Dynamic Avatar Expression State
  const [expression, setExpression] = useState<AvatarExpression>('gentle_smile');
  const [emotionData, setEmotionData] = useState<EmotionAnalysis>({
    expression: 'gentle_smile',
    intensity: 0.75,
    gesture: 'subtle_nod',
    blushLevel: 0.3,
    sentiment: 'positive',
  });

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isDancing, setIsDancing] = useState(false);
  const [isGreeting, setIsGreeting] = useState(false);
  const [isThanked, setIsThanked] = useState(false);
  const [lookDirection, setLookDirection] = useState<'different_directions' | 'left' | 'right' | 'up' | 'down' | 'around' | null>(null);
  const [lastSpokenText, setLastSpokenText] = useState<string>('It feels different when we\'re together...');
  const [forcedPose, setForcedPose] = useState<VideoAnimationPose | null>(null);
  const [activeWebAction, setActiveWebAction] = useState<WebAction | null>(null);
  const [activeFileAction, setActiveFileAction] = useState<LocalFileAction | null>(null);
  const [activeAppAction, setActiveAppAction] = useState<LaptopAppAction | null>(null);
  const [activeGlobeAction, setActiveGlobeAction] = useState<GlobeAction | null>(null);
  const [activeScreenVisionAction, setActiveScreenVisionAction] = useState<ScreenVisionAction | null>(null);
  const [initialAppSearch, setInitialAppSearch] = useState<string>('');

  // Daily Habits & Calendar State
  const [habits, setHabits] = useState<DailyHabit[]>(loadHabits);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>(loadCalendarEvents);
  const [activeHabitAction, setActiveHabitAction] = useState<HabitAction | null>(null);

  // Daily Habits action handlers
  const handleToggleHabit = (habitId: string, dateStr?: string) => {
    const targetDate = dateStr || getTodayDateString();
    const { habits: updatedHabits, updatedHabit, wasCompleted } = toggleHabitCompletion(
      habitId,
      targetDate,
      habits
    );
    setHabits(updatedHabits);
    if (updatedHabit && wasCompleted) {
      setForcedPose('waving_greeting');
      setExpression('happy_sparkle');
    }
    if (activeHabitAction) {
      setActiveHabitAction(buildHabitAction(updatedHabits, 'complete_habit', updatedHabit || undefined));
    }
  };

  const handleAddHabit = (
    habitData: Omit<DailyHabit, 'id' | 'completedDates' | 'streak' | 'bestStreak' | 'createdAt'>
  ) => {
    const { habits: updatedHabits } = addHabit(habitData, habits);
    setHabits(updatedHabits);
    if (activeHabitAction) {
      setActiveHabitAction(buildHabitAction(updatedHabits, 'check_in'));
    }
  };

  const handleDeleteHabit = (habitId: string) => {
    const updatedHabits = deleteHabit(habitId, habits);
    setHabits(updatedHabits);
    if (activeHabitAction) {
      setActiveHabitAction(buildHabitAction(updatedHabits, 'check_in'));
    }
  };

  const handleAddCalendarEvent = (eventData: Omit<CalendarEvent, 'id'>) => {
    const updatedEvents = addCalendarEvent(eventData, calendarEvents);
    setCalendarEvents(updatedEvents);
  };

  const handleDeleteCalendarEvent = (eventId: string) => {
    const updatedEvents = deleteCalendarEvent(eventId, calendarEvents);
    setCalendarEvents(updatedEvents);
  };

  const handleToggleCalendarEvent = (eventId: string) => {
    const updatedEvents = toggleCalendarEvent(eventId, calendarEvents);
    setCalendarEvents(updatedEvents);
  };

  const isWhiteBackground = isDancing || Boolean(lookDirection);

  // Auto-return to normal dark background and idle state after any background change
  useEffect(() => {
    if (!isWhiteBackground) return;

    // Graceful timer: duration gives enough time for the animation and voice to complete, then fades back to normal
    const timeoutDuration = isSpeaking ? 7500 : 5000;
    const timer = setTimeout(() => {
      setIsDancing(false);
      setLookDirection(null);
      setForcedPose(null);
    }, timeoutDuration);

    return () => clearTimeout(timer);
  }, [isWhiteBackground, isSpeaking, lookDirection, isDancing]);

  // Auto-reset greeting state after single greeting animation and speech complete
  useEffect(() => {
    if (!isGreeting && forcedPose !== 'waving_greeting') return;

    const timeoutDuration = isSpeaking ? 4800 : 3600;
    const timer = setTimeout(() => {
      setIsGreeting(false);
      if (forcedPose === 'waving_greeting') {
        setForcedPose(null);
      }
    }, timeoutDuration);

    return () => clearTimeout(timer);
  }, [isGreeting, forcedPose, isSpeaking]);

  // Auto-reset thank-you reaction after completion
  useEffect(() => {
    if (!isThanked) return;

    const timeoutDuration = isSpeaking ? 5200 : 4000;
    const timer = setTimeout(() => {
      setIsThanked(false);
    }, timeoutDuration);

    return () => clearTimeout(timer);
  }, [isThanked, isSpeaking]);

  // Only load stored verified location on mount; no continuous tracking
  useEffect(() => {
    let isMounted = true;
    detectBackgroundLocation().then((loc) => {
      if (isMounted && loc) {
        setUserLocation(loc);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  // ---- Agent Core (Phase 1) ----
  // Multi-step requests are delegated to the agent loop; single-step messages
  // keep the original inline flow below. UI components are untouched — the
  // agent surfaces its results through the same action cards / modals.
  const agentSystemRef = useRef<AgentSystem | null>(null);

  // ---- Action Transparency: live activity stream above the composer ----
  // One feed instance for the session; sentences come from REAL events only
  // (agent bus via attachActivityFeedToSystem + explicit state transitions
  // below). Running actions, approvals and important errors persist until
  // resolved/dismissed; everything else fades after ~5 s.
  const activityFeedRef = useRef<ActivityFeed | null>(null);
  if (!activityFeedRef.current) activityFeedRef.current = createActivityFeed();
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([]);
  const [activityArchive, setActivityArchive] = useState<ActivityEntry[]>([]);

  // ---- E5: emergency-stop status surface (Phase 3 audit) ----
  // The renderer holds NO deactivation authority (E5 M1c): this UI can show
  // the stop state and ACTIVATE it; recovery stays with the operator CLI.
  // The inline chat flow bypasses the Phase 18 gate, so model-initiated
  // web actions check the stop here before opening external URLs.
  const [emergencyStopState, setEmergencyStopState] = useState<{ active: boolean; kind?: string; generation?: number | null }>({ active: false });
  const refreshEmergencyStop = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/safety/stop');
      if (!res.ok) return;
      const body = await res.json();
      const snapshot = body?.result;
      const active = Boolean(snapshot && snapshot.kind !== 'INACTIVE');
      setEmergencyStopState({
        active,
        kind: snapshot?.kind,
        generation: snapshot?.generation ?? null,
      });
      // Action Transparency: reflect the real stop state in the stream.
      if (active) {
        activityFeedRef.current?.push('Emergency stop active — recovery requires the operator CLI.', 'error', { sticky: true, key: 'estop' });
      } else {
        activityFeedRef.current?.resolve('estop');
      }
    } catch {
      // server unreachable — keep the last known state
    }
  }, []);
  const activateEmergencyStop = useCallback(async (): Promise<void> => {
    try {
      await fetch('/api/safety/stop/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'operator requested emergency stop (UI)' }),
      });
    } catch {
      // local gate activation below still applies
    }
    agentSystemRef.current?.safety?.emergencyStopNow('operator requested emergency stop (UI)');
    activityFeedRef.current?.push('Emergency stop activated — tasks stopped and side effects blocked.', 'error', { sticky: true, key: 'estop' });
    await refreshEmergencyStop();
  }, [refreshEmergencyStop]);
  useEffect(() => {
    void refreshEmergencyStop();
  }, [refreshEmergencyStop]);
  /** Phase 3 audit: MODEL-initiated web actions must not open external URLs
   *  while an emergency stop is active — the inline chat path does not pass
   *  the Phase 18 gate, so the stop state is checked here. An unreachable
   *  server must not break ordinary chat; the authoritative agent-side gate
   *  keeps enforcing the stop for every tool. */
  const openExternalUrlIfNotStopped = useCallback(
    async (url: string): Promise<void> => {
      if (agentSystemRef.current?.safety?.emergencyStop?.isActive()) return;
      try {
        const res = await fetch('/api/safety/stop');
        if (res.ok) {
          const body = await res.json();
          if (body?.result?.kind && body.result.kind !== 'INACTIVE') return;
        }
      } catch {
        // server unreachable — fall back to the local gate verdict only
      }
      openExternalUrl(url);
    },
    []
  );

  useEffect(() => {
    const system = createAgentSystem({
      applyWebAction: (action) => setActiveWebAction(action),
      applyAppAction: (action) => setActiveAppAction(action),
      applyFileAction: (action) => setActiveFileAction(action),
      applyMapsAction: (action) => setActiveLocationAction(action),
      applyViewerFile: (file) => setActiveViewerFile(file),
      applyGlobeAction: (action) => {
        setActiveGlobeAction(action);
        setActiveModal('globe');
      },
      openModal: (modal) => setActiveModal(modal),
      setPose: (pose) => setForcedPose(pose as VideoAnimationPose),
      applyScreenVisionAction: (action) => {
        setActiveScreenVisionAction(action);
      },
    });
    const memoryAttachment = attachMemoryToSystem(system, getMemoryService());
    agentSystemRef.current = system;
    // Action Transparency: feed the stream from the real event bus.
    const feed = activityFeedRef.current!;
    const detachActivityBus = attachActivityFeedToSystem(feed, system.bus);
    const unsubscribeFeed = feed.subscribe((entries, archive) => {
      setActivityEntries(entries);
      setActivityArchive(archive);
    });
    return () => {
      unsubscribeFeed();
      detachActivityBus();
      memoryAttachment.detach();
      system.screenObserver?.stop();
      system.keyboardControl?.releaseAll().catch(() => undefined);
      system.core.cancelAll();
      system.detach();
      agentSystemRef.current = null;
    };
  }, []);

  const handleRefreshLocation = async () => {
    setIsRefreshingLocation(true);
    try {
      const fresh = await acquireFreshGpsLocationAndAddress();
      if (fresh.location) {
        setUserLocation(fresh.location);
        const action = buildMapsActionFromLocation(fresh.location);
        setActiveLocationAction(action);
      }
    } catch (err) {
      console.warn('Manual GPS refresh attempt failed:', err);
    } finally {
      setIsRefreshingLocation(false);
    }
  };

  const handleGreetingComplete = () => {
    setIsGreeting(false);
    if (forcedPose === 'waving_greeting') {
      setForcedPose(null);
    }
  };

  const handleThankComplete = () => {
    setIsThanked(false);
  };

  // Movable avatar and parallax pointer tracking
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const [pointerPos, setPointerPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isMoved, setIsMoved] = useState(false);
  const [avatarKey, setAvatarKey] = useState(0);
  const rafPointerRef = useRef<number | null>(null);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!mainContainerRef.current) return;
    const clientX = e.clientX;
    const clientY = e.clientY;

    if (rafPointerRef.current !== null) return;

    rafPointerRef.current = requestAnimationFrame(() => {
      rafPointerRef.current = null;
      if (!mainContainerRef.current) return;
      const rect = mainContainerRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const normX = Math.max(-1, Math.min(1, (clientX - centerX) / (rect.width / 2)));
      const normY = Math.max(-1, Math.min(1, (clientY - centerY) / (rect.height / 2)));
      setPointerPos({ x: normX, y: normY });
    });
  };

  const handleResetPosition = () => {
    setAvatarKey((prev) => prev + 1);
    setIsMoved(false);
  };

  // Get current active conversation messages
  const currentConversation = conversations.find((c) => c.id === activeConvoId);
  const messages: Message[] = currentConversation ? currentConversation.messages : [];

  // Initialize or get current active conversation
  useEffect(() => {
    if (conversations.length === 0) {
      const initialId = 'convo_' + Date.now();
      const initialText = `Hey ${settings.userName || 'there'}. I was just sitting here thinking about you. How was your day?`;
      const initialEmotion = analyzeSentimentAndKeywords(initialText);

      const initialConvo: Conversation = {
        id: initialId,
        title: 'Late Evening Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: 'init_1',
            role: 'model',
            content: initialText,
            timestamp: Date.now(),
            expression: initialEmotion.expression,
            emotionData: initialEmotion,
          },
        ],
      };
      setConversations([initialConvo]);
      setActiveConvoId(initialId);
      setActiveConversationId(initialId);
      saveStoredConversations([initialConvo]);
      setLastSpokenText(initialText);
      setExpression(initialEmotion.expression);
      setEmotionData(initialEmotion);
    } else if (!activeConvoId) {
      setActiveConvoId(conversations[0].id);
      setActiveConversationId(conversations[0].id);
      const latestMsg = conversations[0].messages[conversations[0].messages.length - 1];
      if (latestMsg) {
        setLastSpokenText(latestMsg.content);
        if (latestMsg.expression) {
          const norm = normalizeExpression(latestMsg.expression);
          setExpression(norm);
          setEmotionData(latestMsg.emotionData || analyzeSentimentAndKeywords(latestMsg.content));
        }
      }
    }
  }, []);

  // Update storage whenever state changes
  const handleSaveSettings = (newSettings: CompanionSettings) => {
    setSettings(newSettings);
    saveStoredSettings(newSettings);
  };

  const handleAddMemory = (newMemory: string) => {
    getMemoryService().remember(newMemory, { source: 'user_manual' });
    setMemories(getMemoryService().displayMemories());
  };

  const handleUpdateMemory = (index: number, newMemory: string) => {
    const record = getMemoryService().resolveDisplayIndex(index);
    if (record) {
      getMemoryService().update(record.id, newMemory);
    }
    setMemories(getMemoryService().displayMemories());
  };

  const handleDeleteMemory = (index: number) => {
    const record = getMemoryService().resolveDisplayIndex(index);
    if (record) {
      getMemoryService().forget(record.id);
    }
    setMemories(getMemoryService().displayMemories());
  };

  const handleSelectConversation = (id: string) => {
    setActiveConvoId(id);
    setActiveConversationId(id);
    const convo = conversations.find((c) => c.id === id);
    if (convo && convo.messages.length > 0) {
      const last = convo.messages[convo.messages.length - 1];
      if (last.role === 'model') {
        setLastSpokenText(last.content);
        const norm = normalizeExpression(last.expression);
        setExpression(norm);
        setEmotionData(last.emotionData || analyzeSentimentAndKeywords(last.content));
      }
    }
  };

  const handleNewConversation = () => {
    const newId = 'convo_' + Date.now();
    const welcomeText = `Hi ${settings.userName || 'you'}. I'm right here with you. What's on your mind?`;
    const emotion = analyzeSentimentAndKeywords(welcomeText);

    const newConvo: Conversation = {
      id: newId,
      title: 'New Conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: 'msg_' + Date.now(),
          role: 'model',
          content: welcomeText,
          timestamp: Date.now(),
          expression: emotion.expression,
          emotionData: emotion,
        },
      ],
    };
    const updated = [newConvo, ...conversations];
    setConversations(updated);
    setActiveConvoId(newId);
    setActiveConversationId(newId);
    saveStoredConversations(updated);
    setLastSpokenText(welcomeText);
    setExpression(emotion.expression);
    setEmotionData(emotion);
  };

  const handleDeleteConversation = (id: string) => {
    const updated = conversations.filter((c) => c.id !== id);
    setConversations(updated);
    saveStoredConversations(updated);
    if (activeConvoId === id) {
      if (updated.length > 0) {
        setActiveConvoId(updated[0].id);
        setActiveConversationId(updated[0].id);
      } else {
        handleNewConversation();
      }
    }
  };

  const handleResetAllData = () => {
    localStorage.clear();
    getMemoryService().reset();
    setMemories(getMemoryService().displayMemories());
    setSettings(DEFAULT_SETTINGS);
    saveStoredSettings(DEFAULT_SETTINGS);
    const freshId = 'convo_' + Date.now();
    const freshText = `Hello ${DEFAULT_SETTINGS.userName}. I'm glad we get to spend some quiet time together.`;
    const emotion = analyzeSentimentAndKeywords(freshText);

    const freshConvo: Conversation = {
      id: freshId,
      title: 'New Evening',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: 'fresh_1',
          role: 'model',
          content: freshText,
          timestamp: Date.now(),
          expression: emotion.expression,
          emotionData: emotion,
        },
      ],
    };
    setConversations([freshConvo]);
    setActiveConvoId(freshId);
    setActiveConversationId(freshId);
    saveStoredConversations([freshConvo]);
    setLastSpokenText(freshText);
    setExpression(emotion.expression);
    setEmotionData(emotion);
  };

  // Real-time sentiment tracking during active typing in chat drawer
  const handleTypingReaction = (text: string) => {
    if (!text.trim()) {
      return;
    }
    // Perform zero-latency client-side keyword & sentiment analysis
    const realtimeEmotion = analyzeSentimentAndKeywords(text);
    // Trigger responsive micro-tilt or attentive listening pose
    setExpression(realtimeEmotion.expression);
    setEmotionData({
      ...realtimeEmotion,
      intensity: 0.65, // anticipatory intensity
    });
  };

  // Interactive Touch Reaction on Krisha's 2D Model
  const handleAvatarReaction = (type: 'head' | 'heart' | 'wave') => {
    let text = '';
    let expr: AvatarExpression = 'gentle_smile';

    if (type === 'head') {
      const headQuotes = [
        "Ehehe... your hand feels so warm and gentle.",
        "Ah... are you patting my head? That tickles, but I like it.",
        "Mmm... I could stay like this forever with you.",
      ];
      text = headQuotes[Math.floor(Math.random() * headQuotes.length)];
      expr = 'flustered_blush';
    } else if (type === 'heart') {
      const heartQuotes = [
        "I can feel your warmth right here in my chest...",
        "Every beat of my heart resonates when we're together.",
        "You always know how to make my heart flutter...",
      ];
      text = heartQuotes[Math.floor(Math.random() * heartQuotes.length)];
      expr = 'thoughtful_gaze';
    } else if (type === 'wave') {
      const waveQuotes = [
        "Hello! I'm always right here by your side.",
        "Ehehe, looking at you always brightens my day!",
        "Hi there! What shall we talk about next?",
      ];
      text = waveQuotes[Math.floor(Math.random() * waveQuotes.length)];
      expr = 'happy_sparkle';
      setIsGreeting(true);
      setForcedPose('waving_greeting');
    }

    setLastSpokenText(text);
    setExpression(expr);
    const emotion = analyzeSentimentAndKeywords(text);
    setEmotionData({ ...emotion, expression: expr, intensity: 0.9 });

    if (settings.voiceEnabled) {
      speakKrishaText(
        text,
        settings.voiceName || 'Aoede',
        settings.voiceSpeed,
        () => setIsSpeaking(true),
        () => setIsSpeaking(false),
        undefined,
        settings.languagePreference || 'auto',
        settings.voicePitch ?? 1.0,
        settings.voiceEngine || 'auto'
      );
    } else {
      setIsSpeaking(true);
      const talkDuration = Math.min(5000, Math.max(2000, text.length * 50));
      setTimeout(() => {
        setIsSpeaking(false);
      }, talkDuration);
    }
  };

  // Directly capture and read user's screen with Gemini Vision
  const handleReadScreen = async (customPrompt?: string) => {
    try {
      setIsLoading(true);
      setExpression('listening_attentive');
      setForcedPose('playful_gesture');
      setLastSpokenText("Looking at your screen now. Please choose the window or screen you'd like me to see.");

      // Grant screen observation permission in session
      agentSystemRef.current?.permissions?.grant('screen.observation');

      const observer = agentSystemRef.current?.screenObserver;
      if (!observer) {
        throw new Error('Screen observation system is not initialized.');
      }

      const promptQuestion =
        customPrompt ||
        'Read and visually inspect this screen. Describe the application, window title, all visible and legible text, key buttons, and any errors or notable content factual and clearly.';

      const state = await observer.getCurrentState({
        analyze: 'cloud',
        question: promptQuestion,
      });

      const snapshotUrl = state.snapshotRef ? observer.getSnapshot(state.snapshotRef) : undefined;
      // SPF EP-12 — screen-derived content is sanitized BEFORE it becomes a
      // chat message (which persists to localStorage and feeds the cloud chat
      // request). Local display keeps working; secrets never persist.
      const spfCleanScreenText = (value: string): string =>
        spfScreenItem(value, 'local:screen-vision-message', state.id, 'summary').text;
      const actionData: ScreenVisionAction = {
        type: 'observe',
        question: customPrompt,
        summary: spfCleanScreenText(state.analysis.summary ?? ''),
        application: state.analysis.application || state.activeWindow?.title || 'Desktop / Browser Screen',
        activeWindowTitle: state.activeWindow?.title,
        textSummary: state.analysis.texts?.map((t) => t.text).filter(Boolean).join(' • '),
        texts: (state.analysis.texts || []).map((t) => ({ ...t, text: spfCleanScreenText(t.text) })),
        elements: state.analysis.elements || [],
        dialogs: state.analysis.dialogs?.map((d) => ({ ...d, text: d.text ? spfCleanScreenText(d.text) : d.text })),
        errors: (state.analysis.errors || []).map(spfCleanScreenText),
        warnings: (state.analysis.warnings || []).map(spfCleanScreenText),
        snapshotUrl,
        timestamp: state.timestamp,
      };
      actionData.textSummary = actionData.textSummary
        ? spfCleanScreenText(actionData.textSummary)
        : undefined;

      setActiveScreenVisionAction(actionData);
      setExpression('happy_sparkle');
      setForcedPose('waving_greeting');

      const speech = `I can see your screen! ${actionData.summary}`;
      setLastSpokenText(speech);

      // Record in current conversation
      const now = Date.now();
      const visionBotMsg: Message = {
        id: 'msg_' + now,
        role: 'model',
        content: `👁️ **Screen Vision:** ${actionData.summary}${
          actionData.textSummary ? `\n\n**Legible Screen Text:**\n${actionData.textSummary.slice(0, 350)}` : ''
        }`,
        timestamp: now,
        expression: 'happy_sparkle',
        screenVisionAction: actionData,
      };

      setConversations((prev) => {
        if (prev.length === 0) return prev;
        const active = prev.find((c) => c.id === activeConvoId) || prev[0];
        return prev.map((c) => (c.id === active.id ? { ...c, messages: [...c.messages, visionBotMsg] } : c));
      });

      if (settings.voiceEnabled) {
        speakKrishaText(
          speech,
          settings.voiceName || 'Aoede',
          settings.voiceSpeed,
          () => setIsSpeaking(true),
          () => setIsSpeaking(false),
          undefined,
          settings.languagePreference || 'auto',
          settings.voicePitch ?? 1.0,
          settings.voiceEngine || 'auto'
        );
      }
    } catch (err: any) {
      console.error('Screen vision error:', err);
      const errMsg = `I could not read your screen: ${err?.message || 'Screen capture permission was not granted or cancelled.'}`;
      setLastSpokenText(errMsg);
      setExpression('thoughtful_gaze');
    } finally {
      setIsLoading(false);
    }
  };

  // Execute a multi-step request through the Agent Core and report honestly in chat.
  const runAgentDelegated = async (text: string) => {
    const now = Date.now();
    const userEmotion = analyzeSentimentAndKeywords(text);
    const agentUserMsg: Message = {
      id: 'msg_' + now,
      role: 'user',
      content: text.trim(),
      timestamp: now,
      emotionData: userEmotion,
    };

    let baseMessages: Message[];
    let targetConvoId: string;
    let updatedConversations = [...conversations];

    const existing = conversations.find((c) => c.id === activeConvoId);
    if (!existing) {
      targetConvoId = 'convo_' + now;
      baseMessages = [agentUserMsg];
      updatedConversations = [
        {
          id: targetConvoId,
          title: text.slice(0, 24),
          createdAt: now,
          updatedAt: now,
          messages: baseMessages,
        },
        ...updatedConversations,
      ];
      setActiveConvoId(targetConvoId);
      setActiveConversationId(targetConvoId);
    } else {
      targetConvoId = existing.id;
      baseMessages = [...existing.messages, agentUserMsg];
      updatedConversations = updatedConversations.map((c) =>
        c.id === targetConvoId
          ? {
              ...c,
              title: c.title === 'New Conversation' || c.title === 'Late Evening Chat' ? text.slice(0, 24) : c.title,
              updatedAt: now,
              messages: baseMessages,
            }
          : c
      );
    }

    setConversations(updatedConversations);
    saveStoredConversations(updatedConversations);
    setIsLoading(true);
    setExpression('listening_attentive');

    try {
      const { summary } = await runAgentTask(agentSystemRef.current!, text);
      const reportText = summary || 'I finished going through the steps, but I could not summarize the result.';
      const reportEmotion = analyzeSentimentAndKeywords(reportText);

      const agentBotMsg: Message = {
        id: 'msg_' + (now + 1),
        role: 'model',
        content: reportText,
        timestamp: Date.now(),
        expression: reportEmotion.expression,
        emotionData: reportEmotion,
      };

      const finalMessages = [...baseMessages, agentBotMsg];
      const finalConversations = updatedConversations.map((c) =>
        c.id === targetConvoId ? { ...c, updatedAt: Date.now(), messages: finalMessages } : c
      );

      setConversations(finalConversations);
      saveStoredConversations(finalConversations);
      setLastSpokenText(reportText);
      setExpression(reportEmotion.expression);
      setEmotionData(reportEmotion);

      if (settings.voiceEnabled) {
        speakKrishaText(
          reportText,
          settings.voiceName || 'Aoede',
          settings.voiceSpeed,
          () => setIsSpeaking(true),
          () => setIsSpeaking(false),
          undefined,
          settings.languagePreference || 'auto',
          settings.voicePitch ?? 1.0,
          settings.voiceEngine || 'auto'
        );
      } else {
        setIsSpeaking(true);
        const talkDuration = Math.min(6500, Math.max(2200, reportText.length * 45));
        setTimeout(() => setIsSpeaking(false), talkDuration);
      }

      // Background memory extraction (same endpoint as the normal chat flow)
      fetch('/api/memory/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userMessage: text,
          botMessage: reportText,
          existingMemories: memories,
        }),
      })
        .then((r) => r.json())
        .then((memData) => {
          if (memData.newMemories && memData.newMemories.length > 0) {
            getMemoryService().rememberMany(memData.newMemories, { source: 'conversation_extract' });
            setMemories(getMemoryService().displayMemories());
            activityFeedRef.current?.push(
              `Learned ${memData.newMemories.length} new ${memData.newMemories.length === 1 ? 'memory' : 'memories'}.`,
              'success'
            );
          }
        })
        .catch((err) => console.warn('Agent memory extraction error:', err));
    } finally {
      setIsLoading(false);
    }
  };

  // Send message to Krisha
  const handleSendMessage = async (text: string, forceMapsGrounding?: boolean) => {
    if (!text.trim() || isLoading) return;

    // Goal Continuity v1: observe every message for goal lifecycle statements
    // (create / confirm / complete / pause / resume / abandon). Pure local
    // detection — no I/O, no AI calls, no UI change; it never acts, only
    // records and briefs.
    agentSystemRef.current?.goals?.observeMessage(text);

    // ---- Agent Core delegation (Phase 1 / 4 / 5 / 6 / 9 + Deep Research capability) ----
    // Multi-step, screen-observation, mouse-control, keyboard-control,
    // filesystem/application, and deep-research requests run through the agent
    // loop. Other messages keep the original inline chat flow below.
    if (agentSystemRef.current && (isMultiStepRequest(text) || isScreenIntent(text) || isMouseIntent(text) || isKeyboardIntent(text) || isSystemIntent(text) || isResearchIntent(text))) {
      await runAgentDelegated(text);
      return;
    }

    // Check for dance command or stop dance command
    const isDanceCommand = /\b(dance|dancing|dances|waltz|ballet|tango|groove)\b/i.test(text);
    const isStopDanceCommand = /\b(stop\s+dancing|stop\s+dance|halt|pause\s+dance|enough\s+dancing)\b/i.test(text);

    // Check for greeting command or greeting words (English & Hindi)
    const isGreetingCommand =
      /\b(greet(\s+me)?|greeting|greetings|hello|hi|hey|good\s+morning|good\s+afternoon|good\s+evening|wave(\s+at\s+me|\s+to\s+me)?|say\s+hi|say\s+hello|welcome|howdy|sup|salute|namaste|namaskar|pranam|kaise\s+ho|kaisi\s+ho|kya\s+haal)\b/i.test(
        text
      ) || /(?:नमस्ते|प्रणाम|कैसी\s+हो|कैसे\s+हो)/.test(text);

    // Check for thank you command or appreciation words (English & Hindi)
    const isThankCommand =
      /\b(thank\s+you|thanks|thank\s+u|thx|arigato|appreciate\s+(you|it)|grateful|good\s+job|great\s+job|shukriya|dhanyawad|dhanyavad)\b/i.test(
        text
      ) || /(?:शुक्रिया|धन्यवाद|आभार)/.test(text);

    // Check for looking in different directions commands
    const isLookDifferentDirections = /\b(look\s+(in\s+|at\s+)?(different|various|all|multiple|other)\s+directions?|look\s+around|look\s+everywhere|look\s+around\s+you|look\s+in\s+all\s+directions|turn\s+around)\b/i.test(text);
    const isLookLeft = /\b(look\s+(to\s+the\s+|to\s+)?left|turn\s+(to\s+the\s+|to\s+)?left|turn\s+left)\b/i.test(text);
    const isLookRight = /\b(look\s+(to\s+the\s+|to\s+)?right|turn\s+(to\s+the\s+|to\s+)?right|turn\s+right)\b/i.test(text);
    const isLookUp = /\b(look\s+(up|upward|upwards|at\s+the\s+sky|at\s+the\s+ceiling)|turn\s+up)\b/i.test(text);
    const isLookDown = /\b(look\s+(down|downward|downwards|at\s+the\s+floor|at\s+the\s+ground)|turn\s+down)\b/i.test(text);
    const isStopLooking = /\b(stop\s+looking|look\s+(at\s+me|forward|center|straight|here|ahead)|stop\s+turning|look\s+back)\b/i.test(text);
    const isGeneralStop = /\b(stop|halt|pause|sit\s+down|reset)\b/i.test(text);

    // Check for web action (open website / search within site)
    let detectedWebAction = detectAndParseWebAction(text);
    if (detectedWebAction) {
      setActiveWebAction(detectedWebAction);
      openExternalUrl(detectedWebAction.url);
      setForcedPose('waving_greeting');
      // If user specifically asked to browse websites or expressed difficulty opening websites
      if (
        /\b(unable|can't|cannot|not\s+able|websites?\s+like\s+youtube|open\s+websites?|open\s+browser|open\s+web)\b/i.test(
          text
        )
      ) {
        setActiveModal('web_browser');
      }
    }

    // Check for native laptop app launch commands (e.g. "open spotify on my laptop", "open vs code", "launch discord")
    const appCmd = detectAndParseAppLaunchCommand(text);
    let detectedAppAction: LaptopAppAction | null = null;
    if (appCmd.isAppCommand) {
      if (appCmd.action === 'windows_start') {
        const query = appCmd.searchQuery || appCmd.rawAppName || '';
        detectedAppAction = {
          type: 'list_apps',
          appName: query ? `Windows Start: ${query}` : 'Windows Start Menu',
        };
        setActiveAppAction(detectedAppAction);
        setInitialAppSearch(query);
        setActiveModal('apps');
        setForcedPose('waving_greeting');
        if (query && appCmd.app) {
          setLastSpokenText(`Opening Windows Start and searching for ${appCmd.app.name}. You can press Enter to open it.`);
        } else if (query) {
          setLastSpokenText(`Opening Windows Start and searching for ${query}.`);
        } else {
          setLastSpokenText('Opening Windows Start. You can search any app on your laptop and press Enter to open it.');
        }
      } else if (appCmd.action === 'list_apps') {
        detectedAppAction = {
          type: 'list_apps',
          appName: 'Windows Apps & Start Menu',
        };
        setActiveAppAction(detectedAppAction);
        setInitialAppSearch('');
        setActiveModal('apps');
        setForcedPose('waving_greeting');
      } else if (appCmd.app) {
        detectedAppAction = {
          type: 'launch_app',
          appName: appCmd.app.name,
          protocol: appCmd.app.protocol,
          fallbackUrl: appCmd.app.fallbackUrl,
          category: appCmd.app.category,
          description: appCmd.app.description,
        };
        setActiveAppAction(detectedAppAction);
        launchLaptopApp(appCmd.app);
        setForcedPose('waving_greeting');
        setLastSpokenText(`Opening ${appCmd.app.name} on your laptop.`);
      } else if (appCmd.rawAppName) {
        detectedAppAction = {
          type: 'launch_app',
          appName: appCmd.rawAppName,
        };
        setActiveAppAction(detectedAppAction);
        setInitialAppSearch(appCmd.rawAppName);
        setActiveModal('apps');
      }
    }

    // Check for local file system & PDF/document commands
    const fileCmd = parseFileCommand(text);
    let detectedFileAction: LocalFileAction | null = null;
    if (fileCmd.isFileCommand) {
      const { files: indexedFiles } = await loadIndexedFiles();
      setAvailableIndexedFiles(indexedFiles);
      const query = fileCmd.targetQuery || '';
      const folderFilter = fileCmd.targetFolder || undefined;
      let matched = searchLocalFiles(query, folderFilter, indexedFiles);

      // Prioritize PDF files if PDF was requested or query is generic
      if (text.toLowerCase().includes('pdf') || query.toLowerCase().includes('pdf')) {
        const pdfOnly = matched.filter(
          (m) => m.extension.toLowerCase() === 'pdf' || m.type === 'application/pdf'
        );
        if (pdfOnly.length > 0) {
          matched = pdfOnly;
        } else {
          matched = [...matched].sort((a, b) => {
            const aIsPdf = a.extension.toLowerCase() === 'pdf' ? 1 : 0;
            const bIsPdf = b.extension.toLowerCase() === 'pdf' ? 1 : 0;
            return bIsPdf - aIsPdf;
          });
        }
      }

      detectedFileAction = {
        type: fileCmd.action === 'scan_folder' ? 'scan_folder' : fileCmd.action === 'open' ? 'open_file' : 'search_file',
        query,
        folderName: fileCmd.targetFolder || undefined,
        matchedFiles: matched.map((m) => ({
          id: m.id,
          name: m.name,
          folderName: m.folderName,
          folderPath: m.folderPath,
          size: m.size,
          extension: m.extension,
          category: m.category,
          blobUrl: m.blobUrl,
          previewText: m.previewText,
        })),
      };

      setActiveFileAction(detectedFileAction);

      // If user specifically asked to scan folders
      if (fileCmd.action === 'scan_folder') {
        if (fileCmd.targetFolder) setInitialFolderFilter(fileCmd.targetFolder);
        if (query) setInitialFileSearch(query);
        setActiveModal('files');
      } else if (matched.length > 0) {
        // Automatically open the best matched document/PDF in viewer and new tab
        const targetToOpen = matched[0];
        setActiveViewerFile(targetToOpen);
        setActiveModal('file_viewer');
        openOrDownloadFile(targetToOpen);
        setForcedPose('playful_gesture');
        setExpression('happy_sparkle');
      } else {
        setInitialFileSearch(query);
        if (fileCmd.targetFolder) setInitialFolderFilter(fileCmd.targetFolder);
        setActiveModal('files');
      }
    }

    if (isDanceCommand) {
      setIsDancing(true);
      setForcedPose('waving_greeting');
    } else if (isStopDanceCommand) {
      setIsDancing(false);
      setForcedPose(null);
    }

    if (isGreetingCommand) {
      setIsGreeting(true);
      setForcedPose('waving_greeting');
    }

    if (isThankCommand) {
      setIsThanked(true);
    }

    if (isLookDifferentDirections) {
      setLookDirection('different_directions');
    } else if (isLookLeft) {
      setLookDirection('left');
    } else if (isLookRight) {
      setLookDirection('right');
    } else if (isLookUp) {
      setLookDirection('up');
    } else if (isLookDown) {
      setLookDirection('down');
    } else if (isStopLooking) {
      setLookDirection(null);
    } else if (isGeneralStop && !isDanceCommand) {
      setIsDancing(false);
      setIsGreeting(false);
      setIsThanked(false);
      setLookDirection(null);
      setForcedPose(null);
    }

    // Check for explicit user location declaration (e.g. "I am in Pune", "I live in Mumbai", "Set location to New York")
    const statedLocationQuery = parseLocationStatement(text);
    let currentActiveLocation = userLocation;
    let detectedMapsAction: MapsLocationAction | null = null;
    let locationAcquisitionError: string | null = null;
    const isLocationQuery = isLocationIntent(text);
    const wantsToOpenMaps = shouldOpenGoogleMaps(text);

    if (statedLocationQuery) {
      try {
        const resolvedLoc = await geocodeAddress(statedLocationQuery);
        if (resolvedLoc) {
          currentActiveLocation = resolvedLoc;
          setUserLocation(resolvedLoc);
          detectedMapsAction = buildMapsActionFromLocation(resolvedLoc);
          setActiveLocationAction(detectedMapsAction);
          setForcedPose('waving_greeting');

          if (wantsToOpenMaps && resolvedLoc.googleMapsUrl) {
            try {
              window.open(resolvedLoc.googleMapsUrl, '_blank', 'noopener,noreferrer');
            } catch (openErr) {
              console.warn('Popup blocked or failed to open tab:', openErr);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to geocode stated location:', err);
      }
    } else if (isLocationQuery) {
      // User asked to check location or open Google Maps:
      // FIRST PRIORITY: Google Maps! Pinpointing user's position through Google Maps with high accuracy.
      // ALTERNATIVES: Only if Google Maps (First Priority) fails, uses network/IP geolocation alternatives.
      try {
        const priorityResult = await acquireLocationWithPriority();
        if (priorityResult.location) {
          currentActiveLocation = priorityResult.location;
          setUserLocation(priorityResult.location);
          detectedMapsAction = buildMapsActionFromLocation(priorityResult.location);
          setActiveLocationAction(detectedMapsAction);
          setForcedPose('waving_greeting');

          if (wantsToOpenMaps && priorityResult.location.googleMapsUrl) {
            try {
              window.open(priorityResult.location.googleMapsUrl, '_blank', 'noopener,noreferrer');
            } catch (openErr) {
              console.warn('Popup blocked or failed to open tab:', openErr);
            }
          }
        } else if (priorityResult.googleMapsError) {
          locationAcquisitionError = priorityResult.googleMapsError;
        }
      } catch (err: any) {
        console.warn('Google Maps location acquisition error:', err);
        locationAcquisitionError = err?.message || 'Could not acquire location via Google Maps.';
      }
    }

    // Check for 3D Earth / Globe interaction commands
    let detectedGlobeAction: GlobeAction | null = null;
    const isWindIntent = /\b(wind|wind\s+currents?|currents?)\b/i.test(text);
    const isGlobeIntent =
      isWindIntent ||
      /\b(globe|3d\s+earth|earth\s+view|satellite\s+view|explore\s+earth|google\s+earth|googleearth|earth\.google|open\s+earth)\b/i.test(text) ||
      /\b(?:take\s+me\s+to|fly\s+to|show|zoom\s+into|zoom\s+in)\s+[a-zA-Z\s]+?(?:\s+(?:on|in)\s+(?:the\s+)?(?:globe|earth|google\s+earth)|$)\b/i.test(text) ||
      /\b(maximum\s+(?:available\s+)?detail|highest\s+detail|max\s+detail|globe\s+view|back\s+to\s+globe)\b/i.test(text) ||
      (detectedWebAction?.siteName === 'Google Earth');

    if (isGlobeIntent) {
      if (isWindIntent && /\b(turn\s+off|stop|hide|remove|disable|close)\b[^.]*\b(wind|currents)\b|\b(wind|currents)\b[^.]*\b(off|away)\b/i.test(text)) {
        // e.g. "turn off the wind", "hide wind currents", "turn the wind off"
        detectedGlobeAction = { type: 'wind_off' };
      } else if (isWindIntent) {
        // e.g. "show the wind", "show wind currents", "show wind around Mumbai", "show wind around India"
        const windPlaceMatch = text.match(
          /\b(?:around|near|at|over|in)\s+([a-zA-Z\s]+?)(?:\s+(?:on|in)\s+(?:the\s+)?(?:3d\s+)?(?:earth|globe)|$)/i
        );
        const windPlace = windPlaceMatch ? windPlaceMatch[1].trim() : undefined;
        if (windPlace && !['here', 'me', 'us', 'it', 'the globe', 'globe', 'earth', 'the earth'].includes(windPlace.toLowerCase())) {
          try {
            const geocoded = await geocodeAddress(windPlace);
            detectedGlobeAction = {
              type: 'wind_on',
              locationName: windPlace,
              lat: geocoded?.lat,
              lng: geocoded?.lng,
            };
          } catch {
            detectedGlobeAction = { type: 'wind_on', locationName: windPlace };
          }
        } else {
          detectedGlobeAction = { type: 'wind_on' };
        }
      } else if (/\b(return|reset|back\s+to\s+(?:earth|globe)|globe\s+view|full\s+earth)\b/i.test(text)) {
        // e.g. "Go back to globe view"
        detectedGlobeAction = { type: 'reset_view' };
      } else if (/\b(maximum\s+(?:available\s+)?detail|highest\s+detail|max\s+detail|photorealistic)\b/i.test(text)) {
        // e.g. "Show this place in maximum available detail"
        const placeMatch = text.match(/\b(?:for|in|at|show)\s+([a-zA-Z\s]+?)(?:\s+(?:in|with)\s+max|$)/i);
        const place = placeMatch ? placeMatch[1].trim() : undefined;
        const targetPlace = place && !['this place', 'this', 'here', 'current'].includes(place.toLowerCase()) ? place : undefined;
        let coords: { lat?: number; lng?: number } | undefined;
        if (targetPlace) {
          try {
            coords = await geocodeAddress(targetPlace) || undefined;
          } catch {
            // fallback
          }
        }
        detectedGlobeAction = {
          type: 'zoom_detail',
          locationName: targetPlace,
          lat: coords?.lat,
          lng: coords?.lng,
          zoom: 115,
          detailLevel: 'photorealistic_3d',
        };
      } else if (/\b(?:zoom\s+into|zoom\s+in\s+to|zoom\s+in)\b/i.test(text)) {
        // e.g. "Zoom into Mumbai"
        const zoomPlaceMatch = text.match(/\b(?:zoom\s+into|zoom\s+in\s+to|zoom\s+in)\s+([a-zA-Z\s]+?)(?:\s+(?:on|in)\s+|$)/i);
        const place = zoomPlaceMatch ? zoomPlaceMatch[1].trim() : undefined;
        if (place && !['here', 'it', 'this', 'globe', 'earth'].includes(place.toLowerCase())) {
          try {
            const geocoded = await geocodeAddress(place);
            detectedGlobeAction = {
              type: 'zoom_detail',
              locationName: place,
              lat: geocoded?.lat,
              lng: geocoded?.lng,
              zoom: 120,
              detailLevel: 'city',
            };
          } catch {
            detectedGlobeAction = { type: 'zoom_detail', locationName: place, zoom: 120, detailLevel: 'city' };
          }
        } else {
          detectedGlobeAction = { type: 'zoom_detail', zoom: 120, detailLevel: 'city' };
        }
      } else if (/\b(satellite)\b/i.test(text)) {
        detectedGlobeAction = { type: 'set_layer', layer: 'satellite' };
      } else if (/\b(dark|night)\b/i.test(text)) {
        detectedGlobeAction = { type: 'set_layer', layer: 'dark' };
      } else if (/\b(terrain|relief|topo)\b/i.test(text)) {
        detectedGlobeAction = { type: 'set_layer', layer: 'terrain' };
      } else if (/\b(standard|map)\b/i.test(text)) {
        detectedGlobeAction = { type: 'set_layer', layer: 'standard' };
      } else {
        const placeMatch = text.match(
          /\b(?:show|take\s+me\s+to|fly\s+to|locate|explore)\s+([a-zA-Z\s]+?)(?:\s+(?:on|in)\s+(?:the\s+)?(?:3d\s+)?(?:earth|globe|google\s+earth)|$)/i
        );
        const place = placeMatch
          ? placeMatch[1].trim()
          : (detectedWebAction?.siteName === 'Google Earth' && detectedWebAction.query ? detectedWebAction.query : undefined);
        if (place && !['earth', 'the earth', 'globe', 'the globe', 'google earth', 'me', 'it'].includes(place.toLowerCase())) {
          try {
            const geocoded = await geocodeAddress(place);
            detectedGlobeAction = {
              type: 'fly_to',
              locationName: place,
              lat: geocoded?.lat,
              lng: geocoded?.lng,
              zoom: 145,
            };
          } catch {
            detectedGlobeAction = { type: 'fly_to', locationName: place, zoom: 145 };
          }
        } else {
          detectedGlobeAction = { type: 'open_globe' };
        }
      }

      if (detectedGlobeAction) {
        setActiveGlobeAction(detectedGlobeAction);
        setActiveModal('globe');
        setForcedPose('waving_greeting');
      }
    }

    // Check for daily habit & calendar commands or progress tracking
    let detectedHabitAction: HabitAction | null = null;
    const isHabitQuery = isHabitIntent(text);
    const isCalQuery = isCalendarIntent(text);
    const isCompletionReport = isHabitCompletionReport(text);

    if (isCompletionReport) {
      const matched = matchHabitInText(text, habits);
      if (matched) {
        const targetDate = getTodayDateString();
        const { habits: nextHabits, updatedHabit, wasCompleted } = toggleHabitCompletion(
          matched.id,
          targetDate,
          habits
        );
        setHabits(nextHabits);
        detectedHabitAction = buildHabitAction(
          nextHabits,
          'complete_habit',
          updatedHabit || undefined,
          `Marked "${matched.title}" as completed! 🔥 ${updatedHabit?.streak || 1} day streak`
        );
        setActiveHabitAction(detectedHabitAction);
        setForcedPose('waving_greeting');
        setExpression('happy_sparkle');
      } else {
        detectedHabitAction = buildHabitAction(habits, 'check_in');
        setActiveHabitAction(detectedHabitAction);
      }
    } else if (isHabitQuery || isCalQuery) {
      detectedHabitAction = buildHabitAction(habits, isCalQuery ? 'view_habits' : 'check_in');
      setActiveHabitAction(detectedHabitAction);
      if (
        /\b(open\s+calendar|show\s+calendar|view\s+calendar|calendar\s+view|open\s+habits|show\s+habits|view\s+habits|daily\s+habits)\b/i.test(
          text
        )
      ) {
        setActiveModal('habits');
      }
    }

    // Arcade & Game Intent Detection
    if (
      /\b(open\s+arcade|krix\s+arcade|arcade|play\s+games?|play\s+chess|chess\s+game|play\s+battleship|play\s+sudoku|play\s+snake|play\s+platformer|reaction\s+test|simon\s+says|tangram)\b/i.test(
        text
      )
    ) {
      if (/\bchess\b/i.test(text)) {
        setArcadeInitialGame('chess');
      } else if (/\bbattleship\b/i.test(text)) {
        setArcadeInitialGame('battleship');
      } else if (/\bsnake\b/i.test(text)) {
        setArcadeInitialGame('snake');
      } else if (/\bsudoku\b/i.test(text)) {
        setArcadeInitialGame('sudoku');
      } else if (/\bplatformer\b/i.test(text)) {
        setArcadeInitialGame('platformer');
      } else if (/\breaction\b/i.test(text)) {
        setArcadeInitialGame('reaction_test');
      } else if (/\bsimon\b/i.test(text)) {
        setArcadeInitialGame('simon_says');
      } else if (/\btangram\b/i.test(text)) {
        setArcadeInitialGame('tangram');
      } else {
        setArcadeInitialGame(null);
      }
      setActiveModal('arcade');
    }

    // Analyze user message sentiment immediately
    const userEmotion = analyzeSentimentAndKeywords(text);

    const userMsg: Message = {
      id: 'msg_' + Date.now(),
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
      expression:
        detectedWebAction || detectedFileAction || detectedAppAction || detectedMapsAction || detectedGlobeAction || detectedHabitAction
          ? 'happy_sparkle'
          : userEmotion.expression,
      emotionData: userEmotion,
      webAction: detectedWebAction || undefined,
      fileAction: detectedFileAction || undefined,
      appAction: detectedAppAction || undefined,
      mapsAction: detectedMapsAction || undefined,
      globeAction: detectedGlobeAction || undefined,
      habitAction: detectedHabitAction || undefined,
    };

    let targetConvo = currentConversation;
    let updatedConversations = [...conversations];

    if (!targetConvo) {
      targetConvo = {
        id: 'convo_' + Date.now(),
        title: text.slice(0, 24),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [userMsg],
      };
      updatedConversations = [targetConvo, ...updatedConversations];
      setActiveConvoId(targetConvo.id);
      setActiveConversationId(targetConvo.id);
    } else {
      const updatedMessages = [...targetConvo.messages, userMsg];
      const title =
        targetConvo.title === 'New Conversation' || targetConvo.title === 'Late Evening Chat'
          ? text.slice(0, 24)
          : targetConvo.title;

      targetConvo = {
        ...targetConvo,
        title,
        updatedAt: Date.now(),
        messages: updatedMessages,
      };

      updatedConversations = updatedConversations.map((c) =>
        c.id === targetConvo!.id ? targetConvo! : c
      );
    }

    setConversations(updatedConversations);
    saveStoredConversations(updatedConversations);
    setIsLoading(true);

    // Screen vision commands: directly invoke real Gemini vision on user screen
    const isScreenReadCommand =
      /\b(read|see|look at|view|inspect|observe)\s+(?:the\s+|my\s+|user's\s+)?screen\b/i.test(text) ||
      /\b(?:can you see|what(?:'s| is) on|read what(?:'s| is) on)\s+(?:the\s+|my\s+)?screen\b/i.test(text) ||
      /\b(screen\s+vision|read\s+screen)\b/i.test(text);

    if (isScreenReadCommand) {
      handleReadScreen(text);
      return;
    }

    // -------------------------------------------------------------------
    // Wind information queries (Phase 2): answer "wind speed ..." style
    // questions with real Open-Meteo data. Never estimates; honestly
    // reports unavailability. Action commands ("show the wind") continue
    // to the globe flow below and are excluded from this gate.
    // -------------------------------------------------------------------
    const isWindInfoQuery =
      /\bwind\b/i.test(text) &&
      /\b(?:what(?:'s| is)|how\s+(?:strong|fast)|wind\s+(?:speed|direction)|current\s+wind|check\s+wind)\b/i.test(text) &&
      !/\b(show|turn\s+on|open|display|start|hide|turn\s+off|stop|remove|enable|disable)\b/i.test(text);

    if (isWindInfoQuery) {
      const windPlaceMatch = text.match(/\b(?:in|at|near|over|around)\s+([a-zA-Z\s]+?)(?:\?|$)/i);
      const windPlace = windPlaceMatch ? windPlaceMatch[1].trim() : undefined;
      let targetLat: number | undefined;
      let targetLng: number | undefined;
      let targetName = windPlace;
      let locationResolved = true;

      if (targetName) {
        try {
          const geocoded = await geocodeAddress(targetName);
          if (geocoded) {
            targetLat = geocoded.lat;
            targetLng = geocoded.lng;
          } else {
            locationResolved = false;
          }
        } catch {
          locationResolved = false;
        }
      } else if (currentActiveLocation) {
        targetLat = currentActiveLocation.lat;
        targetLng = currentActiveLocation.lng;
        targetName = currentActiveLocation.city || 'your location';
      } else {
        locationResolved = false;
      }

      let windReply: string;
      if (!locationResolved) {
        windReply =
          "I couldn't resolve that location for a wind reading. You can also click a spot on the Krisha Earth globe to inspect real wind there.";
      } else {
        try {
          const reading = await OPEN_METEO_WIND_QUERY.fetchPoint(targetLat!, targetLng!);
          windReply = `The current wind at ${targetName} is ${reading.speedKmh} km/h, coming from the ${reading.cardinal} (${reading.directionDeg}°). Source: Open-Meteo.`;
        } catch (err: any) {
          console.warn('Krisha wind info lookup failed:', err?.message || err);
          windReply =
            "I couldn't fetch live wind data right now — the weather feed may be unreachable. The Krisha Earth globe itself keeps working.";
        }
      }

      const windEmotion = analyzeSentimentAndKeywords(windReply);
      const windBotMsg: Message = {
        id: 'msg_' + (Date.now() + 1),
        role: 'model',
        content: windReply,
        timestamp: Date.now(),
        expression: windEmotion.expression,
        emotionData: windEmotion,
      };

      const windFinalMessages = [...targetConvo.messages, windBotMsg];
      const windFinalConvo = { ...targetConvo, updatedAt: Date.now(), messages: windFinalMessages };
      const windFinalConversations = updatedConversations.map((c) =>
        c.id === windFinalConvo.id ? windFinalConvo : c
      );
      setConversations(windFinalConversations);
      saveStoredConversations(windFinalConversations);
      setExpression(windEmotion.expression);
      setEmotionData(windEmotion);
      setLastSpokenText(windReply);
      setIsLoading(false);

      if (settings.voiceEnabled) {
        speakKrishaText(
          windReply,
          settings.voiceName || 'Aoede',
          settings.voiceSpeed,
          () => setIsSpeaking(true),
          () => setIsSpeaking(false),
          undefined,
          settings.languagePreference || 'auto',
          settings.voicePitch ?? 1.25
        );
      } else {
        setIsSpeaking(true);
        const talkDuration = Math.min(6500, Math.max(2200, windReply.length * 45));
        setTimeout(() => setIsSpeaking(false), talkDuration);
      }
      return;
    }

    // Krisha transitions into attentive listening mode with user context
    setExpression(userEmotion.sentiment === 'teasing' ? 'playful_smirk' : 'listening_attentive');

    // Call server Gemini chat API
    // Action Transparency: the request is a real running action — it stays
    // visible until the reply actually arrives (chat often exceeds 5 s).
    activityFeedRef.current?.push('Preparing the response…', 'running', { sticky: true, key: 'chat:reply' });
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: targetConvo.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          // Relevance-based retrieval (Phase 2): only memories useful for this
          // message go into the prompt, never the whole database.
          memories: getMemoryService()
            .recall(text, { limit: 8 })
            .map((m) => m.content),
          userName: settings.userName,
          companionNotes: settings.companionNotes,
          userLocation: currentActiveLocation || undefined,
          locationError: locationAcquisitionError || undefined,
          isExplicitLocationQuery: isLocationQuery,
          wantsToOpenMaps,
          useMapsGrounding: Boolean(forceMapsGrounding),
          languagePreference: settings.languagePreference || 'auto',
          habitsContext: formatHabitContextForPrompt(habits, calendarEvents),
        }),
      });

      const data = await res.json();
      const botReply = data.reply || "I'm right here with you.";
      activityFeedRef.current?.resolve('chat:reply');
      activityFeedRef.current?.push('Response ready.', 'success');

      // Compute best matched nuanced expression & micro-gesture
      const clientAnalyzedEmotion = analyzeSentimentAndKeywords(botReply);
      const serverExpression = data.expression ? normalizeExpression(data.expression) : clientAnalyzedEmotion.expression;

      const mergedEmotionData: EmotionAnalysis = {
        expression: serverExpression,
        intensity: data.emotionData?.intensity ?? clientAnalyzedEmotion.intensity,
        gesture: data.emotionData?.gesture ?? clientAnalyzedEmotion.gesture,
        blushLevel: data.emotionData?.blushLevel ?? clientAnalyzedEmotion.blushLevel,
        sentiment: clientAnalyzedEmotion.sentiment,
      };

      const resolvedWebAction = detectedWebAction || data.webAction || null;
      if (resolvedWebAction && !detectedWebAction) {
        detectedWebAction = resolvedWebAction;
        setActiveWebAction(resolvedWebAction);
        await openExternalUrlIfNotStopped(resolvedWebAction.url);
      }

      // Handle Maps Grounding places returned by gemini-3.5-flash with googleMaps tool
      let resolvedMapsAction = detectedMapsAction;
      const mapsGroundingData = data.mapsGrounding || undefined;
      if (mapsGroundingData && mapsGroundingData.length > 0) {
        resolvedMapsAction = {
          type: 'grounding',
          googleMapsUrl: mapsGroundingData[0]?.uri || (currentActiveLocation ? currentActiveLocation.googleMapsUrl : 'https://www.google.com/maps'),
          city: currentActiveLocation?.city || 'Google Maps Grounded Places',
          formattedAddress: mapsGroundingData.map((p: any) => p.title).slice(0, 3).join(', '),
          mapsGrounding: mapsGroundingData,
          groundingUsed: true,
          lat: currentActiveLocation?.lat,
          lng: currentActiveLocation?.lng,
        };
        detectedMapsAction = resolvedMapsAction;
        setActiveLocationAction(resolvedMapsAction);
      }

      const botMsg: Message = {
        id: 'msg_' + (Date.now() + 1),
        role: 'model',
        content: botReply,
        timestamp: Date.now(),
        expression: serverExpression,
        emotionData: mergedEmotionData,
        webAction: resolvedWebAction || undefined,
        fileAction: detectedFileAction || undefined,
        appAction: detectedAppAction || undefined,
        mapsAction: resolvedMapsAction || undefined,
        habitAction: detectedHabitAction || undefined,
        mapsGrounding: mapsGroundingData,
      };

      const finalMessages = [...targetConvo.messages, botMsg];
      const finalConvo = {
        ...targetConvo,
        updatedAt: Date.now(),
        messages: finalMessages,
      };

      const finalConversations = updatedConversations.map((c) =>
        c.id === finalConvo.id ? finalConvo : c
      );

      setConversations(finalConversations);
      saveStoredConversations(finalConversations);
      setExpression(serverExpression);
      setEmotionData(mergedEmotionData);
      setLastSpokenText(botReply);

      // Trigger Voice TTS if enabled & animate talking (with target language preference and sweet feminine pitch)
      if (settings.voiceEnabled) {
        speakKrishaText(
          botReply,
          settings.voiceName || 'Aoede',
          settings.voiceSpeed,
          () => setIsSpeaking(true),
          () => setIsSpeaking(false),
          undefined,
          settings.languagePreference || 'auto',
          settings.voicePitch ?? 1.0,
          settings.voiceEngine || 'auto'
        );
      } else {
        setIsSpeaking(true);
        const talkDuration = Math.min(6500, Math.max(2200, botReply.length * 45));
        setTimeout(() => {
          setIsSpeaking(false);
        }, talkDuration);
      }

      // Asynchronously extract memory in the background
      fetch('/api/memory/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userMessage: text,
          botMessage: botReply,
          existingMemories: memories,
        }),
      })
        .then((r) => r.json())
        .then((memData) => {
          if (memData.newMemories && memData.newMemories.length > 0) {
            getMemoryService().rememberMany(memData.newMemories, { source: 'conversation_extract' });
            setMemories(getMemoryService().displayMemories());
            activityFeedRef.current?.push(
              `Learned ${memData.newMemories.length} new ${memData.newMemories.length === 1 ? 'memory' : 'memories'}.`,
              'success'
            );
          }
        })
        .catch((err) => console.warn('Background memory extraction error:', err));
    } catch (err) {
      console.warn('Chat request fallback triggered:', err);
      activityFeedRef.current?.resolve('chat:reply');
      activityFeedRef.current?.push('The response could not be prepared.', 'error', { sticky: true, key: 'chat:error' });
      const fallbackReply = `I'm right here with you, ${settings.userName || 'you'}. Tell me more.`;
      const fallbackEmotion = analyzeSentimentAndKeywords(fallbackReply);

      const botMsg: Message = {
        id: 'msg_' + (Date.now() + 1),
        role: 'model',
        content: fallbackReply,
        timestamp: Date.now(),
        expression: fallbackEmotion.expression,
        emotionData: fallbackEmotion,
      };

      const finalMessages = [...targetConvo.messages, botMsg];
      const finalConvo = {
        ...targetConvo,
        updatedAt: Date.now(),
        messages: finalMessages,
      };

      const finalConversations = updatedConversations.map((c) =>
        c.id === finalConvo.id ? finalConvo : c
      );

      setConversations(finalConversations);
      saveStoredConversations(finalConversations);
      setExpression(fallbackEmotion.expression);
      setEmotionData(fallbackEmotion);
      setLastSpokenText(fallbackReply);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReplayVoice = (text: string) => {
    // Replay voice and re-trigger emotion analysis
    const emotion = analyzeSentimentAndKeywords(text);
    setExpression(emotion.expression);
    setEmotionData(emotion);

    speakKrishaText(
      text,
      settings.voiceName || 'Aoede',
      settings.voiceSpeed,
      () => setIsSpeaking(true),
      () => setIsSpeaking(false),
      undefined,
      settings.languagePreference || 'auto',
      settings.voicePitch ?? 1.0,
      settings.voiceEngine || 'auto'
    );
  };

  // Wake-word detection state
  const [wakeWordStatus, setWakeWordStatus] = useState<WakeWordStatus>('idle');
  const [wakeWordDetectedAlert, setWakeWordDetectedAlert] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState('');

  // Synchronize Krisha speaking state to mute self-triggering
  useEffect(() => {
    wakeWordManager.setKrishaSpeaking(isSpeaking);
  }, [isSpeaking]);

  // Keep a ref to handleSendMessage to avoid stale closures
  const sendMessageRef = useRef(handleSendMessage);
  useEffect(() => {
    sendMessageRef.current = handleSendMessage;
  });

  // Handle Wake-Word "Krisha" / "Hey Krisha" detection
  const handleWakeWordDetected = (res: WakeWordResult) => {
    // 1. Play dual-tone crystal chime
    if (settings.voiceEnabled) {
      playWakeChime();
    }

    // 2. Alert animation
    setWakeWordDetectedAlert(true);
    setTimeout(() => setWakeWordDetectedAlert(false), 3500);

    // 3. Automatically turn on Krisha! (Play greeting animation and attentive sparkling expression)
    setIsGreeting(true);
    setForcedPose('waving_greeting');
    setExpression('happy_sparkle');
    setEmotionData({
      expression: 'happy_sparkle',
      intensity: 0.9,
      gesture: 'perk_up',
      blushLevel: 0.35,
      sentiment: 'positive',
    });

    // 4. If a command was spoken after her name:
    if (res.command && res.command.trim().length > 1) {
      sendMessageRef.current(res.command.trim());
    } else {
      // She was just called by name: "Krisha!" / "Hey Krisha"
      const isHindiMode = settings.languagePreference === 'hi';
      const wakeGreetings = isHindiMode
        ? [
            `हाँ जी! मैं यहीं हूँ। बताइए क्या मदद करूँ?`,
            `जी, मैं सुन रही हूँ! क्या चल रहा है?`,
            `नमस्ते! मैं बिल्कुल तैयार और जाग रही हूँ।`,
          ]
        : [
            `I'm right here, ${settings.userName || 'darling'}! What can I do for you?`,
            `Yes! I'm listening~ What's on your mind?`,
            `Hey ${settings.userName || 'there'}! I'm wide awake and listening.`,
          ];
      const randomGreeting = wakeGreetings[Math.floor(Math.random() * wakeGreetings.length)];
      setLastSpokenText(randomGreeting);

      if (settings.voiceEnabled) {
        speakKrishaText(
          randomGreeting,
          settings.voiceName || 'Aoede',
          settings.voiceSpeed,
          () => setIsSpeaking(true),
          () => setIsSpeaking(false),
          undefined,
          settings.languagePreference || 'auto',
          settings.voicePitch ?? 1.0,
          settings.voiceEngine || 'auto'
        );
      } else {
        setIsSpeaking(true);
        setTimeout(() => setIsSpeaking(false), 3000);
      }
    }
  };

  // Start continuous wake-word ambient listening when enabled
  useEffect(() => {
    if (settings.wakeWordEnabled !== false) {
      wakeWordManager.startListening(
        handleWakeWordDetected,
        (status) => setWakeWordStatus(status),
        (transcript) => setLiveTranscript(transcript),
        settings.languagePreference || 'auto'
      );
    } else {
      wakeWordManager.stopListening();
      setWakeWordStatus('idle');
    }

    return () => {
      wakeWordManager.stopListening();
    };
  }, [settings.wakeWordEnabled, settings.voiceEnabled, settings.voiceName, settings.voiceSpeed, settings.voicePitch, settings.userName, settings.languagePreference]);

  return (
    <div
      className={`flex flex-col sm:flex-row h-screen w-screen transition-colors duration-700 font-sans overflow-hidden select-none ${
        isWhiteBackground ? 'bg-white text-slate-800' : 'bg-[#02040a] text-slate-300'
      }`}
    >
      {/* 1. Immersive Left Sidebar Navigation (Desktop/Tablet) & Mobile Top Header */}
      <SidebarNav
        activeModal={activeModal}
        onSelectModal={(modal) => setActiveModal(modal)}
        location={userLocation}
      />

      {/* 2. Main Immersive Presence Screen */}
      <main
        ref={mainContainerRef}
        onPointerMove={handlePointerMove}
        className={`flex-1 flex flex-col relative overflow-hidden h-full transition-colors duration-700 ${
          isWhiteBackground ? 'bg-white' : ''
        }`}
      >
        {/* Top-Left Presence Header */}
        <div className="absolute top-6 left-6 sm:top-10 sm:left-12 z-20 pointer-events-none">
          <h1
            className={`text-base sm:text-lg font-light tracking-[0.4em] uppercase transition-colors duration-700 ${
              isWhiteBackground ? 'text-slate-800 font-medium' : 'text-blue-100/90'
            }`}
          >
            Krisha
          </h1>
          <p
            className={`text-[10px] uppercase tracking-widest mt-1 flex items-center gap-2 transition-colors duration-700 ${
              isWhiteBackground ? 'text-blue-600 font-medium' : 'text-blue-400/70'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isWhiteBackground ? 'bg-blue-600 shadow-[0_0_8px_#2563eb]' : 'bg-blue-500 shadow-[0_0_8px_#3b82f6]'
              } animate-pulse`}
            />
            <span>
              {isDancing
                ? 'Dancing Active'
                : lookDirection === 'different_directions'
                ? 'Looking in Different Directions'
                : lookDirection
                ? `Looking ${lookDirection.charAt(0).toUpperCase() + lookDirection.slice(1)}`
                : 'Presence Active'}
            </span>
          </p>

          {/* E5: emergency-stop status + activation (deactivation is operator-CLI only) */}
          <div className="mt-2 pointer-events-auto">
            {emergencyStopState.active ? (
              <button
                onClick={() => void refreshEmergencyStop()}
                className="text-[10px] uppercase tracking-widest px-2 py-1 rounded bg-red-500/20 text-red-300 border border-red-400/40 animate-pulse"
                title="Emergency stop is ACTIVE — tasks are cancelled and side effects are blocked. Recovery requires the operator recovery CLI."
              >
                ⏹ Emergency Stop Active{emergencyStopState.generation ? ` (gen ${emergencyStopState.generation})` : ''}
              </button>
            ) : (
              <button
                onClick={() => {
                  if (window.confirm('Activate the emergency stop? This cancels running tasks and blocks side effects. Recovery requires the operator recovery CLI.')) {
                    void activateEmergencyStop();
                  }
                }}
                className="text-[10px] uppercase tracking-widest px-2 py-1 rounded bg-slate-500/10 text-blue-200/60 border border-blue-300/20 hover:bg-red-500/20 hover:text-red-200 hover:border-red-400/40 transition-colors"
                title="Activate the emergency stop — cancels tasks and blocks side effects. Recovery requires the operator recovery CLI."
              >
                ⏹ Emergency Stop
              </button>
            )}
          </div>
        </div>

        {/* White Mode Exit / Stop Pill when dancing or looking */}
        {isWhiteBackground && (
          <div className="absolute top-6 right-6 sm:top-10 sm:right-12 z-20 pointer-events-auto">
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={() => {
                setIsDancing(false);
                setLookDirection(null);
                setForcedPose(null);
              }}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 border border-slate-300/80 rounded-full text-[11px] text-slate-700 hover:text-slate-900 transition-all shadow-[0_4px_12px_rgba(0,0,0,0.06)] cursor-pointer"
              title="Restore normal dark background"
            >
              <span className="w-2 h-2 rounded-full bg-blue-600 animate-ping" />
              <span>{isDancing ? 'Stop Dancing' : 'Reset View'}</span>
            </motion.button>
          </div>
        )}

        {/* Recenter Control when dragged (when not in white mode to avoid overlap) */}
        {isMoved && !isWhiteBackground && (
          <div className="absolute top-6 right-6 sm:top-10 sm:right-12 z-20 pointer-events-auto">
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={handleResetPosition}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0b1020]/90 border border-blue-500/30 hover:border-blue-400/60 rounded-full text-[11px] text-blue-300 hover:text-white transition-all shadow-[0_0_15px_rgba(59,130,246,0.2)] cursor-pointer"
              title="Recenter Krisha"
            >
              <RotateCcw className="w-3 h-3 text-blue-400" />
              <span>Recenter</span>
            </motion.button>
          </div>
        )}

        {/* Central Avatar Area — Krix 3D VRM + 2D Fallback */}
        <div
          className={`flex-1 flex items-center justify-center relative px-4 pt-10 sm:pt-4 overflow-hidden transition-colors duration-700 ${
            isWhiteBackground ? 'bg-white' : 'bg-[#02030f]'
          }`}
          style={{ backgroundColor: isWhiteBackground ? undefined : '#02030f' }}
        >
          <motion.div
            key={avatarKey}
            drag
            dragConstraints={mainContainerRef}
            dragElastic={0.15}
            dragMomentum={true}
            onDragStart={() => setIsMoved(true)}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            whileDrag={{
              scale: 1.03,
              cursor: 'grabbing',
              filter: 'drop-shadow(0 25px 35px rgba(0,0,0,0.75))',
            }}
            whileHover={{ scale: 1.01 }}
            transition={{
              scale: { type: 'spring', stiffness: 260, damping: 20 },
              opacity: { duration: 0.6, ease: 'easeOut' },
            }}
            className="relative z-10 w-full max-w-[520px] h-[620px] flex flex-col items-center justify-end cursor-grab active:cursor-grabbing"
          >
            {/* Spoken / Dialogue Speech Bubble above Krix */}
            {lastSpokenText && (
              <motion.div
                key={lastSpokenText}
                initial={{ opacity: 0, y: 8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.35 }}
                className={`absolute top-2 sm:top-4 z-30 px-4 py-2.5 max-w-[280px] sm:max-w-xs rounded-2xl backdrop-blur-md flex flex-col items-center gap-1.5 pointer-events-auto transition-all duration-500 ${
                  isWhiteBackground
                    ? 'bg-white/95 border border-slate-200/90 shadow-[0_12px_32px_rgba(0,0,0,0.12)]'
                    : 'bg-[#0b1022]/90 border border-blue-500/30 shadow-[0_8px_32px_rgba(0,0,0,0.8)]'
                }`}
              >
                <p
                  className={`text-xs font-normal italic leading-relaxed text-center transition-colors ${
                    isWhiteBackground ? 'text-slate-800' : 'text-blue-100'
                  }`}
                >
                  "{lastSpokenText}"
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReplayVoice(lastSpokenText);
                    }}
                    className={`flex items-center gap-1 text-[10px] transition-colors cursor-pointer ${
                      isWhiteBackground
                        ? 'text-blue-600 hover:text-blue-800'
                        : 'text-blue-400/80 hover:text-blue-200'
                    }`}
                    title="Listen to voice"
                  >
                    <Volume2 className="w-3 h-3" />
                    <span>Replay Voice</span>
                  </button>

                  {activeWebAction && (
                    <a
                      href={activeWebAction.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className={`flex items-center gap-1 text-[10px] font-medium transition-colors ${
                        isWhiteBackground
                          ? 'text-indigo-600 hover:text-indigo-800'
                          : 'text-cyan-400 hover:text-cyan-200'
                      }`}
                      title={`Open ${activeWebAction.siteName}`}
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>{activeWebAction.siteName}</span>
                    </a>
                  )}
                </div>
                {/* Speech Bubble Pointer Arrow */}
                <div
                  className={`absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 transition-colors ${
                    isWhiteBackground
                      ? 'bg-white border-r border-b border-slate-200/90'
                      : 'bg-[#0b1022] border-r border-b border-blue-500/30'
                  }`}
                />
              </motion.div>
            )}

            {/* ★ Krix 3D VRM Avatar — primary display */}
            <div className="absolute inset-0 z-10">
              <KrixAvatar
                expression={expression}
                emotionData={emotionData}
                isSpeaking={isSpeaking}
                isListening={isLoading}
                isDancing={isDancing}
                isGreeting={isGreeting}
                isThanked={isThanked}
                lookDirection={lookDirection}
                pointerPos={pointerPos}
              />
            </div>

            {/* Interactive touch hotspots (calibrated for full-body avatar) */}
            <div
              onClick={() => handleAvatarReaction('head')}
              title="Pat Krix's head ✨"
              className="absolute top-[10%] left-1/2 -translate-x-1/2 w-32 h-24 cursor-pointer z-30 rounded-full hover:bg-cyan-400/10 transition-colors"
            />
            <div
              onClick={() => handleAvatarReaction('heart')}
              title="Touch Krix's heart 💖"
              className="absolute top-[28%] left-1/2 -translate-x-1/2 w-28 h-20 cursor-pointer z-30 rounded-full hover:bg-rose-400/10 transition-colors"
            />
            <div
              onClick={() => handleAvatarReaction('wave')}
              title="Greet Krix 👋"
              className="absolute top-[44%] left-1/2 -translate-x-1/2 w-44 h-44 cursor-pointer z-30 rounded-3xl hover:bg-blue-400/10 transition-colors"
            />
          </motion.div>
        </div>

        {/* Bottom Direct Chat Input Bar (Directly on screen with Web Action & File Action Preview) */}
        <div className="pb-5 sm:pb-7 flex flex-col items-center justify-center z-20 w-full px-4">
          <WebActionCard
            action={activeWebAction}
            onDismiss={() => setActiveWebAction(null)}
            onOpenBrowserModal={() => setActiveModal('web_browser')}
            isLightMode={isWhiteBackground}
          />
          <LocalFileActionCard
            action={activeFileAction}
            onDismiss={() => setActiveFileAction(null)}
            onOpenFile={(file) => {
              setActiveViewerFile(file);
              setActiveModal('file_viewer');
            }}
            onOpenFilesModal={() => {
              if (activeFileAction?.query) setInitialFileSearch(activeFileAction.query);
              setActiveModal('files');
            }}
            isLightMode={isWhiteBackground}
          />
          <AppActionCard
            action={activeAppAction}
            onDismiss={() => setActiveAppAction(null)}
            onOpenAppsModal={() => {
              if (activeAppAction?.appName && activeAppAction.appName !== 'Downloaded Laptop Apps') {
                setInitialAppSearch(activeAppAction.appName);
              }
              setActiveModal('apps');
            }}
            isLightMode={isWhiteBackground}
          />
          <MapsLocationCard
            action={activeLocationAction}
            onDismiss={() => setActiveLocationAction(null)}
            onChangeLocation={() => setActiveModal('location')}
            isLightMode={isWhiteBackground}
          />
          {/* E5 M3 — the only operator approval surface for rollback challenges */}
          <RollbackApprovalCard isLightMode={isWhiteBackground} />
          {/* LPV — the only operator approval surface for vault challenges (save/fill) */}
          <LpvApprovalCard isLightMode={isWhiteBackground} />
          <HabitActionCard
            action={activeHabitAction}
            onDismiss={() => setActiveHabitAction(null)}
            onToggleHabit={(habitId) => handleToggleHabit(habitId)}
            onOpenHabitsModal={() => setActiveModal('habits')}
            onAskKrishaCheckIn={() =>
              handleSendMessage("Krisha, let's do our daily habits check-in! How am I doing on my goals today?")
            }
            isLightMode={isWhiteBackground}
          />
          <ScreenVisionCard
            action={activeScreenVisionAction}
            onDismiss={() => setActiveScreenVisionAction(null)}
            onOpenModal={() => setActiveModal('screen_vision')}
            onRescan={() => handleReadScreen()}
            onSpeakText={(text) => {
              setLastSpokenText(text);
              if (settings.voiceEnabled) {
                speakKrishaText(
                  text,
                  settings.voiceName || 'Aoede',
                  settings.voiceSpeed,
                  () => setIsSpeaking(true),
                  () => setIsSpeaking(false),
                  undefined,
                  settings.languagePreference || 'auto',
                  settings.voicePitch ?? 1.0,
                  settings.voiceEngine || 'auto'
                );
              }
            }}
            isLightMode={isWhiteBackground}
          />
          <DirectChatInput
            aboveInput={
              <ActivityStream
                entries={activityEntries}
                history={activityArchive}
                onDismiss={(id) => activityFeedRef.current?.dismiss(id)}
                isLightMode={isWhiteBackground}
              />
            }
            onSendMessage={handleSendMessage}
            onTypingChange={handleTypingReaction}
            onOpenPdfOrFile={() => {
              setActiveModal('files');
              setInitialFolderFilter('ALL');
            }}
            onOpenTranscribeModal={() => setActiveModal('transcribe')}
            onOpenWindowsApps={() => {
              setActiveModal('apps');
              setInitialAppSearch('');
            }}
            onReadScreen={() => handleReadScreen()}
            isLoading={isLoading}
            isSpeaking={isSpeaking}
            isLightMode={isWhiteBackground}
            voiceEnabled={settings.voiceEnabled}
            onToggleVoice={() =>
              handleSaveSettings({ ...settings, voiceEnabled: !settings.voiceEnabled })
            }
            wakeWordEnabled={settings.wakeWordEnabled !== false}
            onToggleWakeWord={() =>
              handleSaveSettings({
                ...settings,
                wakeWordEnabled: !(settings.wakeWordEnabled !== false),
              })
            }
            wakeWordStatus={wakeWordStatus}
            wakeWordDetected={wakeWordDetectedAlert}
            liveTranscript={liveTranscript}
            languagePreference={settings.languagePreference || 'auto'}
            onChangeLanguage={(newLang) =>
              handleSaveSettings({
                ...settings,
                languagePreference: newLang,
              })
            }
          />
        </div>

        {/* System Watermark / Minimal Indicator */}
        <div
          className={`absolute bottom-3 right-6 opacity-25 hover:opacity-50 transition-all text-[9px] tracking-widest uppercase font-mono select-none hidden sm:block pointer-events-none ${
            isWhiteBackground ? 'text-slate-500' : 'text-blue-400/80'
          }`}
        >
          System V.2.14 // Minimal Mode
        </div>
      </main>

      {/* MODALS: 1. Previous Conversations, 2. Memory, 3. Settings, 4. Local Files, 5. Apps, 6. Document/PDF Viewer */}
      <ConversationsModal
        isOpen={activeModal === 'conversations'}
        onClose={() => setActiveModal(null)}
        conversations={conversations}
        activeConversationId={activeConvoId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onDeleteConversation={handleDeleteConversation}
      />

      <MemoryModal
        isOpen={activeModal === 'memory'}
        onClose={() => setActiveModal(null)}
        memories={memories}
        onAddMemory={handleAddMemory}
        onUpdateMemory={handleUpdateMemory}
        onDeleteMemory={handleDeleteMemory}
      />

      {/* LPV — Local Private Vault (self-contained: fetches its own server
          state; secrets are never displayed or revealed in this panel) */}
      <LocalVaultModal isOpen={activeModal === 'vault'} onClose={() => setActiveModal(null)} />

      <LocalFilesModal
        isOpen={activeModal === 'files'}
        onClose={() => {
          setActiveModal(null);
          setInitialFileSearch('');
          setInitialFolderFilter('ALL');
        }}
        initialSearchQuery={initialFileSearch}
        initialFolderFilter={initialFolderFilter}
        onSelectFile={(file) => {
          setActiveViewerFile(file);
          setActiveModal('file_viewer');
          setLastSpokenText(`Opening ${file.name} for you.`);
        }}
      />

      <DocumentViewerModal
        isOpen={activeModal === 'file_viewer'}
        file={activeViewerFile}
        onClose={() => {
          setActiveModal(null);
          setActiveViewerFile(null);
        }}
        onSelectAnotherFile={(file) => {
          setActiveViewerFile(file);
          openOrDownloadFile(file);
        }}
        onUploadNewFile={(file) => {
          setActiveViewerFile(file);
          setAvailableIndexedFiles((prev) => [file, ...prev.filter((p) => p.id !== file.id)]);
        }}
        availableFiles={availableIndexedFiles}
      />

      <AppsModal
        isOpen={activeModal === 'apps'}
        onClose={() => {
          setActiveModal(null);
          setInitialAppSearch('');
        }}
        initialSearchQuery={initialAppSearch}
        onLaunchApp={(app) => {
          setLastSpokenText(`Opening ${app.name} on your laptop.`);
          setForcedPose('waving_greeting');
        }}
      />

      <SettingsModal
        isOpen={activeModal === 'settings'}
        onClose={() => setActiveModal(null)}
        settings={settings}
        onSaveSettings={handleSaveSettings}
        onResetAllData={handleResetAllData}
        onDataRestored={() => {
          setSettings(getStoredSettings());
          setConversations(getStoredConversations());
          setActiveConvoId(getActiveConversationId());
          setMemories(getMemoryService().displayMemories());
        }}
      />

      <LocationDetailsModal
        isOpen={activeModal === 'location'}
        onClose={() => setActiveModal(null)}
        location={userLocation}
        onRefreshLocation={handleRefreshLocation}
        onUpdateLocation={(newLoc) => {
          setUserLocation(newLoc);
          setActiveLocationAction(buildMapsActionFromLocation(newLoc));
        }}
        isRefreshing={isRefreshingLocation}
        onAskKrishaLocation={() => {
          setActiveModal(null);
          handleSendMessage("Where am I right now?");
        }}
        isLightMode={isWhiteBackground}
      />

      <WebBrowserModal
        isOpen={activeModal === 'web_browser'}
        onClose={() => setActiveModal(null)}
        activeAction={activeWebAction}
        onLaunchWebsite={(action) => {
          setActiveWebAction(action);
          setLastSpokenText(`Opening ${action.siteName} for you.`);
          setForcedPose('waving_greeting');
        }}
        isLightMode={isWhiteBackground}
      />

      <GlobeModal
        isOpen={activeModal === 'globe'}
        onClose={() => {
          setActiveModal(null);
          setActiveGlobeAction(null);
        }}
        userLocation={userLocation}
        initialAction={activeGlobeAction}
        onActionComplete={() => setActiveGlobeAction(null)}
      />

      <AudioTranscriptionModal
        isOpen={activeModal === 'transcribe'}
        onClose={() => setActiveModal(null)}
        onSendToChat={(txt) => handleSendMessage(txt)}
        isLightMode={isWhiteBackground}
      />

      <ErrorBoundary fallbackTitle="Habits & Calendar Error" onReset={() => setActiveModal(null)}>
        <HabitsModal
          isOpen={activeModal === 'habits'}
          onClose={() => setActiveModal(null)}
          habits={habits}
          calendarEvents={calendarEvents}
          onToggleHabit={handleToggleHabit}
          onAddHabit={handleAddHabit}
          onDeleteHabit={handleDeleteHabit}
          onAddCalendarEvent={handleAddCalendarEvent}
          onDeleteCalendarEvent={handleDeleteCalendarEvent}
          onToggleCalendarEvent={handleToggleCalendarEvent}
          onCheckInWithKrisha={() => {
            setActiveModal(null);
            handleSendMessage("Krisha, let's do our daily habits check-in! How am I doing on my goals today?");
          }}
        />
      </ErrorBoundary>

      <ErrorBoundary fallbackTitle="Arcade Error" onReset={() => setActiveModal(null)}>
        <ArcadeModal
          isOpen={activeModal === 'arcade'}
          onClose={() => {
            setActiveModal(null);
            setArcadeInitialGame(null);
          }}
          initialGameId={arcadeInitialGame}
        />
      </ErrorBoundary>

      {/* 13. Screen Vision Studio Modal (Read & Inspect User Screen) */}
      <ScreenVisionModal
        isOpen={activeModal === 'screen_vision'}
        onClose={() => setActiveModal(null)}
        action={activeScreenVisionAction}
        onRescanScreen={(q) => handleReadScreen(q)}
        onSpeakText={(text) => {
          setLastSpokenText(text);
          if (settings.voiceEnabled) {
            speakKrishaText(
              text,
              settings.voiceName || 'Aoede',
              settings.voiceSpeed,
              () => setIsSpeaking(true),
              () => setIsSpeaking(false),
              undefined,
              settings.languagePreference || 'auto',
              settings.voicePitch ?? 1.0,
              settings.voiceEngine || 'auto'
            );
          }
        }}
        isLightMode={isWhiteBackground}
      />
    </div>
  );
}
