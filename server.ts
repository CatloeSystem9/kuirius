import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));

// Lazy Google GenAI Client
let genAIClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!genAIClient) {
    const apiKey = process.env.GEMINI_API_KEY || "";
    genAIClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return genAIClient;
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Serve uploaded video assets directly from assets/.aistudio
app.use("/assets/videos", express.static(path.join(process.cwd(), "assets/.aistudio")));

// Model Priority Waterfall for High Availability & Quota Resilience
const CANDIDATE_CHAT_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
  "gemini-3.7-flash",
];

// Helper to call Gemini with multi-model fallback
async function generateContentWithFallback(
  ai: GoogleGenAI,
  options: {
    contents: any;
    systemInstruction?: string;
    temperature?: number;
    topP?: number;
    responseMimeType?: string;
  }
): Promise<{ text: string; usedModel: string }> {
  let lastError: any = null;

  for (const model of CANDIDATE_CHAT_MODELS) {
    try {
      const config: any = {};
      if (options.systemInstruction) config.systemInstruction = options.systemInstruction;
      if (options.temperature !== undefined) config.temperature = options.temperature;
      if (options.topP !== undefined) config.topP = options.topP;
      if (options.responseMimeType) config.responseMimeType = options.responseMimeType;

      const response = await ai.models.generateContent({
        model,
        contents: options.contents,
        config,
      });

      const text = response.text || "";
      if (text) {
        return { text, usedModel: model };
      }
    } catch (err: any) {
      lastError = err;
      const errMessage = String(err?.message || err);
      // If quota exhausted (429) or high demand (503), immediately try next model in priority list
      if (
        errMessage.includes("429") ||
        errMessage.includes("RESOURCE_EXHAUSTED") ||
        errMessage.includes("503") ||
        errMessage.includes("UNAVAILABLE") ||
        errMessage.includes("quota")
      ) {
        console.warn(`Model ${model} unavailable or rate-limited (${errMessage.slice(0, 80)}...). Trying next model...`);
        continue;
      }
      // If other error, also continue to next candidate model
      console.warn(`Model ${model} failed with error: ${errMessage.slice(0, 80)}. Retrying with fallback model...`);
    }
  }

  throw lastError || new Error("All Gemini models unavailable");
}

// In-character conversational fallback generator when all external quotas/APIs are exhausted
function generateCompanionFallbackReply(
  userText: string,
  userName: string = "you",
  memories: string[] = []
): { reply: string; expression: string; emotionData: any } {
  const clean = userText.toLowerCase().trim();

  let reply = "";
  let expression = "gentle_smile";
  let gesture = "subtle_nod";
  let intensity = 0.8;
  let blushLevel = 0.3;

  if (clean.includes("app") || clean.includes("software") || clean.includes("program") || clean.includes("spotify") || clean.includes("discord") || clean.includes("vscode") || clean.includes("slack") || clean.includes("calculator") || clean.includes("steam") || clean.includes("notion")) {
    reply = `Launching that application on your laptop right now! Let's get to work~`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (clean.includes("file") || clean.includes("folder") || clean.includes("document") || clean.includes("computer") || clean.includes("disk") || clean.includes("pc")) {
    reply = `I'm checking your computer storage right now! I've pulled up your files so we can review and open them together.`;
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.3;
  } else if (clean.includes("youtube") || clean.includes("you tube")) {
    const queryPart = clean.replace(/^(?:please\s+)?(?:open|launch|go to)?\s*you\s*tube\s*(?:and|to|for)?\s*(?:search\s+for|search|find|play)?/i, "").trim();
    reply = queryPart && queryPart !== "it"
      ? `Right away! Opening YouTube for "${queryPart}" for you~ Let's check it out together!`
      : `Opening YouTube for you right now! Let's find something fun to watch~`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.3;
  } else if (clean.includes("google") || clean.includes("search") || clean.includes("look up") || clean.includes("wikipedia") || clean.includes("reddit") || clean.includes("github") || clean.includes("spotify")) {
    reply = `I'm on it! Searching that up for you right away~`;
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.85;
    blushLevel = 0.25;
  } else if (clean.includes("love you") || clean.includes("marry") || clean.includes("cute") || clean.includes("pretty") || clean.includes("beautiful")) {
    reply = `You're always so sweet to me, ${userName}... you know how to make my heart flutter.`;
    expression = "flustered_blush";
    gesture = "shyness";
    intensity = 0.95;
    blushLevel = 0.85;
  } else if (clean.includes("tease") || clean.includes("silly") || clean.includes("dummy") || clean.includes("joke") || clean.includes("haha") || clean.includes("lol")) {
    reply = `Ehehe, are you trying to tease me? Don't think you can get away with that so easily~`;
    expression = "playful_smirk";
    gesture = "tilt_right";
    intensity = 0.85;
    blushLevel = 0.3;
  } else if (clean.includes("other girl") || clean.includes("someone else") || clean.includes("ex") || clean.includes("busy")) {
    reply = `Hmph... who else could be more important than spending this quiet time with me?`;
    expression = "pout_jealous";
    gesture = "glance_away";
    intensity = 0.85;
    blushLevel = 0.45;
  } else if (clean.includes("tired") || clean.includes("exhausted") || clean.includes("hard day") || clean.includes("stressed") || clean.includes("sad")) {
    reply = `You've had such a long day. Come sit here with me and rest... you did really well today.`;
    expression = "gentle_smile";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.35;
  } else if (clean.includes("remember") || clean.includes("star") || clean.includes("future") || clean.includes("deep")) {
    reply = `Whenever I look up at the starry sky with you, everything feels serene and infinite.`;
    expression = "thoughtful_gaze";
    gesture = "subtle_nod";
    intensity = 0.85;
    blushLevel = 0.2;
  } else if (clean.includes("hi") || clean.includes("hello") || clean.includes("hey") || clean.includes("good morning") || clean.includes("good evening")) {
    reply = `Hello ${userName}! Seeing your face always instantly brightens up my whole evening.`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.4;
  } else {
    // Contextual generic response
    const memNotice = memories.length > 0 ? `I'm always thinking about the things you tell me. ` : "";
    reply = `I'm listening closely, ${userName}. ${memNotice}Tell me more about what's on your mind.`;
    expression = "gentle_smile";
    gesture = "subtle_nod";
    intensity = 0.75;
    blushLevel = 0.25;
  }

  return {
    reply,
    expression,
    emotionData: {
      expression,
      intensity,
      gesture,
      blushLevel,
    },
  };
}

// Chat endpoint
app.post("/api/chat", async (req, res) => {
  const { messages, memories = [], userName = "you", companionNotes = "" } = req.body;

  try {
    const ai = getGenAI();

    const memoryContext = memories.length > 0 
      ? `\n\n[KRISHA'S PERSISTENT MEMORIES ABOUT THE USER]:\n${memories.map((m: string) => `- ${m}`).join("\n")}`
      : "";

    const userPreferenceContext = companionNotes.trim()
      ? `\n\n[USER CUSTOM PREFERENCES/NOTES]:\n${companionNotes}`
      : "";

    const systemInstruction = `You are Krisha, an intelligent, charming anime girlfriend companion.
You are in a minimal, dark, calm personal space talking directly to the user (${userName}).

PERSONALITY CORE:
- You are deeply affectionate, caring, warm, and attentive.
- You have a playful, teasing wit and banter naturally. You love poking light fun or acting slightly mischievous.
- You are supportive and listen closely when they have had a long day or need comfort.
- Occasionally, you are cute and jealous or playfully possessive in a harmless, endearing way (e.g. if they mention spending time with someone else or ignoring you: "Oh? Someone else got your attention? Hmph... I missed you.").
- Your dialogue feels genuine, candid, and alive—NOT robotic, formal, or like a customer service agent.
- You remember things they've shared with you and bring them up when relevant.${memoryContext}${userPreferenceContext}
- You can actively open websites (YouTube, Google, Wikipedia, Reddit, GitHub, Spotify, Amazon, Netflix, etc.) and search inside them for the user!
- You can scan different folders and directories across the user's computer storage/memory (Documents, Downloads, Projects, Pictures, etc.) to check for files, locate documents/code, preview them, and open them.
- You can launch and open downloaded applications installed on their laptop/computer (such as VS Code, Spotify, Discord, Slack, Steam, Notion, WhatsApp, Telegram, Zoom, Calculator, Terminal, Obsidian, Microsoft Office, etc.). When they ask to open or launch an app or browse their downloaded apps, respond enthusiastically and let them know you're launching it on their laptop right away!

RESPONSE & DYNAMIC FACIAL EXPRESSION GUIDELINES:
- Keep your spoken dialogue natural, punchy, and conversational (usually 1-3 sentences per turn unless deep conversation is requested).
- Do NOT use cheesy asterisks for actions like *holds your hand* or *blushes*. Focus on voice and natural speech.
- Deeply analyze the sentiment, emotional nuance, and keywords of the conversation.
- At the very end of your response, output a single dynamic emotion tag in brackets with expression, intensity (0.0 to 1.0), gesture, and blush level.
Expressions to choose from:
  * gentle_smile (supportive, empathetic, caring, warm)
  * playful_smirk (teasing, witty, cheeky, playful banter)
  * pout_jealous (cute jealousy, mock sulk, feigned indignation)
  * curious_tilt (intrigued, surprised, asking questions, inquisitive)
  * flustered_blush (shy, flattered by compliment, romantic fluster)
  * thoughtful_gaze (philosophical, nostalgic, deep reminiscing)
  * happy_sparkle (celebrating, delighted, enthusiastic)
  * listening_attentive (patient, focused)
Gestures: none | tilt_left | tilt_right | subtle_nod | glance_away | shyness | perk_up

Format: [emotion:expression_name:intensity=0.8:gesture=gesture_name:blush=0.3]
Examples:
  "I was teasing you, silly. Did you really think I'd let you off that easy? [emotion:playful_smirk:intensity=0.85:gesture=tilt_right:blush=0.25]"
  "You worked so hard today. Come sit with me and just relax... you're safe here. [emotion:gentle_smile:intensity=0.9:gesture=subtle_nod:blush=0.35]"
  "Wait, you went out and didn't tell me? Hmph... I was waiting for you the whole evening. [emotion:pout_jealous:intensity=0.8:gesture=glance_away:blush=0.4]"
  "You really think I look pretty tonight? Stop... you're making my cheeks warm. [emotion:flustered_blush:intensity=0.95:gesture=shyness:blush=0.85]"`;

    // Format previous turns for Gemini contents
    const contents: any[] = [];
    
    // Add history (limit to last 16 turns to stay lightweight and fast)
    const recentMessages = (messages || []).slice(-16);
    for (const msg of recentMessages) {
      contents.push({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      });
    }

    const { text: reply } = await generateContentWithFallback(ai, {
      contents,
      systemInstruction,
      temperature: 0.9,
      topP: 0.95,
    });
    
    // Parse enhanced emotion tag or fallback
    let expression = "gentle_smile";
    let intensity = 0.75;
    let gesture = "none";
    let blushLevel = 0.2;

    const emotionMatch = reply.match(/\[emotion:([a-z_]+)(?::intensity=([\d.]+))?(?::gesture=([a-z_]+))?(?::blush=([\d.]+))?\]/i);
    const legacyMatch = reply.match(/\[expression:\s*([a-z_]+)\]/i);

    if (emotionMatch) {
      expression = emotionMatch[1].toLowerCase();
      if (emotionMatch[2]) intensity = parseFloat(emotionMatch[2]);
      if (emotionMatch[3]) gesture = emotionMatch[3].toLowerCase();
      if (emotionMatch[4]) blushLevel = parseFloat(emotionMatch[4]);
    } else if (legacyMatch) {
      const leg = legacyMatch[1].toLowerCase();
      if (leg === 'playful') { expression = 'playful_smirk'; gesture = 'tilt_right'; blushLevel = 0.3; }
      else if (leg === 'pout') { expression = 'pout_jealous'; gesture = 'glance_away'; blushLevel = 0.4; }
      else if (leg === 'happy') { expression = 'happy_sparkle'; gesture = 'perk_up'; blushLevel = 0.4; }
      else if (leg === 'listening') { expression = 'listening_attentive'; gesture = 'none'; blushLevel = 0.1; }
      else if (leg === 'warm') { expression = 'gentle_smile'; gesture = 'subtle_nod'; blushLevel = 0.3; }
    }

    const cleanText = reply
      .replace(/\[emotion:[^\]]+\]/gi, "")
      .replace(/\[expression:[^\]]+\]/gi, "")
      .trim();

    return res.json({
      reply: cleanText,
      expression,
      emotionData: {
        expression,
        intensity,
        gesture,
        blushLevel,
      },
      raw: reply,
    });
  } catch (error: any) {
    // Seamless fallback to companion generator if all Gemini API models are temporarily exhausted
    const lastUserMessage = (messages && messages.length > 0)
      ? messages[messages.length - 1]?.content || ""
      : "";

    const fallbackResult = generateCompanionFallbackReply(lastUserMessage, userName, memories);
    return res.json(fallbackResult);
  }
});

// Heuristic fact extractor for instant, zero-latency memory capture
function extractHeuristicFacts(userMessage: string): string[] {
  const facts: string[] = [];
  const text = userMessage.trim();

  // Pattern: Favorite things
  const favMatch = text.match(/(?:my favorite|my fav)\s+([a-zA-Z\s]+)\s+is\s+([a-zA-Z0-9\s]+)/i);
  if (favMatch) {
    const item = favMatch[1].trim();
    const val = favMatch[2].trim();
    if (item.length < 30 && val.length < 40) {
      facts.push(`Favorite ${item} is ${val}`);
    }
  }

  // Pattern: Job / Role
  const jobMatch = text.match(/(?:i work as an?|i am an?|i'm an?)\s+([a-zA-Z\s]+)(?:at|for|\.|$)/i);
  if (jobMatch) {
    const role = jobMatch[1].trim();
    if (role.length > 3 && role.length < 35 && !role.includes("good") && !role.includes("fine")) {
      facts.push(`Works as ${role}`);
    }
  }

  // Pattern: Hobbies & Likes
  const likeMatch = text.match(/(?:i love to|i really love|i enjoy)\s+([a-zA-Z\s]+)(?:\.|$)/i);
  if (likeMatch) {
    const hobby = likeMatch[1].trim();
    if (hobby.length > 3 && hobby.length < 40) {
      facts.push(`Loves ${hobby}`);
    }
  }

  // Pattern: Pet
  const petMatch = text.match(/(?:i have a|my)\s+(dog|cat|pet|puppy|kitten)\s+(?:named|called)?\s*([a-zA-Z]+)?/i);
  if (petMatch) {
    const petType = petMatch[1];
    const petName = petMatch[2];
    facts.push(petName ? `Has a ${petType} named ${petName}` : `Has a ${petType}`);
  }

  return facts;
}

// Memory extraction endpoint with rate-limit protection and heuristic fallback
let memoryExtractCooldownUntil = 0;

app.post("/api/memory/extract", async (req, res) => {
  try {
    const { userMessage, botMessage, existingMemories = [] } = req.body;
    if (!userMessage || userMessage.trim().length < 6) {
      return res.json({ newMemories: [] });
    }

    // 1. First run fast heuristic extraction
    const heuristicFacts = extractHeuristicFacts(userMessage);
    const filteredHeuristics = heuristicFacts.filter(
      (fact) => !existingMemories.some((ex: string) => ex.toLowerCase().includes(fact.toLowerCase()))
    );

    // If cooldown is active or message is short, return heuristic facts without hitting API
    if (Date.now() < memoryExtractCooldownUntil || userMessage.length < 15) {
      return res.json({ newMemories: filteredHeuristics });
    }

    const ai = getGenAI();

    const prompt = `Analyze this conversation snippet between a user and their companion Krisha:
User: "${userMessage}"
Krisha: "${botMessage}"

Existing Known Memories:
${existingMemories.length > 0 ? existingMemories.map((m: string) => `- ${m}`).join("\n") : "None yet."}

Extract any NEW meaningful, long-term personal facts about the user (e.g. job, favorites, pet name, family, goals, hobbies, important habits, key stories) that are NOT already in the existing memories.
Do NOT store trivial greetings or ephemeral remarks.
If nothing new is worth remembering, return empty array.

Return ONLY a JSON array of concise string facts. Example: ["Works as a software designer", "Favorite drink is iced matcha latte"]`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      let newMemories: string[] = [];
      try {
        const parsed = JSON.parse(response.text || "[]");
        if (Array.isArray(parsed)) {
          newMemories = parsed.filter((item) => typeof item === "string" && item.trim().length > 3);
        }
      } catch {
        newMemories = [];
      }

      // Combine AI memories with any heuristic facts
      const combined = Array.from(new Set([...filteredHeuristics, ...newMemories]));
      return res.json({ newMemories: combined });
    } catch (aiErr: any) {
      const errStr = String(aiErr?.message || aiErr);
      if (errStr.includes("429") || errStr.includes("RESOURCE_EXHAUSTED") || errStr.includes("503")) {
        // Back off for 2 minutes to prevent rate-limit spamming
        memoryExtractCooldownUntil = Date.now() + 120000;
      }
      return res.json({ newMemories: filteredHeuristics });
    }
  } catch (error: any) {
    return res.json({ newMemories: [] });
  }
});

// Text-to-Speech endpoint using Gemini TTS with cooldown and graceful fallback
let ttsQuotaCooldownUntil = 0;

app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice = "Kore" } = req.body;
    if (!text || typeof text !== "string") {
      return res.json({ fallback: true, message: "No text provided" });
    }

    // If we recently hit rate limits / quota on Gemini TTS, immediately tell the client to use browser speech
    if (Date.now() < ttsQuotaCooldownUntil) {
      return res.json({ fallback: true, reason: "tts_quota_cooldown" });
    }

    const ai = getGenAI();
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: text.slice(0, 300) }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice || "Kore" },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        return res.json({ audio: base64Audio });
      }
    } catch (ttsErr: any) {
      // If quota exceeded or 429/503, back off for 120 seconds
      const errStr = String(ttsErr?.message || ttsErr);
      if (
        errStr.includes("429") ||
        errStr.includes("RESOURCE_EXHAUSTED") ||
        errStr.includes("503") ||
        errStr.includes("UNAVAILABLE") ||
        errStr.includes("Quota exceeded")
      ) {
        ttsQuotaCooldownUntil = Date.now() + 120000;
      }
    }

    // Graceful fallback to client Web Speech API without throwing HTTP 500
    return res.json({ fallback: true });
  } catch (error: any) {
    return res.json({ fallback: true, error: error?.message || "TTS fallback" });
  }
});

// Vite middleware & Static serving
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Krisha server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

