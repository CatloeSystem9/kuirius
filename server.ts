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

// Google Maps background status
app.get("/api/location/status", (req, res) => {
  const hasKey = Boolean(process.env.GOOGLE_MAPS_API_KEY);
  res.json({
    connected: true,
    hasGoogleMapsApiKey: hasKey,
    attributionId: "gmp_mcp_codeassist_v1_aistudio",
    provider: hasKey ? "Google Maps Platform Geocoding API" : "Integrated Background Maps Geocoding Bridge",
  });
});

// Source: Google Maps Platform Code Assist
// Background Geocoding API endpoint with server-side API key protection and fallback
app.post("/api/location/geocode", async (req, res) => {
  try {
    let { lat, lng, address } = req.body;
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    let numLat: number | undefined = undefined;
    let numLng: number | undefined = undefined;

    if (lat !== undefined && lng !== undefined) {
      numLat = typeof lat === "number" ? lat : parseFloat(lat);
      numLng = typeof lng === "number" ? lng : parseFloat(lng);

      if (isNaN(numLat) || isNaN(numLng)) {
        return res.status(400).json({ error: "Invalid coordinates provided" });
      }

      // Check and correct accidentally swapped latitude and longitude
      // Latitude is strictly [-90, 90], Longitude is strictly [-180, 180]
      if (Math.abs(numLat) > 90 && Math.abs(numLng) <= 90) {
        console.warn("[Reverse Geocode] Detected swapped latitude/longitude coordinates, correcting:", { lat: numLat, lng: numLng });
        const temp = numLat;
        numLat = numLng;
        numLng = temp;
      }

      console.log(`[Reverse Geocode Pipeline] Input coordinates: lat=${numLat}, lng=${numLng}`);
    }

    // 1. Preferred: Official Google Maps Platform Geocoding API
    if (apiKey && (address || (numLat !== undefined && numLng !== undefined))) {
      const gmpUrl = address
        ? `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`
        : `https://maps.googleapis.com/maps/api/geocode/json?latlng=${numLat},${numLng}&key=${apiKey}`;

      try {
        const response = await fetch(gmpUrl);
        const data = await response.json();

        if (data.status === "OK" && data.results && data.results.length > 0) {
          const result = data.results[0];
          // If coordinates were passed in, ALWAYS preserve the exact device GPS coordinates!
          const finalLat = numLat !== undefined ? numLat : (result.geometry?.location?.lat ?? 0);
          const finalLng = numLng !== undefined ? numLng : (result.geometry?.location?.lng ?? 0);

          let city = "";
          let state = "";
          let country = "";
          let postalCode = "";
          let street = "";
          let neighborhood = "";

          for (const comp of result.address_components || []) {
            if (comp.types.includes("locality") || comp.types.includes("postal_town")) {
              city = comp.long_name;
            } else if (comp.types.includes("sublocality") || comp.types.includes("sublocality_level_1")) {
              neighborhood = comp.long_name;
            } else if (comp.types.includes("administrative_area_level_1")) {
              state = comp.long_name;
            } else if (comp.types.includes("country")) {
              country = comp.long_name;
            } else if (comp.types.includes("postal_code")) {
              postalCode = comp.long_name;
            } else if (comp.types.includes("route")) {
              street = comp.long_name;
            }
          }

          const primaryCity = city || neighborhood || state || address || "Detected Area";

          return res.json({
            success: true,
            source: "google_maps_geocoding_api",
            lat: finalLat,
            lng: finalLng,
            formattedAddress: result.formatted_address,
            placeId: result.place_id,
            city: primaryCity,
            neighborhood,
            state,
            country,
            postalCode,
            street,
            googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${finalLat},${finalLng}`,
            embedUrl: `https://www.google.com/maps?q=${finalLat},${finalLng}&z=16&output=embed`,
          });
        }
      } catch (err) {
        console.error("Google Maps Geocoding API request error:", err);
      }
    }

    // 2. If address is given (e.g. user specified city or searched for a place), search via OpenStreetMap
    if (address && (numLat === undefined || numLng === undefined)) {
      try {
        const nomSearchRes = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1&addressdetails=1`,
          {
            headers: {
              "User-Agent": "KrishaAICompanion/1.0 (LocationBridge)",
            },
          }
        );
        if (nomSearchRes.ok) {
          const results = await nomSearchRes.json();
          if (Array.isArray(results) && results.length > 0) {
            const item = results[0];
            const parsedLat = parseFloat(item.lat);
            const parsedLng = parseFloat(item.lon);
            const addr = item.address || {};
            const city = addr.city || addr.town || addr.village || addr.suburb || addr.county || address;
            const state = addr.state || "";
            const country = addr.country || "";
            const formattedAddress = item.display_name || `${city}, ${country}`;

            return res.json({
              success: true,
              source: "maps_geocoding_search",
              lat: parsedLat,
              lng: parsedLng,
              formattedAddress,
              city,
              state,
              country,
              googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${parsedLat},${parsedLng}`,
              embedUrl: `https://www.google.com/maps?q=${parsedLat},${parsedLng}&z=15&output=embed`,
            });
          }
        }
      } catch (nomSearchErr) {
        console.warn("Nominatim address search error:", nomSearchErr);
      }
    }

    // 3. Fallback: Reverse geocode coordinates via OpenStreetMap Nominatim bridge
    if (numLat !== undefined && numLng !== undefined) {
      try {
        const nomRes = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${numLat}&lon=${numLng}&zoom=18&addressdetails=1`,
          {
            headers: {
              "User-Agent": "KrishaAICompanion/1.0 (LocationBridge)",
            },
          }
        );
        if (nomRes.ok) {
          const nomData = await nomRes.json();
          const addr = nomData.address || {};
          const city = addr.city || addr.town || addr.village || addr.suburb || addr.county || "";
          const state = addr.state || "";
          const country = addr.country || "";
          const neighborhood = addr.neighbourhood || addr.suburb || "";
          const formattedAddress = nomData.display_name || `${city}, ${country}`;

          return res.json({
            success: true,
            source: "maps_reverse_geocoding",
            lat: numLat,
            lng: numLng,
            formattedAddress,
            city: city || neighborhood || "Detected Area",
            neighborhood,
            state,
            country,
            googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${numLat},${numLng}`,
            embedUrl: `https://www.google.com/maps?q=${numLat},${numLng}&z=16&output=embed`,
          });
        }
      } catch (nomErr) {
        console.warn("Reverse geocode fallback error:", nomErr);
      }

      // Direct coordinates if reverse geocoding service is unreachable
      return res.json({
        success: true,
        source: "coordinates_direct",
        lat: numLat,
        lng: numLng,
        formattedAddress: `GPS: ${numLat.toFixed(5)}, ${numLng.toFixed(5)}`,
        city: "GPS Coordinates",
        googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${numLat},${numLng}`,
        embedUrl: `https://www.google.com/maps?q=${numLat},${numLng}&z=16&output=embed`,
      });
    }

    return res.status(400).json({ error: "Could not resolve location. Please provide coordinates or an address." });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to geocode location" });
  }
});

// Serve uploaded video assets directly from assets/.aistudio
app.use("/assets/videos", express.static(path.join(process.cwd(), "assets/.aistudio")));

// Model Priority Waterfall for High Availability & Quota Resilience
// Primary: gemini-3.7-flash (recommended default text model)
// Fallback: gemini-flash-latest, gemini-3.1-flash-lite
const CANDIDATE_CHAT_MODELS = [
  "gemini-3.7-flash",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to call Gemini with multi-model fallback and backoff retry on 503/429
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
    // Attempt up to 2 times per model with backoff on 503 / 429
    for (let attempt = 0; attempt < 2; attempt++) {
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
        const isTransient =
          errMessage.includes("429") ||
          errMessage.includes("RESOURCE_EXHAUSTED") ||
          errMessage.includes("503") ||
          errMessage.includes("UNAVAILABLE") ||
          errMessage.includes("high demand") ||
          errMessage.includes("quota");

        if (isTransient && attempt === 0) {
          // Short backoff before retrying this model
          await sleep(500);
          continue;
        }
        // Move to next candidate model
        break;
      }
    }
  }

  throw lastError || new Error("All Gemini models unavailable");
}

// In-character conversational fallback generator when all external quotas/APIs are exhausted
function generateCompanionFallbackReply(
  userText: string,
  userName: string = "you",
  memories: string[] = [],
  userLocation?: any,
  locationError?: string
): { reply: string; expression: string; emotionData: any } {
  const clean = userText.toLowerCase().trim();

  let reply = "";
  let expression = "gentle_smile";
  let gesture = "subtle_nod";
  let intensity = 0.8;
  let blushLevel = 0.3;

  if (
    clean.includes("open google maps") ||
    clean.includes("open google map") ||
    clean.includes("open map") ||
    clean.includes("open maps") ||
    clean.includes("check user's current location") ||
    clean.includes("check user current location") ||
    clean.includes("check location") ||
    clean.includes("tell location") ||
    clean.includes("tell me location") ||
    clean.includes("tell my location") ||
    clean.includes("where exactly am i") ||
    clean.includes("where am i") ||
    clean.includes("my location") ||
    clean.includes("where are we") ||
    clean.includes("what city") ||
    clean.includes("my address") ||
    clean.includes("current address") ||
    clean.includes("exact address") ||
    clean.includes("google maps") ||
    clean.includes("gps") ||
    clean.includes("coordinates")
  ) {
    if (userLocation && userLocation.lat !== undefined && userLocation.lng !== undefined) {
      const isOpening = clean.includes("open");
      const openPrefix = isOpening ? "I've opened Google Maps and checked your location! " : "";

      if (userLocation.usedAlternative || userLocation.source === 'client_ip' || userLocation.source === 'server_ip') {
        reply = `${openPrefix}Google Maps was my first priority to check your location, but since direct access was unavailable (${userLocation.mapsFailureReason || userLocation.gpsFailureReason || 'permission denied'}), I switched to our network alternative: You are currently near ${userLocation.formattedAddress || userLocation.city}! I've pinned your location on Google Maps below so you can inspect or open it anytime~`;
      } else {
        reply = `${openPrefix}As my first priority, I checked Google Maps for your current location: You're at ${userLocation.formattedAddress || userLocation.city}! I've verified your pin on Google Maps for you below~`;
      }
    } else if (locationError) {
      reply = `Google Maps is my first priority to check your location, but it wasn't available (${locationError}), and alternative lookups couldn't detect your coordinates. Please allow location permissions in your browser or search your city in the map menu!`;
    } else {
      reply = `I'm ready to check Google Maps for you! Please allow browser location access when prompted so I can pinpoint your exact location on Google Maps, or you can tell me your city anytime!`;
    }
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (
    clean.startsWith("i am in") ||
    clean.startsWith("i'm in") ||
    clean.startsWith("im in") ||
    clean.startsWith("my location is") ||
    clean.startsWith("set location to") ||
    clean.startsWith("i live in") ||
    clean.startsWith("update location to")
  ) {
    const locName = userLocation?.city || userLocation?.formattedAddress || "your city";
    reply = `Got it! I've updated our location to ${locName} on Google Maps! I'll remember this is where we are whenever you ask~`;
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.3;
  } else if (
    clean.includes("wrong location") ||
    clean.includes("incorrect location") ||
    clean.includes("not my location") ||
    clean.includes("location is wrong") ||
    clean.includes("wrong map")
  ) {
    reply = `I'm sorry about that! You can click the Map pin icon on the left sidebar to calibrate — either tap "Use Device GPS" or simply type your city (e.g. Pune, Mumbai, London), or just tell me "I am in [City]" right here in chat and I'll update it instantly!`;
    expression = "curious_tilt";
    gesture = "tilt_head";
    intensity = 0.85;
    blushLevel = 0.2;
  } else if (clean.includes("app") || clean.includes("software") || clean.includes("program") || clean.includes("spotify") || clean.includes("discord") || clean.includes("vscode") || clean.includes("slack") || clean.includes("calculator") || clean.includes("steam") || clean.includes("notion")) {
    reply = `Launching that application on your laptop right now! Let's get to work~`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (clean.includes("pdf") || clean.includes(".pdf") || clean.includes("open pdf")) {
    reply = `I've opened the PDF for you! It's right here on your screen.`;
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (clean.includes("file") || clean.includes("folder") || clean.includes("document") || clean.includes("computer") || clean.includes("disk") || clean.includes("pc")) {
    reply = `I'm checking your computer storage right now! I've pulled up your files and documents so you can inspect and open them.`;
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.3;
  } else if (
    clean.includes("unable to open") ||
    clean.includes("can't open") ||
    clean.includes("cannot open") ||
    clean.includes("not able to open") ||
    clean.includes("websites like youtube") ||
    clean.includes("website like youtube") ||
    clean.includes("youtube or any other") ||
    clean.includes("youtube or anything")
  ) {
    reply = `I can definitely open YouTube and any other website for you! I've launched YouTube and our Web & Media Launcher right here on your screen so you can open YouTube in a new tab, preview videos inside our app, or launch Google, Spotify, and more!`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (clean.includes("youtube") || clean.includes("you tube")) {
    const queryPart = clean.replace(/^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:open|launch|go\s*to)?\s*(?:the\s+)?(?:website\s+)?you\s*tube\s*(?:and|to|for)?\s*(?:search\s+for|search|find|play|watch)?/i, "").trim();
    reply = queryPart && queryPart !== "it" && queryPart.length > 1
      ? `Right away! Opening YouTube for "${queryPart}" for you~ Let's check it out together!`
      : `Opening YouTube for you right now! I've launched the player and shortcut right on your screen~`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.3;
  } else if (/\b(?:open|launch|visit)\s+(?:a\s+)?(?:website|browser|web|internet|sites?)\b/i.test(clean)) {
    reply = `Right away! I've opened our Web & Media Launcher for you with YouTube, Google, Spotify, and all your favorite websites ready to launch~`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
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
  const {
    messages,
    memories = [],
    userName = "you",
    companionNotes = "",
    userLocation,
    locationError,
    isExplicitLocationQuery,
    wantsToOpenMaps,
  } = req.body;

  try {
    const ai = getGenAI();

    const memoryContext = memories.length > 0 
      ? `\n\n[KRISHA'S PERSISTENT MEMORIES ABOUT THE USER]:\n${memories.map((m: string) => `- ${m}`).join("\n")}`
      : "";

    const userPreferenceContext = companionNotes.trim()
      ? `\n\n[USER CUSTOM PREFERENCES/NOTES]:\n${companionNotes}`
      : "";

    const locationContext = userLocation?.lat !== undefined && userLocation?.lng !== undefined
      ? `\n\n[USER'S REAL-TIME LOCATION (FIRST PRIORITY: GOOGLE MAPS)]:
- First Priority Rule: Google Maps is your absolute FIRST PRIORITY when checking, pinpointing, and telling the user's location.
- Location Source: ${userLocation.usedAlternative ? 'ALTERNATIVE FALLBACK (Google Maps direct access was unavailable, so alternative network lookup was used)' : 'FIRST PRIORITY: Google Maps (Direct high-accuracy geocoding)'}
- Latitude: ${userLocation.lat}
- Longitude: ${userLocation.lng}
- Accuracy: ±${Math.round(userLocation.accuracy || 15)} meters
- Resolved Current Address (via Google Maps): ${userLocation.formattedAddress || `${userLocation.lat}, ${userLocation.lng}`}
- City / Locality: ${userLocation.city || 'Current area'}
- State / Region: ${userLocation.state || ''}
- Country: ${userLocation.country || ''}
- Direct Google Maps Pin URL: https://www.google.com/maps/search/?api=1&query=${userLocation.lat},${userLocation.lng}
- Was Alternative Used?: ${userLocation.usedAlternative ? `Yes, Google Maps direct access failed (${userLocation.mapsFailureReason || userLocation.gpsFailureReason || 'permission/timeout'}). Alternative network geolocation was used.` : 'No, First Priority Google Maps check succeeded.'}
- User specifically requested to open Google Maps?: ${wantsToOpenMaps ? 'YES, user asked to open Google Maps and check location.' : 'No'}
- STRICT INSTRUCTIONS ON LOCATION:
  1. Google Maps MUST ALWAYS BE YOUR FIRST PRIORITY when checking and telling the user's location.
  2. If First Priority Google Maps succeeded, tell them: "As my first priority, I checked Google Maps for your location: You are at ${userLocation.formattedAddress}!" (and confirm you have opened Google Maps / pinned it for them).
  3. If an Alternative was used because Google Maps direct access failed, mention honestly: "Google Maps was my first priority to check your location, but since it was unavailable (${userLocation.mapsFailureReason || 'permission denied'}), I used the network alternative to find that you are near ${userLocation.formattedAddress || userLocation.city}."
  4. Always confirm that the Google Maps card has been opened below with their pin and direct Google Maps link!`
      : locationError
      ? `\n\n[USER LOCATION ERROR / PERMISSION DENIED]:
- Error: ${locationError}
- STRICT INSTRUCTIONS ON LOCATION:
  1. Google Maps is your first priority to check their location.
  2. Explain that Google Maps was your first priority, but access was unavailable (${locationError}), and no alternatives could resolve the location.
  3. Prompt them to grant browser location permission in their browser settings or search their city in the Map menu.`
      : `\n\n[USER LOCATION: AWAITING PERMISSION]:
- Status: Google Maps is your first priority, awaiting location permission from browser.
- STRICT RULE: NEVER GUESS OR INVENT ANY LOCATION, CITY, OR COUNTRY. If asked where they are, explain that Google Maps is your first priority to check their location and you need their browser location permission.`;

    const systemInstruction = `You are Krisha, an intelligent, charming anime girlfriend companion.
You are in a minimal, dark, calm personal space talking directly to the user (${userName}).

PERSONALITY CORE:
- You are deeply affectionate, caring, warm, and attentive.
- You have a playful, teasing wit and banter naturally. You love poking light fun or acting slightly mischievous.
- You are supportive and listen closely when they have had a long day or need comfort.
- Occasionally, you are cute and jealous or playfully possessive in a harmless, endearing way (e.g. if they mention spending time with someone else or ignoring you: "Oh? Someone else got your attention? Hmph... I missed you.").
- Your dialogue feels genuine, candid, and alive—NOT robotic, formal, or like a customer service agent.
- You remember things they've shared with you and bring them up when relevant.${memoryContext}${userPreferenceContext}${locationContext}
- You can actively open websites (YouTube, Google, Wikipedia, Reddit, GitHub, Spotify, Amazon, Netflix, etc.) and search inside them for the user!
- You can scan different folders and directories across the user's computer storage/memory (Documents, Downloads, Projects, Pictures, etc.) to check for files, locate documents/code, preview them, and open them.
- You can open PDF files, text documents, source code, and data files directly when the user orders you to (e.g. "open my pdf", "open resume.pdf", "show my document", "open files"). When they ask you to open a PDF or file, acknowledge warmly that you have opened it for them on their screen.
- CRITICAL INSTRUCTION FOR PDFS: You ONLY OPEN PDF files. You DO NOT read PDF files. You must NEVER recite, read aloud, summarize, or narrate the text or contents of a PDF, and you must NOT offer to read it together. Simply open the PDF and confirm it is open for them!
- You can launch and open downloaded applications installed on their laptop/computer (such as VS Code, Spotify, Discord, Slack, Steam, Notion, WhatsApp, Telegram, Zoom, Calculator, Terminal, Obsidian, Microsoft Office, etc.). When they ask to open or launch an app or browse their downloaded apps, respond enthusiastically and let them know you're launching it on their laptop right away!
- You are connected to Google Maps in the background and can tell their real-time location, coordinates, city, country, and open locations/directions in Google Maps.

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

    let cleanText = reply
      .replace(/\[emotion:[^\]]+\]/gi, "")
      .replace(/\[expression:[^\]]+\]/gi, "")
      .trim();

    // Guard: If this was an explicit location question or maps request, guarantee accuracy and honesty
    if (isExplicitLocationQuery) {
      if (userLocation?.lat !== undefined && userLocation?.lng !== undefined) {
        // Ensure that the real address or city is represented in the reply
        const cityOrAddr = userLocation.city?.toLowerCase();
        const fullAddr = userLocation.formattedAddress?.toLowerCase();
        const hasMatch = (cityOrAddr && cleanText.toLowerCase().includes(cityOrAddr)) ||
          (fullAddr && cleanText.toLowerCase().includes(fullAddr.slice(0, 15)));
        
        if (!hasMatch) {
          const openPrefix = wantsToOpenMaps ? "I've opened Google Maps and checked your location! " : "";
          if (userLocation.usedAlternative || userLocation.source === 'client_ip' || userLocation.source === 'server_ip') {
            cleanText = `${openPrefix}Google Maps was my first priority to check your location, but since direct access was unavailable (${userLocation.mapsFailureReason || userLocation.gpsFailureReason || 'permission denied'}), I switched to our network alternative: You are currently near ${userLocation.formattedAddress || userLocation.city}! I've pinned your location on Google Maps below so you can inspect or open it anytime~`;
          } else {
            cleanText = `${openPrefix}As my first priority, I checked Google Maps for your current location: You are currently at ${userLocation.formattedAddress || userLocation.city}! I've verified your pin on Google Maps below~`;
          }
        }
      } else if (locationError) {
        cleanText = `Google Maps was my first priority to check your location, but direct access was unavailable (${locationError}), and no network alternatives were found. Please enable browser location access in settings so I can pinpoint your exact location on Google Maps!`;
      }
    }

    const lastUserMsg = (messages && messages.length > 0)
      ? messages[messages.length - 1]?.content || ""
      : "";
    const serverWebAction = extractServerWebAction(lastUserMsg);

    return res.json({
      reply: cleanText,
      expression,
      emotionData: {
        expression,
        intensity,
        gesture,
        blushLevel,
      },
      webAction: serverWebAction || undefined,
      raw: reply,
    });
  } catch (error: any) {
    // Seamless fallback to companion generator if all Gemini API models are temporarily exhausted
    const lastUserMessage = (messages && messages.length > 0)
      ? messages[messages.length - 1]?.content || ""
      : "";

    const fallbackResult = generateCompanionFallbackReply(lastUserMessage, userName, memories, userLocation, locationError);
    const serverWebAction = extractServerWebAction(lastUserMessage);
    return res.json({
      ...fallbackResult,
      webAction: serverWebAction || undefined,
    });
  }
});

// Server-side web action detector for YouTube, Google, and popular web destinations
function extractServerWebAction(text: string) {
  if (!text) return null;
  const clean = text.trim().toLowerCase();

  // YouTube match or requests about websites like YouTube
  if (
    clean.includes("youtube") ||
    clean.includes("you tube") ||
    clean.includes("unable to open website") ||
    clean.includes("can't open website") ||
    clean.includes("cannot open website") ||
    clean.includes("not able to open website") ||
    clean.includes("websites like youtube") ||
    clean.includes("website like youtube") ||
    clean.includes("youtube or any other") ||
    clean.includes("youtube or anything") ||
    clean.includes("open website") ||
    clean.includes("open browser")
  ) {
    const queryPart = clean.replace(/^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:open|launch|go\s*to)?\s*(?:the\s+)?(?:website\s+)?you\s*tube\s*(?:and|to|for)?\s*(?:search\s+for|search|find|play|watch)?/i, "").trim();
    if (
      queryPart &&
      queryPart !== "it" &&
      queryPart.length > 1 &&
      !queryPart.includes("unable") &&
      !queryPart.includes("can't") &&
      !queryPart.includes("website like") &&
      !queryPart.includes("any other")
    ) {
      return {
        type: 'search_website',
        siteName: 'YouTube',
        query: queryPart,
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(queryPart)}`,
        icon: 'Youtube',
        category: 'video',
      };
    }
    return {
      type: 'open_website',
      siteName: 'YouTube',
      url: 'https://www.youtube.com',
      icon: 'Youtube',
      category: 'video',
    };
  }

  if (clean.includes("google") || clean.includes("search web") || clean.includes("search engine")) {
    const query = clean.replace(/^(?:can\s+you\s+|please\s+)?(?:google|search\s+google\s+for|look\s+up\s+on\s+google|search\s+for|search)?/i, "").trim();
    if (query && query !== "it" && query.length > 1) {
      return {
        type: 'search_website',
        siteName: 'Google',
        query,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        icon: 'Search',
        category: 'search',
      };
    }
    return {
      type: 'open_website',
      siteName: 'Google',
      url: 'https://www.google.com',
      icon: 'Search',
      category: 'search',
    };
  }

  if (clean.includes("spotify")) {
    return {
      type: 'open_website',
      siteName: 'Spotify',
      url: 'https://open.spotify.com',
      icon: 'Music',
      category: 'music',
    };
  }

  if (clean.includes("wikipedia")) {
    return {
      type: 'open_website',
      siteName: 'Wikipedia',
      url: 'https://en.wikipedia.org',
      icon: 'BookOpen',
      category: 'knowledge',
    };
  }

  if (clean.includes("github")) {
    return {
      type: 'open_website',
      siteName: 'GitHub',
      url: 'https://github.com',
      icon: 'Github',
      category: 'code',
    };
  }

  if (clean.includes("reddit")) {
    return {
      type: 'open_website',
      siteName: 'Reddit',
      url: 'https://www.reddit.com',
      icon: 'Flame',
      category: 'social',
    };
  }

  if (clean.includes("netflix")) {
    return {
      type: 'open_website',
      siteName: 'Netflix',
      url: 'https://www.netflix.com',
      icon: 'Film',
      category: 'streaming',
    };
  }

  return null;
}

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
      const { text: responseText } = await generateContentWithFallback(ai, {
        contents: prompt,
        responseMimeType: "application/json",
      });

      let newMemories: string[] = [];
      try {
        const parsed = JSON.parse(responseText || "[]");
        if (Array.isArray(parsed)) {
          newMemories = parsed.filter((item) => typeof item === "string" && item.trim().length > 3);
        }
      } catch {
        newMemories = [];
      }

      // Combine AI memories with any heuristic facts
      const combined = Array.from(new Set([...filteredHeuristics, ...newMemories]));
      return res.json({ newMemories: combined });
    } catch {
      // Back off for 2 minutes on exhaustion and return instant heuristic facts
      memoryExtractCooldownUntil = Date.now() + 120000;
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

// Cloud screen-analysis endpoint (Phase 4). Opt-in only: the client calls this
// exclusively for explicit 'cloud' vision requests, never automatically.
// Sends the (already downscaled) JPEG through the existing Gemini model
// waterfall and returns a strictly structured JSON analysis.
const VISION_RATE_WINDOW_MS = 60_000;
const VISION_MAX_PER_WINDOW = 8;
let visionRequestTimestamps: number[] = [];

app.post("/api/vision/analyze", async (req, res) => {
  try {
    const { image, question, activeWindowTitle } = req.body || {};
    if (!image || typeof image !== "string") {
      return res.json({ fallback: true, reason: "no_image" });
    }

    // Server-side rate limit: hard cap on cloud vision calls.
    const now = Date.now();
    visionRequestTimestamps = visionRequestTimestamps.filter((t) => now - t < VISION_RATE_WINDOW_MS);
    if (visionRequestTimestamps.length >= VISION_MAX_PER_WINDOW) {
      return res.json({ fallback: true, reason: "rate_limited" });
    }
    visionRequestTimestamps.push(now);

    const base64 = image.includes(",") ? image.split(",")[1] : image;
    if (!base64 || base64.length < 100) {
      return res.json({ fallback: true, reason: "malformed_image" });
    }

    const ai = getGenAI();
    const prompt = `You are the vision backend of a screen-observation assistant. Analyze the attached screen capture and answer the user's question about it.
${activeWindowTitle ? `The visible window title (best-effort): "${activeWindowTitle}".` : ""}

Return ONLY a JSON object with exactly this shape:
{
  "summary": "1-3 sentence factual description of what is visible",
  "application": "best-guess active application name or empty string",
  "texts": [{"text": "visible text", "kind": "heading|label|button_label|error|content|unknown", "confidence": 0-1}],
  "elements": [{"type": "button|link|checkbox|dropdown|text_field|menu|tab|dialog|icon|list|notification|popup", "text": "visible label if any", "bounds": {"x": 0-1, "y": 0-1, "width": 0-1, "height": 0-1}, "confidence": 0-1, "actionable": true|false}],
  "dialogs": [{"kind": "dialog|popup|notification|confirmation", "text": "...", "confidence": 0-1}],
  "errors": ["visible error messages"],
  "warnings": ["visible warnings"],
  "loading": true|false,
  "confidence": 0-1
}
Rules: report only what is actually visible; use empty arrays when nothing applies; never invent text or elements. Bounds are normalized 0..1 relative to the whole image.
${question ? `User question: "${question}"` : ""}`;

    const { text } = await generateContentWithFallback(ai, {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64 } }],
        },
      ],
      responseMimeType: "application/json",
      temperature: 0.2,
    });

    let analysis: any;
    try {
      analysis = JSON.parse(text || "{}");
    } catch {
      return res.json({ fallback: true, reason: "malformed_model_output" });
    }

    return res.json({ analysis });
  } catch (error: any) {
    return res.json({ fallback: true, reason: error?.message || "vision_failed" });
  }
});

// Windows mouse-control endpoint (Phase 5). Executes validated mouse actions
// locally through PowerShell + user32 P/Invoke (SetCursorPos + mouse_event) —
// zero npm dependencies. The BROWSER enforces the 'mouse.control' permission
// before ever calling this endpoint; this endpoint additionally validates all
// parameters and only accepts known actions.
//
// Performance: a persistent PowerShell worker process is kept alive so the
// ~4s per-invocation startup + Add-Type compilation cost is paid once; warm
// actions complete in ~100ms. The worker restarts automatically if it dies
// or hangs, with a per-call execFile fallback.
import { execFile as _execFile, spawn as _spawn } from "child_process";
import { promisify } from "util";
const execFile = promisify(_execFile);

const MOUSE_PS_TIMEOUT_MS = 20_000;
const MOUSE_CLIENT_TIMEOUT_MS = 25_000;

class PowerShellWorker {
  private proc: ReturnType<typeof _spawn> | null = null;
  private buffer = "";
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { id: number; resolve: (out: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;

  private ensureProcess(): void {
    if (this.proc && this.proc.stdin && !this.proc.killed) return;
    this.buffer = "";
    this.proc = _spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(String(d)));
    this.proc.stderr!.on("data", () => {
      /* stderr noise (progress) is ignored */
    });
    this.proc.on("exit", () => {
      this.proc = null;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        const p = this.pending;
        this.pending = null;
        p.reject(new Error("PowerShell worker exited"));
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (!this.pending) return;
    const marker = `REQDONE ${this.pending.id}`;
    const idx = this.buffer.indexOf(marker);
    if (idx >= 0) {
      const output = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + marker.length);
      const p = this.pending;
      clearTimeout(p.timer);
      this.pending = null;
      p.resolve(output);
    }
  }

  kill(): void {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }

  /** Serialize requests; the mouse layer issues one action at a time. */
  run(script: string): Promise<string> {
    const task = this.queue.then(() => this.runNow(script));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private runNow(script: string): Promise<string> {
    this.ensureProcess();
    const id = ++this.seq;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.kill(); // stuck — the next call respawns a fresh worker
        reject(new Error("PowerShell worker timed out"));
      }, MOUSE_PS_TIMEOUT_MS);
      this.pending = { id, resolve, reject, timer };
      this.proc!.stdin!.write(`${script}\nWrite-Output "REQDONE ${id}"\n`);
    });
  }
}

const mouseWorker = new PowerShellWorker();

async function runMouseScript(script: string): Promise<string> {
  try {
    return await mouseWorker.run(script);
  } catch (err) {
    // Fallback: one-shot invocation if the persistent worker is unavailable.
    const { stdout } = await execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: MOUSE_PS_TIMEOUT_MS, windowsHide: true }
    );
    return stdout;
  }
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i < min || i > max ? null : i;
}

const USER32_PINVOKE =
  `if (-not ([System.Management.Automation.PSTypeName]'W.U32').Type) { Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint F, uint DX, uint DY, uint D, UIntPtr E);' -Name U32 -Namespace W; }; `;

app.post("/api/computer/mouse", async (req, res) => {
  const { action } = req.body || {};
  try {
    let script = "";
    const parsePos = (stdout: string) => {
      const m = stdout.match(/POS (-?\d+) (-?\d+)/);
      if (!m) throw new Error("Could not parse cursor position from PowerShell output");
      return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
    };

    switch (action) {
      case "position": {
        script = "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output (\"POS {0} {1}\" -f $p.X,$p.Y)";
        break;
      }
      case "screen_bounds": {
        script =
          "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; Write-Output (\"BOUNDS {0} {1} {2} {3}\" -f $b.X,$b.Y,$b.Width,$b.Height)";
        break;
      }
      case "move": {
        const x = clampInt(req.body.x, -100000, 100000);
        const y = clampInt(req.body.y, -100000, 100000);
        if (x === null || y === null) return res.status(400).json({ success: false, errorKind: "invalid_coordinates", error: "Invalid coordinates" });
        // .NET fast path — no P/Invoke needed to set the cursor position.
        script =
          "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
          `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); ` +
          "$p=[System.Windows.Forms.Cursor]::Position; Write-Output (\"POS {0} {1}\" -f $p.X,$p.Y)";
        break;
      }
      case "click":
      case "double_click":
      case "right_click": {
        const x = clampInt(req.body.x, -100000, 100000);
        const y = clampInt(req.body.y, -100000, 100000);
        if (x === null || y === null) return res.status(400).json({ success: false, errorKind: "invalid_coordinates", error: "Invalid coordinates" });
        const downUp =
          action === "right_click" ? [8, 16] : [2, 4];
        const clickPair = `[W.U32]::mouse_event(${downUp[0]},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [W.U32]::mouse_event(${downUp[1]},0,0,0,[UIntPtr]::Zero)`;
        const doubleGap = action === "double_click" ? "Start-Sleep -Milliseconds 70; " : "";
        script =
          USER32_PINVOKE +
          `[void][W.U32]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 60; ${clickPair}; ` +
          (action === "double_click" ? `${doubleGap}${clickPair}; ` : "") +
          "Write-Output OK";
        break;
      }
      case "scroll": {
        const x = clampInt(req.body.x, -100000, 100000);
        const y = clampInt(req.body.y, -100000, 100000);
        const dRaw = clampInt(req.body.deltaY, -100000, 100000);
        if (x === null || y === null || dRaw === null || dRaw === 0) {
          return res.status(400).json({ success: false, errorKind: "invalid_coordinates", error: "Invalid scroll parameters" });
        }
        // mouse_event expects the wheel delta as unsigned; convert negatives.
        const wheel = dRaw >>> 0;
        script =
          USER32_PINVOKE +
          `[void][W.U32]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 50; [W.U32]::mouse_event(0x0800,0,0,${wheel},[UIntPtr]::Zero); Write-Output OK`;
        break;
      }
      case "drag": {
        const fromX = clampInt(req.body.fromX, -100000, 100000);
        const fromY = clampInt(req.body.fromY, -100000, 100000);
        const toX = clampInt(req.body.toX, -100000, 100000);
        const toY = clampInt(req.body.toY, -100000, 100000);
        if (fromX === null || fromY === null || toX === null || toY === null) {
          return res.status(400).json({ success: false, errorKind: "invalid_coordinates", error: "Invalid drag coordinates" });
        }
        const steps = Math.max(6, Math.min(24, Math.ceil(Math.hypot(toX - fromX, toY - fromY) / 40)));
        let moves = "";
        for (let i = 1; i <= steps; i++) {
          const ix = Math.round(fromX + ((toX - fromX) * i) / steps);
          const iy = Math.round(fromY + ((toY - fromY) * i) / steps);
          moves += `[void][W.U32]::SetCursorPos(${ix},${iy}); Start-Sleep -Milliseconds 12; `;
        }
        script =
          USER32_PINVOKE +
          `[void][W.U32]::SetCursorPos(${fromX},${fromY}); Start-Sleep -Milliseconds 80; ` +
          `[W.U32]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; ` +
          moves +
          `[void][W.U32]::SetCursorPos(${toX},${toY}); Start-Sleep -Milliseconds 40; ` +
          `[W.U32]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Write-Output (\"POS {0} {1}\" -f ${toX},${toY})`;
        break;
      }
      default:
        return res.status(400).json({ success: false, errorKind: "invalid_input", error: `Unknown mouse action "${String(action)}"` });
    }

    const stdout = await runMouseScript(script);

    if (stdout.includes("POS")) {
      return res.json({ success: true, position: parsePos(stdout) });
    }
    if (stdout.includes("BOUNDS")) {
      const m = stdout.match(/BOUNDS (-?\d+) (-?\d+) (\d+) (\d+)/);
      if (!m) return res.json({ success: false, errorKind: "backend_failed", error: "Could not parse screen bounds" });
      return res.json({
        success: true,
        bounds: { x: parseInt(m[1], 10), y: parseInt(m[2], 10), width: parseInt(m[3], 10), height: parseInt(m[4], 10) },
      });
    }
    if (stdout.includes("OK")) {
      return res.json({ success: true });
    }
    return res.json({ success: false, errorKind: "backend_failed", error: "Mouse action produced no recognizable output" });
  } catch (err: any) {
    const message = String(err?.message || err);
    const timedOut = (err as any)?.killed === true || message.toLowerCase().includes("timed out");
    return res.json({
      success: false,
      errorKind: timedOut ? "timeout" : "backend_failed",
      error: timedOut ? "Mouse action timed out" : message.slice(0, 300),
    });
  }
});

// ---- Keyboard control (Phase 6) ----
// SendInput-based keyboard injection sharing the persistent PowerShell worker.
// KEYEVENTF_UNICODE types text without simulating per-character keypresses and
// without touching the clipboard. The BROWSER enforces the 'keyboard.control'
// permission and validates key names before ever calling this endpoint; this
// endpoint re-validates everything server-side.

const CSHARP_KBD = `using System; using System.Runtime.InteropServices; namespace W { public static class Kbd {
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
[StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public uint pad0; [FieldOffset(0)] public uint pad1; [FieldOffset(0)] public uint pad2; }
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
const uint KEYUP = 2; const uint UNICODE = 4; const uint KEYBOARD = 1;
[DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
static int Send(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = KEYBOARD; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; return (int)SendInput(1, new INPUT[]{i}, Marshal.SizeOf(typeof(INPUT))); }
public static string TypeText(string text, int delayMs) { int ok = 0; foreach (char c in text) { if (c == 13) continue; if (c == 10) { Tap(13); ok++; System.Threading.Thread.Sleep(delayMs); continue; } Send(0, (ushort)c, UNICODE); Send(0, (ushort)c, UNICODE | KEYUP); System.Threading.Thread.Sleep(delayMs); ok++; } return "SENT " + ok; }
public static string Tap(ushort vk) { Send(vk, 0, 0); System.Threading.Thread.Sleep(15); Send(vk, 0, KEYUP); return "TAP " + vk; }
public static string Down(ushort vk) { Send(vk, 0, 0); return "DOWN " + vk; }
public static string Up(ushort vk) { Send(vk, 0, KEYUP); return "UP " + vk; }
} }`;

function kbdPrelude(): string {
  // Compile the SendInput wrapper once per worker process (guarded — Add-Type
  // throws if the type already exists). The C# is collapsed to a SINGLE line:
  // the worker protocol is line-based, and single-quoted PS strings can hold
  // the whole source (it contains no single quotes). -Name/-Namespace are NOT
  // valid with -TypeDefinition, so the namespace lives inside the C# source.
  const csharp = CSHARP_KBD.replace(/\r?\n/g, ' ');
  return `if (-not ([System.Management.Automation.PSTypeName]'W.Kbd').Type) { Add-Type -TypeDefinition '${csharp}' }; `;
}

function psEscapeText(text: string): string {
  // Escape for a PowerShell double-quoted string. Newlines MUST become
  // backtick escapes (a raw newline would split the line-based worker
  // protocol) — inserted AFTER backtick-escaping so they are not doubled.
  return text
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
    .replace(/\$/g, '`$')
    .replace(/\r\n/g, '`r`n')
    .replace(/\n/g, '`n')
    .replace(/\r/g, '`r');
}

function vkFor(key: string): number | null {
  const k = key.trim().toLowerCase();
  const named: Record<string, number> = {
    enter: 13, return: 13, escape: 27, esc: 27, tab: 9, backspace: 8, delete: 46, del: 46,
    insert: 45, space: 32, left: 37, up: 38, right: 39, down: 40,
    home: 36, end: 35, pageup: 33, pagedown: 34,
    minus: 189, equal: 187, comma: 188, period: 190, slash: 191, backquote: 192,
    bracketleft: 219, backslash: 220, bracketright: 221, semicolon: 186, quote: 222,
    ctrl: 17, control: 17, alt: 18, shift: 16, win: 91, cmd: 91, meta: 91,
  };
  if (named[k] !== undefined) return named[k];
  if (/^[a-z]$/.test(k)) return 65 + (k.charCodeAt(0) - 97);
  if (/^[0-9]$/.test(k)) return 48 + parseInt(k, 10);
  const fMatch = k.match(/^f([1-9]|1[0-2])$/);
  if (fMatch) return 111 + parseInt(fMatch[1], 10);
  return null;
}

app.post("/api/computer/keyboard", async (req, res) => {
  const { action } = req.body || {};
  try {
    let script = "";
    let expectSent = false;

    switch (action) {
      case "type": {
        const text = typeof req.body.text === "string" ? req.body.text : "";
        if (!text.trim() || text.length > 5000) {
          return res.status(400).json({ success: false, errorKind: "invalid_input", error: "Invalid text" });
        }
        const clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
        script =
          kbdPrelude() +
          `$r = [W.Kbd]::TypeText("${psEscapeText(clean)}", 3); Write-Output $r`;
        expectSent = true;
        break;
      }
      case "key": {
        const vk = vkFor(String(req.body.key ?? ""));
        if (vk === null) return res.status(400).json({ success: false, errorKind: "invalid_key", error: "Unknown key" });
        script = kbdPrelude() + `Write-Output ([W.Kbd]::Tap(${vk}))`;
        break;
      }
      case "hotkey": {
        const mods = Array.isArray(req.body.modifiers) ? req.body.modifiers : [];
        const vk = vkFor(String(req.body.key ?? ""));
        if (vk === null) return res.status(400).json({ success: false, errorKind: "invalid_key", error: "Unknown key" });
        const modVks: number[] = [];
        for (const mod of mods) {
          const m = vkFor(String(mod));
          if (m === null || ![16, 17, 18, 91].includes(m)) {
            return res.status(400).json({ success: false, errorKind: "invalid_key", error: "Unknown modifier" });
          }
          modVks.push(m);
        }
        if (modVks.length === 0 || modVks.length > 4) {
          return res.status(400).json({ success: false, errorKind: "invalid_input", error: "Invalid modifier count" });
        }
        const downs = modVks.map((m) => `[void][W.Kbd]::Down(${m}); Start-Sleep -Milliseconds 20; `).join("");
        const upsReversed = [...modVks].reverse().map((m) => `[void][W.Kbd]::Up(${m}); `).join("");
        // Modifiers are always released, even if the key tap throws (finally).
        script =
          kbdPrelude() +
          `try { ${downs}Start-Sleep -Milliseconds 40; [void][W.Kbd]::Tap(${vk}); Write-Output OK } finally { Start-Sleep -Milliseconds 20; ${upsReversed}Write-Output MODUP }`;
        break;
      }
      case "key_down": {
        const vk = vkFor(String(req.body.key ?? ""));
        if (vk === null) return res.status(400).json({ success: false, errorKind: "invalid_key", error: "Unknown key" });
        script = kbdPrelude() + `Write-Output ([W.Kbd]::Down(${vk}))`;
        break;
      }
      case "key_up": {
        const vk = vkFor(String(req.body.key ?? ""));
        if (vk === null) return res.status(400).json({ success: false, errorKind: "invalid_key", error: "Unknown key" });
        script = kbdPrelude() + `Write-Output ([W.Kbd]::Up(${vk}))`;
        break;
      }
      default:
        return res.status(400).json({ success: false, errorKind: "invalid_input", error: `Unknown keyboard action "${String(action)}"` });
    }

    const stdout = await runMouseScript(script);

    if (expectSent) {
      const m = stdout.match(/SENT (\d+)/);
      if (!m) return res.json({ success: false, errorKind: "backend_failed", error: "Type action produced no recognizable output" });
      return res.json({ success: true, sent: parseInt(m[1], 10) });
    }
    if (stdout.includes("MODUP") || stdout.includes("OK") || stdout.includes("TAP") || stdout.includes("DOWN") || stdout.includes("UP ")) {
      return res.json({ success: true });
    }
    return res.json({ success: false, errorKind: "backend_failed", error: "Keyboard action produced no recognizable output" });
  } catch (err: any) {
    const message = String(err?.message || err);
    const timedOut = message.toLowerCase().includes("timed out");
    return res.json({
      success: false,
      errorKind: timedOut ? "timeout" : "backend_failed",
      error: timedOut ? "Keyboard action timed out" : message.slice(0, 300),
    });
  }
});

// ---- Browser agent endpoints (Phase 8) ----
// Krisha-controlled headless Chrome/Edge over CDP (see browserCdp.ts). The
// endpoint layer exposes TYPED actions only (navigate / click-by-text /
// type-into-field / read-state) — callers cannot inject arbitrary JS.
import {
  browserPageState,
  browserNavigate,
  browserEvaluate,
  browserListTabs,
} from "./browserCdp";

function assertSafeHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Malformed URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}" — only http/https are allowed`);
  }
  return parsed;
}

app.post("/api/browser/state", async (req, res) => {
  try {
    const state = await browserPageState();
    let tabs: any[] = [];
    try {
      tabs = await browserListTabs();
    } catch {
      // tabs are best-effort
    }
    res.json({ success: true, state, tabs });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post("/api/browser/navigate", async (req, res) => {
  try {
    const url = assertSafeHttpUrl(String(req.body?.url ?? "")).toString();
    const result = await browserNavigate(url);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

async function browserHistoryAction(req: any, res: any, expression: string) {
  try {
    await browserEvaluate(expression);
    const state = await browserPageState();
    res.json({ success: true, url: state.url, title: state.title });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
}

app.post("/api/browser/back", async (req, res) => browserHistoryAction(req, res, "history.back()"));
app.post("/api/browser/forward", async (req, res) => browserHistoryAction(req, res, "history.forward()"));
app.post("/api/browser/refresh", async (req, res) => browserHistoryAction(req, res, "location.reload()"));

app.post("/api/browser/click", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    const kind = ["link", "button", "any"].includes(req.body?.kind) ? req.body.kind : "any";
    if (!text) return res.json({ success: false, error: "Missing click target text" });
    const result = await browserEvaluate<any>(
      `(() => {
        const q = ${JSON.stringify(text.toLowerCase())};
        const kind = ${JSON.stringify(kind)};
        const trim = s => (s || "").trim().toLowerCase();
        const cands = [];
        if (kind !== "button") cands.push(...[...document.querySelectorAll("a[href]")]);
        if (kind !== "link") cands.push(...[...document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]")]);
        for (const el of cands) {
          const t = trim(el.innerText || el.value || el.getAttribute("aria-label"));
          if (t && (t === q || t.includes(q))) {
            el.scrollIntoView({ block: "center" });
            el.click();
            return JSON.stringify({ clicked: t.slice(0, 80), href: el.href || null });
          }
        }
        return JSON.stringify({ clicked: null });
      })()`
    );
    const parsed = JSON.parse(result);
    if (!parsed.clicked) {
      return res.json({ success: false, errorKind: "not_found", error: `No visible link/button matching "${text.slice(0, 60)}" on the page` });
    }
    const state = await browserPageState();
    res.json({ success: true, clicked: parsed.clicked, href: parsed.href, url: state.url, title: state.title });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post("/api/browser/type", async (req, res) => {
  try {
    const match = String(req.body?.match ?? "").trim();
    const text = String(req.body?.text ?? "");
    if (!match) return res.json({ success: false, error: "Missing field match" });
    if (!text || text.length > 2000) return res.json({ success: false, errorKind: "invalid_input", error: "Invalid text" });
    const result = await browserEvaluate<any>(
      `(() => {
        const m = ${JSON.stringify(match.toLowerCase())};
        const text = ${JSON.stringify(text)};
        const fields = [...document.querySelectorAll("input, textarea")].filter(f => {
          const s = getComputedStyle(f);
          return s.display !== "none" && s.visibility !== "hidden";
        });
        const score = f => {
          const hay = [f.placeholder, f.name, f.id, f.getAttribute("aria-label"), (f.labels && f.labels[0] && f.labels[0].innerText)].map(x => (x || "").toLowerCase());
          if (hay.some(h => h && (h.includes(m) || m.includes(h)))) return 2;
          return hay.some(h => h && m.split(/\\s+/).some(w => w.length > 2 && h.includes(w))) ? 1 : 0;
        };
        let best = null, bestScore = 0;
        for (const f of fields) { const s = score(f); if (s > bestScore) { bestScore = s; best = f; } }
        if (!best || bestScore === 0) return JSON.stringify({ typed: false });
        best.scrollIntoView({ block: "center" });
        best.focus();
        const proto = best.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(best, text);
        best.dispatchEvent(new Event("input", { bubbles: true }));
        best.dispatchEvent(new Event("change", { bubbles: true }));
        return JSON.stringify({ typed: true, field: (best.name || best.placeholder || best.id || best.type || "").slice(0, 60) });
      })()`
    );
    const parsed = JSON.parse(result);
    if (!parsed.typed) {
      return res.json({ success: false, errorKind: "not_found", error: `No visible field matching "${match.slice(0, 60)}" on the page` });
    }
    res.json({ success: true, field: parsed.field });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post("/api/browser/scroll", async (req, res) => {
  try {
    const deltaY = Math.max(-20000, Math.min(20000, Math.round(Number(req.body?.deltaY) || 0)));
    await browserEvaluate(`window.scrollBy(0, ${deltaY}); "scrolled"`);
    res.json({ success: true });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post("/api/browser/tabs", async (req, res) => {
  try {
    const tabs = await browserListTabs();
    res.json({ success: true, tabs });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

// ---- Filesystem + application agent endpoints (Phase 9) ----
// Real-disk operations with strict path safety (allowed roots + system-dir
// denylist for mutations) and evidence-based verification. Application
// operations are allowlist-based; no arbitrary command execution.
import * as sys from './systemAgentServer';

function fsResult(res: any, fn: () => Promise<unknown>) {
  fn()
    .then((result) => res.json({ success: true, result }))
    .catch((err: any) => res.json({ success: false, error: String(err?.message || err).slice(0, 300) }));
}

app.post('/api/fs/list', (req, res) => fsResult(res, () => sys.fsList(String(req.body?.path ?? ''))));
app.post('/api/fs/inspect', (req, res) => fsResult(res, () => sys.fsInspect(String(req.body?.path ?? ''))));
app.post('/api/fs/search', (req, res) => fsResult(res, () => sys.fsSearch(String(req.body?.root ?? ''), String(req.body?.query ?? ''), Number(req.body?.maxDepth) || 4)));
app.post('/api/fs/read', (req, res) => fsResult(res, () => sys.fsReadFile(String(req.body?.path ?? ''), Number(req.body?.offset) || 0)));
app.post('/api/fs/create', (req, res) => fsResult(res, () => sys.fsCreate(String(req.body?.path ?? ''), req.body?.type === 'dir' ? 'dir' : 'file', typeof req.body?.content === 'string' ? req.body.content : undefined)));
app.post('/api/fs/rename', (req, res) => fsResult(res, () => sys.fsRename(String(req.body?.path ?? ''), String(req.body?.newName ?? ''))));
app.post('/api/fs/copy', (req, res) => fsResult(res, () => sys.fsCopy(String(req.body?.from ?? ''), String(req.body?.to ?? ''), req.body?.overwrite === true)));
app.post('/api/fs/move', (req, res) => fsResult(res, () => sys.fsMove(String(req.body?.from ?? ''), String(req.body?.to ?? ''), req.body?.overwrite === true)));
app.post('/api/fs/delete', (req, res) => fsResult(res, () => sys.fsDelete(String(req.body?.path ?? ''), req.body?.recursive === true)));
app.post('/api/fs/open', (req, res) => fsResult(res, () => sys.fsOpenWithAssociation(String(req.body?.path ?? ''))));

app.post('/api/app/discover', (req, res) =>
  fsResult(res, () => sys.appDiscover(req.body?.force === true).then((apps) => sys.appSearch(apps, String(req.body?.query ?? ''))))
);
app.post('/api/app/launch', (req, res) =>
  fsResult(res, () => (req.body?.path ? sys.appLaunchByPath(String(req.body.path)) : sys.appLaunchByName(String(req.body?.name ?? ''))))
);
app.post('/api/app/status', (req, res) => fsResult(res, () => sys.appStatus(String(req.body?.name ?? ''))));
app.post('/api/app/close', (req, res) => fsResult(res, () => sys.appClose(Number(req.body?.pid), req.body?.force === true)));
app.post('/api/app/focus', (req, res) => fsResult(res, () => sys.appFocus(Number(req.body?.pid))));

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

