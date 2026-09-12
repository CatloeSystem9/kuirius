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

