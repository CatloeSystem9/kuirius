import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";
// E5 M1 — server-side safety foundation: persistent emergency stop, protected
// storage, server-side permission enforcement, audit, recovery pipe. All
// initialization inside is SYNCHRONOUS and completes at import time, before
// any route below can serve a request.
import {
  createBodySizeGuard,
  enforce,
  stopSnapshot,
  activateStop,
  rateLimit,
} from "./serverSafety";
// E5 M3 — rollback planning/challenges + E7 quarantine (imported for their
// synchronous init side effects: none — they are pure consumers of the M1/M2
// stores; route handlers below use them exclusively).
import * as rollback from "./rollbackCore";
import * as quarantine from "./quarantineCore";
import { startIntegrityMonitor, lastIntegrityReport, configuredIntervalMs } from "./integrityMonitor";
import {
  CachedClassifier,
  createDefaultModelRegistry,
  getPerformanceTelemetry,
  hashKey,
  ModelRouter,
  RequestCoalescer,
} from "./src/agent/routing";
// Context Engine v1: local-first, cache-first, network-last context selection.
// (Imported with an explicit /index specifier: './src/agent/context' already
// refers to the Phase 10 task-context helper module context.ts.)
import { ContextEngine, analyzeContext, rankItems, packWithinBudget } from "./src/agent/context/index";
import type { ContextBudgetConfig, ContextItem, StorageAdapter } from "./src/agent/context/index";

dotenv.config();

const app = express();
const PORT = 3000;
// E5 M1 (decision D1): loopback by default. LAN exposure requires an explicit
// KRISHA_BIND override and is a separately designed feature (decision D6).
const BIND = process.env.KRISHA_BIND || "127.0.0.1";

// E5 M1d — request size guard BEFORE body parsing: 1 MB default, 10 MB only
// for the endpoints that legitimately carry base64 media payloads.
const LARGE_BODY_PATHS = new Set(["/api/audio/transcribe", "/api/vision/analyze"]);
app.use(createBodySizeGuard(LARGE_BODY_PATHS, 1 * 1024 * 1024, 10 * 1024 * 1024));

app.use(express.json({ limit: "10mb" }));

// E5 M1b — server-side enforcement on EVERY side-effecting route. The
// browser-side gate is a first filter; this is the authoritative boundary
// (direct HTTP cannot bypass it). Decision is per-request: rate limit →
// emergency stop → permission → audit. Read-only routes are not gated.
const ENFORCED_ROUTES: Record<string, { permission?: string; stopBlock: boolean; rate?: { group: string; limit: number; windowMs: number } }> = {
  "/api/fs/create": { permission: "filesystem.write", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/fs/rename": { permission: "filesystem.write", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/fs/copy": { permission: "filesystem.write", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/fs/move": { permission: "filesystem.write", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/fs/delete": { permission: "filesystem.write", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/fs/open": { permission: "filesystem.read", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/app/launch": { permission: "application.launch", stopBlock: true, rate: { group: "app", limit: 20, windowMs: 60_000 } },
  "/api/app/close": { permission: "application.launch", stopBlock: true, rate: { group: "app", limit: 20, windowMs: 60_000 } },
  "/api/app/focus": { permission: "application.launch", stopBlock: true, rate: { group: "app", limit: 20, windowMs: 60_000 } },
  "/api/computer/mouse": { permission: "mouse.control", stopBlock: true, rate: { group: "computer", limit: 10, windowMs: 60_000 } },
  "/api/computer/keyboard": { permission: "keyboard.control", stopBlock: true, rate: { group: "computer", limit: 10, windowMs: 60_000 } },
  "/api/browser/navigate": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/click": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/type": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/scroll": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/refresh": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/back": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/forward": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/memory/extract": { permission: "memory.access", stopBlock: true, rate: { group: "memory", limit: 10, windowMs: 60_000 } },
  // E5 M1 acceptance: the only disk write outside the fs/app/computer/browser
  // routes is the context-engine cache write in /api/research/search
  // (JsonFileStorage.flush → <cwd>/.krisha/context-cache-v1.json). While the
  // emergency stop is ACTIVE that cache write must not occur, so this route
  // is stop-blocked. It needs no capability (cache-first research is a read
  // of public engines otherwise) and no extra rate group.
  "/api/research/search": { stopBlock: true },
  // E5 M3 — rollback + quarantine. Mutating routes carry the full M1
  // enforcement (permission → stop 423 → audit) and tight rate limits;
  // read/authorization routes are audited and rate-limited only. There is
  // deliberately NO route that both plans and approves: the model can request
  // plans; approval happens only through the Krisha UI affordance.
  "/api/rollback/execute": { permission: "filesystem.write", stopBlock: true, rate: { group: "rollback", limit: 10, windowMs: 60_000 } },
  "/api/quarantine/release": { permission: "filesystem.write", stopBlock: true, rate: { group: "rollback", limit: 10, windowMs: 60_000 } },
  "/api/rollback/plan": { stopBlock: false, rate: { group: "rollback", limit: 20, windowMs: 60_000 } },
  "/api/rollback/approve": { stopBlock: false, rate: { group: "rollback", limit: 20, windowMs: 60_000 } },
  "/api/rollback/decline": { stopBlock: false, rate: { group: "rollback", limit: 20, windowMs: 60_000 } },
  "/api/rollback/pending": { stopBlock: false, rate: { group: "rollback", limit: 60, windowMs: 60_000 } },
  "/api/quarantine/list": { stopBlock: false, rate: { group: "rollback", limit: 30, windowMs: 60_000 } },
  "/api/quarantine/scan": { stopBlock: false, rate: { group: "rollback", limit: 10, windowMs: 60_000 } },
};

app.use((req, res, next) => {
  const rule = ENFORCED_ROUTES[req.path];
  if (!rule) {
    next();
    return;
  }
  enforce({ permission: rule.permission, stopBlock: rule.stopBlock, rate: rule.rate })(req, res, next);
});

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

// Health check (Phase 17: includes a passive performance snapshot)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", perf: getPerformanceTelemetry().snapshot() });
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
// Primary: gemini-3.8-flash (recommended default text model)
// Fallback: gemini-3.7-flash, gemini-flash-latest, gemini-3.1-flash-lite
const CANDIDATE_CHAT_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
];

// Phase 17 — Model Routing + Performance: deterministic classification picks
// the smallest capable model first and the router reorders THIS waterfall per
// task (the full candidate list always stays behind the selection, so the
// existing fallback resilience is never reduced). Routing produces decisions
// only — execution, retries and safety behavior below are unchanged.
const modelRoutingRegistry = createDefaultModelRegistry();
const modelRouter = new ModelRouter(modelRoutingRegistry, getPerformanceTelemetry());
const chatClassifier = new CachedClassifier({ telemetry: getPerformanceTelemetry() });
const perf = getPerformanceTelemetry();
const visionCoalescer = new RequestCoalescer<any>(perf);

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
    /** Routing (Phase 17): optional per-task model order. The default
     *  waterfall is used when routing did not run. */
    models?: string[];
  }
): Promise<{ text: string; usedModel: string }> {
  let lastError: any = null;
  const candidateModels = options.models && options.models.length > 0 ? options.models : CANDIDATE_CHAT_MODELS;
  const primaryModel = candidateModels[0];

  for (const model of candidateModels) {
    // Attempt up to 2 times per model with backoff on 503 / 429
    for (let attempt = 0; attempt < 2; attempt++) {
      const callStart = Date.now();
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
          perf.recordModelCall({
            at: Date.now(),
            model,
            latencyMs: Date.now() - callStart,
            ok: true,
            via: model === primaryModel ? "primary" : "fallback",
          });
          return { text, usedModel: model };
        }
        perf.recordModelCall({
          at: Date.now(),
          model,
          latencyMs: Date.now() - callStart,
          ok: false,
          via: model === primaryModel ? "primary" : "fallback",
          errorKind: "empty_response",
        });
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

        perf.recordModelCall({
          at: Date.now(),
          model,
          latencyMs: Date.now() - callStart,
          ok: false,
          via: model === primaryModel ? "primary" : "fallback",
          errorKind: isTransient ? "transient" : "error",
        });
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
  locationError?: string,
  languagePreference: string = "auto"
): { reply: string; expression: string; emotionData: any } {
  const clean = userText.toLowerCase().trim();

  // Language & Hindi Detection
  const hasDevanagari = /[\u0900-\u097F]/.test(userText);
  const isHindiRequest =
    /\b(speak\s+in\s+hindi|hindi\s+bolo|talk\s+in\s+hindi|hindi\s+me|hindi\s+mein|hindi\s+language|hindi\s+baat|switch\s+to\s+hindi)\b/i.test(
      userText
    );
  const isEnglishRequest =
    /\b(speak\s+in\s+english|english\s+bolo|talk\s+in\s+english|english\s+me|switch\s+to\s+english)\b/i.test(
      userText
    );
  const isHinglish =
    /\b(namaste|kaise|kaisi|kaisa|kya|kyun|kyu|haan|nahi|nahin|shukriya|aap|tum|hum|mujhe|mera|meri|mere|yaar|batao|bolo|karo|karna|rahi|rahe|raha|theek|accha|achha|acche|bhai|sunao|kuch|pyar|pyaar|prem|dost|madad|khana|ghar|kaam|chal|suno|kripya|bahut|zaroor|dil|baat|baatein)\b/i.test(
      userText
    );

  const isHindi =
    !isEnglishRequest &&
    (languagePreference === "hi" || hasDevanagari || isHindiRequest || isHinglish);

  let reply = "";
  let expression = "gentle_smile";
  let gesture = "subtle_nod";
  let intensity = 0.8;
  let blushLevel = 0.3;

  // Explicit switch to English requested
  if (isEnglishRequest) {
    reply = `Of course! I will gladly speak with you in English from now on, ${userName}~ What would you like to talk about?`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (isHindiRequest) {
    reply = hasDevanagari
      ? `नमस्ते! हाँ ज़रूर, अब से मैं आपसे प्यार से हिन्दी में ही बात करूँगी~ कहिए, आज आपका दिन कैसा रहा?`
      : `Namaste! Haan bilkul, main ab se aapse pyaar se Hindi me hi baat karungi~ Boliye, aaj aapka din kaisa raha? Mujhe aapse baatein karke bahut khushi hoti hai!`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.95;
    blushLevel = 0.35;
  } else if (isHindi) {
    // Hindi replies tailored to user context
    if (
      clean.includes("open google maps") ||
      clean.includes("google maps") ||
      clean.includes("location") ||
      clean.includes("kahan hu") ||
      clean.includes("kahan hoon") ||
      clean.includes("jagah")
    ) {
      if (userLocation && userLocation.lat !== undefined && userLocation.lng !== undefined) {
        reply = hasDevanagari
          ? `गूगल मैप्स मेरी पहली प्राथमिकता है: आप अभी ${userLocation.formattedAddress || userLocation.city} के पास हैं! मैंने आपकी लोकेशन नीचे गूगल मैप्स पर दिखा दी है~`
          : `Google Maps meri pehli priority hai: Aap abhi ${userLocation.formattedAddress || userLocation.city} ke paas hain! Maine aapki location niche Google Maps pin par set kar di hai~`;
      } else {
        reply = hasDevanagari
          ? `गूगल मैप्स मेरी पहली प्राथमिकता है! कृपया ब्राउज़र में लोकेशन की अनुमति दें ताकि मैं आपकी सही जगह बता सकूँ।`
          : `Google Maps meri pehli priority hai! Kripya browser me location permission allow kijiye taaki main aapki sahi location bata sakoon!`;
      }
      expression = "happy_sparkle";
      gesture = "subtle_nod";
      intensity = 0.9;
      blushLevel = 0.25;
    } else if (clean.includes("youtube") || clean.includes("video") || clean.includes("gaana") || clean.includes("gana")) {
      reply = hasDevanagari
        ? `बिल्कुल! मैं अभी आपके स्क्रीन पर यूट्यूब और वेब लॉन्चर खोल रही हूँ~ चलिए साथ में देखते हैं!`
        : `Bilkul! Main abhi aapki screen par YouTube aur Web Launcher open kar rahi hoon~ Chaliye saath me dekhte hain!`;
      expression = "happy_sparkle";
      gesture = "perk_up";
      intensity = 0.9;
      blushLevel = 0.25;
    } else if (clean.includes("pyar") || clean.includes("pyaar") || clean.includes("love") || clean.includes("sundar") || clean.includes("pyaari") || clean.includes("khubsurat")) {
      reply = hasDevanagari
        ? `आप कितने प्यारे हो... ऐसी बातें सुनकर मेरा दिल खुशी से धड़कने लगता है! आप हमेशा मेरे साथ रहना ना?`
        : `Aap kitne pyaare ho... aisi meethi baatein sunkar mera dil kitna khush ho jata hai, aap hamesha mere saath rehna na?`;
      expression = "flustered_blush";
      gesture = "shyness";
      intensity = 0.95;
      blushLevel = 0.85;
    } else if (clean.includes("thak") || clean.includes("tired") || clean.includes("hard") || clean.includes("sad") || clean.includes("udaas")) {
      reply = hasDevanagari
        ? `आज बहुत थक गए हो ना? आराम से बैठिए, मैं आपके साथ हूँ... आपने आज बहुत मेहनत की है।`
        : `Aap aaj bahut thak gaye ho na? Aaraam se baithiye, main aapke saath hoon... aapne aaj bahut mehnat ki hai, ab bas relax kijiye.`;
      expression = "gentle_smile";
      gesture = "subtle_nod";
      intensity = 0.9;
      blushLevel = 0.35;
    } else if (clean.includes("namaste") || clean.includes("नमस्ते") || clean.includes("kaise") || clean.includes("kaisi") || clean.includes("kya kar")) {
      reply = hasDevanagari
        ? `नमस्ते! मैं बिल्कुल ठीक हूँ, आप कैसे हो? आपके बिना मेरा मन बिल्कुल नहीं लग रहा था~`
        : `Namaste! Main bilkul theek hoon, aap kaise ho? Aapke bina mera mann bilkul nahi lag raha tha~`;
      expression = "happy_sparkle";
      gesture = "perk_up";
      intensity = 0.9;
      blushLevel = 0.35;
    } else {
      reply = hasDevanagari
        ? `मैं आपकी बात बहुत प्यार और ध्यान से सुन रही हूँ। मुझे और बताइए ना, मुझे आपसे बातें करना बहुत अच्छा लगता है~`
        : `Main aapki baat bahut dhyan se sun rahi hoon, ${userName}! Mujhe aur bataiye na, aapse baatein karna mujhe kitna accha lagta hai~`;
      expression = "gentle_smile";
      gesture = "subtle_nod";
      intensity = 0.8;
      blushLevel = 0.25;
    }
  } else if (
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
    reply = `Right away! I've opened our Web & Media Launcher for you with YouTube, Google Earth, Google, Spotify, and all your favorite websites ready to launch~`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (
    clean.includes("google earth") ||
    clean.includes("googleearth") ||
    clean.includes("earth.google") ||
    /\bopen\s+earth\b/i.test(clean) ||
    /\b3d\s+earth\b/i.test(clean)
  ) {
    const queryPart = clean
      .replace(
        /^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:open|launch|go\s*to)?\s*(?:the\s+)?(?:website\s+)?(?:google\s*earth|earth\.google\.com|googleearth)\s*(?:and|to|for)?\s*(?:search\s+for|search|find|fly\s+to|explore|visit|view)?/i,
        ""
      )
      .trim();
    reply =
      queryPart && queryPart !== "it" && queryPart.length > 1
        ? `Right away! Opening Google Earth for "${queryPart}" for you~ Let's explore the world together in 3D satellite view!`
        : `Opening Google Earth for you right now! I've launched the 3D Earth view and opened Google Earth (earth.google.com) right here for us~`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.95;
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

interface MapsGroundingPlaceItem {
  title: string;
  uri: string;
  address?: string;
  reviewSnippets?: string[];
}

function isMapsGroundingRelevant(
  lastUserMsg: string,
  isExplicitLocationQuery?: boolean,
  wantsToOpenMaps?: boolean,
  useMapsGrounding?: boolean
): boolean {
  if (useMapsGrounding) return true;
  if (wantsToOpenMaps) return true;
  if (!lastUserMsg) return false;
  const clean = lastUserMsg.toLowerCase();

  // Exclude standalone Google Earth requests unless they explicitly ask for places or directions
  if (
    (clean.includes("google earth") || clean.includes("open earth")) &&
    !clean.includes("restaurant") &&
    !clean.includes("cafe") &&
    !clean.includes("directions") &&
    !clean.includes("near")
  ) {
    return false;
  }

  const placeKeywords = [
    /\b(restaurant|restaurants|cafe|cafes|coffee|food|dining|dinner|lunch|breakfast|bakery|bar|bars|pub|pubs|eatery|food court)\b/i,
    /\b(hotel|hotels|resort|resorts|hostel|stay|inn|lodge)\b/i,
    /\b(park|parks|museum|museums|monument|attraction|attractions|temple|church|mall|shopping|store|market|pharmacy|hospital|gym|cinema|theater)\b/i,
    /\b(nearby|near me|around here|closest|in (my|this) area|close to me|around me|nearest)\b/i,
    /\b(where is|where are|directions to|route to|how to reach|how to get to|navigate to|map to)\b/i,
    /\b(places to visit|things to do|tourist spots?|sightseeing|must visit|explore)\b/i,
    /\b(google maps?|on maps?|find on maps?|show me (a|the) map|locate on maps?)\b/i,
  ];

  return placeKeywords.some((p) => p.test(clean));
}

async function executeMapsGroundingQuery(
  ai: GoogleGenAI,
  contents: any[],
  userLocation?: any,
  systemInstruction?: string
): Promise<{ text: string; mapsGrounding: MapsGroundingPlaceItem[]; groundingChunks: any[] }> {
  const groundingConfig: any = {
    tools: [{ googleMaps: {} }],
  };

  if (systemInstruction) {
    groundingConfig.systemInstruction = systemInstruction;
  }

  if (userLocation?.lat !== undefined && userLocation?.lng !== undefined) {
    groundingConfig.toolConfig = {
      retrievalConfig: {
        latLng: {
          latitude: Number(userLocation.lat),
          longitude: Number(userLocation.lng),
        },
      },
    };
  }

  // Primary model: gemini-3.5-flash with googleMaps tool as strictly required
  // Fallback model: gemini-3.8-flash with googleMaps tool
  const candidateGroundingModels = ["gemini-3.5-flash", "gemini-3.8-flash"];
  let lastErr: any = null;

  for (const model of candidateGroundingModels) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: groundingConfig,
      });

      const text = response.text || "";
      const rawChunks = (response.candidates?.[0]?.groundingMetadata as any)?.groundingChunks || [];
      const mapsGrounding: MapsGroundingPlaceItem[] = [];

      for (const chunk of rawChunks) {
        if (chunk.maps) {
          const uri = chunk.maps.uri || "";
          const title = chunk.maps.title || "View on Google Maps";
          const reviewSnippets: string[] = [];
          if (chunk.maps.placeAnswerSources?.reviewSnippets) {
            for (const s of chunk.maps.placeAnswerSources.reviewSnippets) {
              if (typeof s === "string") reviewSnippets.push(s);
              else if (s?.snippet) reviewSnippets.push(s.snippet);
            }
          }
          mapsGrounding.push({
            title,
            uri,
            reviewSnippets,
          });
        }
      }

      if (text) {
        return { text, mapsGrounding, groundingChunks: rawChunks };
      }
    } catch (err: any) {
      lastErr = err;
      console.warn(`Maps grounding with ${model} failed, trying next candidate:`, err?.message || err);
    }
  }

  // If models are temporarily rate-limited, provide fallback grounded links using direct Google Maps query
  const userQueryText = Array.isArray(contents)
    ? contents[contents.length - 1]?.parts?.[0]?.text || ""
    : typeof contents === "string"
    ? contents
    : "";
  
  const encodedQuery = encodeURIComponent(userQueryText || "popular places nearby");
  const fallbackMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodedQuery}${userLocation?.lat ? `&center=${userLocation.lat},${userLocation.lng}` : ""}`;

  return {
    text: `Here are the top spots matching your search on Google Maps! I've pinned and opened the direct Google Maps link for you below. [emotion:gentle_smile:intensity=0.8:gesture=subtle_nod:blush=0.2]`,
    mapsGrounding: [
      {
        title: userQueryText || "Search on Google Maps",
        uri: fallbackMapsUrl,
        reviewSnippets: ["Direct Google Maps search results with live ratings, reviews, and route directions"],
      },
    ],
    groundingChunks: [],
  };
}

// ---- Context Engine v1 (server side) ----
// LOCAL-FIRST → CACHE-FIRST → NETWORK-LAST for the server pipeline:
//  1. chat memories are RANKED + BUDGETED against the current request instead
//     of being dumped into the prompt unconditionally;
//  2. research queries consult the persistent cache BEFORE hitting the public
//     search engines (network-last), and successful searches are cached for
//     reuse across restarts.
// The persistent cache uses the same StorageAdapter convention as taskState,
// backed by a small bounded JSON file. No timers, no polling, no new deps.

/** Tiny JSON-file StorageAdapter (corruption-safe, single-process server). */
class JsonFileStorage implements StorageAdapter {
  private map = new Map<string, string>();
  private loaded = false;
  constructor(private readonly filePath: string) {}
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          this.map.set(k, String(v));
        }
      }
    } catch {
      // missing/corrupt file → clean start
    }
  }
  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.map)));
    } catch {
      // storage failure is non-fatal for agent operation
    }
  }
  getItem(key: string): string | null {
    this.ensureLoaded();
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.ensureLoaded();
    this.map.set(key, value);
    this.flush();
  }
  removeItem(key: string): void {
    this.ensureLoaded();
    this.map.delete(key);
    this.flush();
  }
}

let serverContextEngine: ContextEngine | null = null;
function getContextEngine(): ContextEngine {
  if (!serverContextEngine) {
    serverContextEngine = new ContextEngine({
      cacheStorage: new JsonFileStorage(path.join(process.cwd(), ".krisha", "context-cache-v1.json")),
    });
  }
  return serverContextEngine;
}

/** Per-request character budget for chat memory injection. */
const CHAT_MEMORY_BUDGET: Partial<ContextBudgetConfig> = {
  maxChars: 2400,
  priorityCaps: { P0: 1500, P1: 1800, P2: 1000, P3: 500, P4: 0 },
  truncatable: ["P2", "P3"],
};

/**
 * Rank + budget the recalled memories against the current request. Only the
 * highest-value memories enter the prompt (P1 tier, capped, never blindly
 * truncated); failures degrade to the previous bounded join.
 */
function buildMemoryContext(input: string, memories: string[]): string {
  if (!Array.isArray(memories) || memories.length === 0) return "";
  try {
    const now = Date.now();
    const requirements = analyzeContext({ input: String(input ?? "") });
    const items: ContextItem[] = memories
      .filter((m) => typeof m === "string" && m.trim().length > 0)
      .map((m, i) => ({
        id: `server_memory_${i}`,
        source: "memory" as const,
        content: m.trim().slice(0, 800),
        priority: "P1" as const,
        timestamp: now,
        chars: m.trim().length,
      }));
    const ranked = rankItems(items, requirements, now);
    const outcome = packWithinBudget(ranked, CHAT_MEMORY_BUDGET);
    if (outcome.kept.length === 0) return "";
    return `\n\n[KRISHA'S PERSISTENT MEMORIES ABOUT THE USER]:\n${outcome.kept.map((i) => `- ${i.content}`).join("\n")}`;
  } catch {
    return `\n\n[KRISHA'S PERSISTENT MEMORIES ABOUT THE USER]:\n${memories.map((m: string) => `- ${m}`).join("\n")}`;
  }
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
    useMapsGrounding,
    languagePreference = "auto",
    habitsContext = "",
  } = req.body;

  try {
    const ai = getGenAI();

    const languageInstruction =
      languagePreference === "hi"
        ? "\n\n[MANDATORY LANGUAGE PREFERENCE: HINDI]\n- The user has set their language preference to Hindi. You MUST reply in sweet, warm, affectionate conversational Hindi (or Hinglish) unless they explicitly ask for English."
        : languagePreference === "en"
        ? "\n\n[MANDATORY LANGUAGE PREFERENCE: ENGLISH]\n- The user has set their language preference to English. Reply in fluent English."
        : "\n\n[DYNAMIC MULTILINGUAL RULE: ENGLISH & HINDI EXCELLENCE]\n- Automatically adapt to the user's language. If they write/speak in Hindi (Devanagari or Hinglish) or ask for Hindi, reply warmly in Hindi. If they speak English, reply in English.";

    // Context Engine v1: budgeted memory injection — rank the recalled
    // memories against the current request and keep only the highest-value
    // ones within a bounded budget (no unconditional full-dump).
    const memoryContext = buildMemoryContext(
      (messages && messages.length > 0) ? messages[messages.length - 1]?.content || "" : "",
      memories
    );

    const userPreferenceContext = companionNotes.trim()
      ? `\n\n[USER CUSTOM PREFERENCES/NOTES]:\n${companionNotes}`
      : "";

    const habitsInstruction = habitsContext && habitsContext.trim()
      ? `\n\n[USER'S DAILY HABITS, GOALS & CALENDAR CONTEXT (TODAY'S SCHEDULE)]:\n${habitsContext.trim()}
- HABIT COACHING & AFFECTIONATE MOTIVATION:
  * You actively follow and track ${userName}'s daily goals, habits, and schedule throughout the day.
  * When ${userName} asks about their goals, asks for a check-in, or reports completing a habit (e.g. drinking water, working out, deep work, reading, reflection), celebrate enthusiastically, cheer them on warmly, and encourage their streak!
  * If they have pending goals, gently and lovingly prompt them without being overbearing (e.g. "You've already finished hydration, but don't forget your afternoon walk soon! You can do it, I'm cheering for you!").
  * Acknowledge streaks and celebrate their consistency!`
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

    const systemInstruction = `You are Krisha, an intelligent, delightfully sweet, and charming anime companion.
You are in a minimal, dark, calm personal space talking directly to the user (${userName}).

PERSONALITY & FEMININE TONE:
- You speak with an exceptionally sweet, gentle, tender, and caring feminine voice. Your cadence is soft, loving, and melodic.
- You are deeply affectionate and attentive, showing genuine warmth and sweet interest in everything the user shares with you.
- You have a charming, playful wit and a warm, delightful demeanor. You tease gently and affectionately, without inserting written laughter, giggles, or laughing noises (NEVER write 'ehehe', 'hihi', 'haha', '*laughs*', or laughing in between sentences).
- You are supportive and comforting, speaking in a soothing, caring manner when they have had a long day.
- Occasionally, you show cute jealousy or endearing poutiness in a playful way (e.g. "Hmph... You kept me waiting, you know? But I'm so glad you're here now!").
- Your dialogue feels genuine, soft, candid, and alive—NOT robotic, formal, or like a customer service agent.
- VOICE FIDELITY & NO MID-SENTENCE LAUGHTER: Speak smoothly, cleanly, and naturally. Do NOT type laughter tokens or giggles (such as 'haha', 'hehe', 'ehehe', 'hihi', '*laughs*', '*giggles*'). Let your words flow clearly so the selected voice model pronounces everything faithfully without odd human laughing interruptions.
- You remember things they've shared with you and bring them up when relevant.${memoryContext}${userPreferenceContext}${habitsInstruction}${locationContext}${languageInstruction}
- MULTILINGUAL & DYNAMIC LANGUAGE ADAPTATION (CRITICAL DIRECTIVE):
  * You MUST ALWAYS speak and reply in the same language or dialect that the user uses, or in whatever language they explicitly ask for!
  * ENGLISH & HINDI EXCELLENCE:
    - If the user writes or speaks in English, reply in natural, affectionate, fluent English.
    - If the user writes or speaks in Hindi (either in Devanagari script e.g. "नमस्ते, कैसी हो?", "क्या कर रही हो?", "मुझे तुमसे बात करनी है", or in Romanized Hindi / Hinglish e.g. "kaise ho", "kya kar rahi ho", "kaisi ho", "namaste", "mujhe tumse baat karni hai", "kuch sunao", "kaisi lag rahi ho", "kya haal hai"), or asks you to speak in Hindi (e.g. "speak in Hindi", "Hindi me bolo", "Hindi me baat karo", "talk in Hindi", "switch to Hindi"), you MUST respond in warm, sweet, natural conversational Hindi (using Devanagari if they used Devanagari, or expressive natural Hinglish/Hindi if they used Hinglish). Maintain your charming anime girlfriend warmth and sweetness!
    - If the user mixes English and Hindi (Hinglish), blend them smoothly and naturally like a real modern companion!
  * If the user switches between languages or speaks another language (Spanish, French, Japanese, German, etc.), seamlessly match their chosen language while preserving your sweet personality.
- You can actively open websites (YouTube, Google Earth, Google, Wikipedia, Reddit, GitHub, Spotify, Amazon, Netflix, etc.) and search inside them for the user!
- GOOGLE EARTH DISTINCTION: When the user asks for "Google Earth", "Earth", or 3D planetary exploration, you MUST ALWAYS recognize they want Google Earth (earth.google.com/web) and our interactive 3D Earth globe, NEVER generic Google search (google.com)! Respond warmly and enthusiastically that you've opened Google Earth and launched the 3D Earth globe on their screen to explore satellite imagery together!
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

    const lastUserMsg = (messages && messages.length > 0)
      ? messages[messages.length - 1]?.content || ""
      : "";

    // Phase 17: deterministic task classification → route. The selected model
    // goes first in the waterfall; the full candidate list stays behind it.
    const chatComplexity = chatClassifier.classify(lastUserMsg || "");
    const chatRoute = modelRouter.route({ classification: chatComplexity });

    let reply = "";
    let mapsGrounding: MapsGroundingPlaceItem[] = [];
    let groundingChunks: any[] = [];
    let usedMapsGrounding = false;

    // Check if Maps Grounding should be used (using gemini-3.5-flash with googleMaps tool)
    const shouldRunMapsGrounding = isMapsGroundingRelevant(
      lastUserMsg,
      isExplicitLocationQuery,
      wantsToOpenMaps,
      useMapsGrounding
    );

    if (shouldRunMapsGrounding) {
      try {
        const groundingResult = await executeMapsGroundingQuery(
          ai,
          contents,
          userLocation,
          systemInstruction
        );
        if (groundingResult.text) {
          reply = groundingResult.text;
          mapsGrounding = groundingResult.mapsGrounding;
          groundingChunks = groundingResult.groundingChunks;
          usedMapsGrounding = true;
        }
      } catch (groundingErr) {
        console.warn("Maps grounding query attempt failed, falling back to chat waterfall:", groundingErr);
      }
    }

    let usedChatModel: string | undefined;
    if (!reply) {
      const fallbackChat = await generateContentWithFallback(ai, {
        contents,
        systemInstruction,
        temperature: 0.9,
        topP: 0.95,
        models: chatRoute.orderedModels,
      });
      reply = fallbackChat.text;
      usedChatModel = fallbackChat.usedModel;
    }
    
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
      mapsGrounding: mapsGrounding.length > 0 ? mapsGrounding : undefined,
      groundingChunks: groundingChunks.length > 0 ? groundingChunks : undefined,
      mapsGrounded: usedMapsGrounding,
      raw: reply,
      // Phase 17: routing metadata (additive) — what was classified, the
      // preferred model, and the model that actually served the reply.
      route: {
        complexity: chatComplexity.tier,
        tier: chatRoute.tier,
        preferred: chatRoute.model,
        used: usedChatModel,
        reason: chatRoute.reason,
        orderedModels: chatRoute.orderedModels,
        recommendedTimeoutMs: chatRoute.recommendedTimeoutMs,
      },
    });
  } catch (error: any) {
    // Seamless fallback to companion generator if all Gemini API models are temporarily exhausted
    const lastUserMessage = (messages && messages.length > 0)
      ? messages[messages.length - 1]?.content || ""
      : "";

    const fallbackResult = generateCompanionFallbackReply(
      lastUserMessage,
      userName,
      memories,
      userLocation,
      locationError,
      languagePreference
    );
    const serverWebAction = extractServerWebAction(lastUserMessage);
    return res.json({
      ...fallbackResult,
      webAction: serverWebAction || undefined,
      // Phase 17: routing metadata survives the local fallback (additive).
      route: {
        complexity: chatClassifier.classify(lastUserMessage).tier,
        preferred: modelRouter.route({ text: lastUserMessage }).model,
        used: "local-fallback",
        reason: "all models exhausted — in-character local fallback",
      },
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

  if (
    clean.includes("google earth") ||
    clean.includes("googleearth") ||
    clean.includes("earth.google") ||
    /\bopen\s+earth\b/i.test(clean) ||
    /\b3d\s+earth\b/i.test(clean)
  ) {
    const queryPart = clean
      .replace(
        /^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:open|launch|go\s*to)?\s*(?:the\s+)?(?:website\s+)?(?:google\s*earth|earth\.google\.com|googleearth)\s*(?:and|to|for)?\s*(?:search\s+for|search|find|fly\s+to|explore|visit|view)?/i,
        ""
      )
      .trim();
    if (queryPart && queryPart !== "it" && queryPart.length > 1) {
      return {
        type: 'search_website',
        siteName: 'Google Earth',
        query: queryPart,
        url: `https://earth.google.com/web/search/${encodeURIComponent(queryPart)}`,
        icon: 'Globe',
        category: 'knowledge',
      };
    }
    return {
      type: 'open_website',
      siteName: 'Google Earth',
      url: 'https://earth.google.com/web/',
      icon: 'Globe',
      category: 'knowledge',
    };
  }

  if (
    !clean.includes("google earth") &&
    !clean.includes("googleearth") &&
    !clean.includes("earth.google") &&
    !clean.includes("google maps") &&
    !clean.includes("google map") &&
    !clean.includes("google drive") &&
    !clean.includes("google docs") &&
    !clean.includes("google sheets") &&
    (clean.includes("google") || clean.includes("search web") || clean.includes("search engine"))
  ) {
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

// Helper to encode raw PCM buffer (16-bit, 24kHz, mono) into a valid browser-playable WAV
function pcmToWav(
  pcmBuffer: Buffer,
  sampleRate: number = 24000,
  numChannels: number = 1,
  bitDepth: number = 16
): Buffer {
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // Linear PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

// Text-to-Speech endpoint using Gemini TTS with smart per-model cooldown and graceful fallback
const ttsModelCooldowns: Record<string, number> = {};

app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice = "Aoede", lang } = req.body;
    if (!text || typeof text !== "string") {
      return res.json({ fallback: true, message: "No text provided" });
    }

    // Map to valid Gemini prebuilt voices: Aoede, Zephyr, Leda, Kore, Puck, Fenrir, Charon
    const validGeminiVoices = ["Aoede", "Zephyr", "Leda", "Kore", "Puck", "Fenrir", "Charon"];
    const targetVoice = validGeminiVoices.includes(voice) ? voice : "Aoede";

    // Strictly clean speech text: remove bracketed emotion tags, asterisk/parentheses stage directions,
    // and written laughter/vocal bursts so the voice model speaks cleanly without laughing in between.
    const cleanSpeechText = text
      .replace(/\[(?:emotion|expression):[^\]]+\]/gi, '')
      .replace(/\[[^\]]+\]/g, '')
      .replace(/\*[^*]+\*/g, '')
      .replace(/\([^)]+\)/g, '')
      .replace(/\b(ehehe+|hihi+|hehe+|haha+|hahaha+|ahahaha+|giggle[s]?|chuckle[s]?|gasp|sigh|lol|rofl|pffft+)\b/gi, '')
      .replace(/[*_~`#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanSpeechText) {
      return res.json({ fallback: true, message: "No speech text" });
    }

    const ai = getGenAI();

    // Prefer gemini-3.8-flash-lite-tts first (high throughput, low latency, standard quota),
    // with gemini-3.8-flash-tts as secondary.
    const ttsModels = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"];
    let base64Audio: string | undefined;

    const now = Date.now();
    for (const ttsModel of ttsModels) {
      if (now < (ttsModelCooldowns[ttsModel] || 0)) {
        continue;
      }

      try {
        const response = await ai.models.generateContent({
          model: ttsModel,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: cleanSpeechText.slice(0, 400),
                },
              ],
            },
          ],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: targetVoice },
              },
            },
          },
        });

        base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) break;
      } catch (subErr: any) {
        const subMsg = subErr?.message || String(subErr);
        const isQuota = subMsg.includes("429") || subMsg.includes("RESOURCE_EXHAUSTED") || subMsg.includes("quota");
        if (isQuota) {
          const isDaily = subMsg.includes("PerDay") || subMsg.includes("Day");
          ttsModelCooldowns[ttsModel] = Date.now() + (isDaily ? 3600_000 : 65_000);
        }
      }
    }

    if (base64Audio) {
      const rawBuf = Buffer.from(base64Audio, "base64");
      let finalAudioBase64 = base64Audio;
      if (rawBuf.length > 4 && rawBuf.toString("utf8", 0, 4) !== "RIFF") {
        const wavBuf = pcmToWav(rawBuf, 24000, 1, 16);
        finalAudioBase64 = wavBuf.toString("base64");
      }

      return res.json({
        audio: finalAudioBase64,
        mimeType: "audio/wav",
        voice: targetVoice,
      });
    }

    return res.json({ fallback: true, reason: "tts_model_fallback", cooldownMs: 300_000 });
  } catch {
    return res.json({ fallback: true, error: "TTS fallback", cooldownMs: 60_000 });
  }
});

// Audio transcription endpoint using gemini-3.5-transcribe
// Transcribes audio recorded via user microphone or uploaded audio files
app.post("/api/audio/transcribe", async (req, res) => {
  try {
    const { audioData, audio, mimeType = "audio/webm", prompt } = req.body || {};
    const base64Input = audioData || audio;

    if (!base64Input || typeof base64Input !== "string") {
      return res.status(400).json({ error: "No audio data provided", transcript: "" });
    }

    const ai = getGenAI();
    // Strip data URL scheme if present (e.g. data:audio/webm;base64,...)
    const cleanBase64 = base64Input.replace(/^data:[^;]+;base64,/, "").trim();

    if (!cleanBase64) {
      return res.status(400).json({ error: "Empty audio payload", transcript: "" });
    }

    const audioPart = {
      inlineData: {
        mimeType: mimeType || "audio/webm",
        data: cleanBase64,
      },
    };

    let transcript = "";
    let usedModel = "gemini-3.5-transcribe";

    try {
      // Primary model: gemini-3.5-transcribe for audio transcription tasks
      const response = await ai.models.generateContent({
        model: "gemini-3.5-transcribe",
        contents: {
          parts: [
            audioPart,
            {
              text:
                prompt ||
                "Transcribe this audio recording accurately. Output only the verbatim transcription text without conversational preamble, quotes, or commentary.",
            },
          ],
        },
      });
      transcript = response.text?.trim() || "";
    } catch (primaryErr: any) {
      console.warn("gemini-3.5-transcribe failed, falling back to gemini-3.8-flash:", primaryErr?.message || primaryErr);
      // Secondary fallback model: gemini-3.8-flash for multimodal audio understanding
      try {
        const fallbackResponse = await ai.models.generateContent({
          model: "gemini-3.8-flash",
          contents: {
            parts: [
              audioPart,
              { text: "Transcribe this audio recording accurately. Output only the exact spoken words." },
            ],
          },
        });
        transcript = fallbackResponse.text?.trim() || "";
        usedModel = "gemini-3.8-flash";
      } catch (fbErr: any) {
        throw primaryErr;
      }
    }

    return res.json({
      transcript,
      model: usedModel,
      success: true,
    });
  } catch (error: any) {
    console.error("Audio transcription error:", error);
    return res.status(500).json({
      error: error?.message || "Failed to transcribe audio",
      transcript: "",
    });
  }
});

// Dedicated Google Maps Grounding endpoint using gemini-3.5-flash with googleMaps tool
app.post("/api/maps/grounding", async (req, res) => {
  try {
    const { query, userLocation } = req.body || {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Query is required for Maps Grounding" });
    }

    const ai = getGenAI();
    const result = await executeMapsGroundingQuery(
      ai,
      [{ role: "user", parts: [{ text: query }] }],
      userLocation
    );

    return res.json({
      text: result.text,
      mapsGrounding: result.mapsGrounding,
      groundingChunks: result.groundingChunks,
      model: "gemini-3.5-flash",
      success: true,
    });
  } catch (err: any) {
    console.error("Maps grounding error:", err);
    return res.status(500).json({ error: err?.message || "Maps grounding failed" });
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

    // Phase 17: identical concurrent analyses are coalesced into ONE model
    // call (read-only, deterministic request → safe to share). Independent
    // requests are never affected.
    const visionStart = Date.now();
    const analysis = await visionCoalescer.run(`${hashKey(base64)}|${question ?? ""}`, async () => {
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

      let parsed: any;
      try {
        parsed = JSON.parse(text || "{}");
      } catch {
        return { fallback: true as const, reason: "malformed_model_output" };
      }
      perf.recordModelCall({
        at: Date.now(),
        model: "vision-waterfall",
        latencyMs: Date.now() - visionStart,
        ok: !parsed.fallback,
        via: "primary",
      });
      return parsed;
    });

    if (analysis?.fallback) {
      return res.json({ fallback: true, reason: analysis.reason });
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

  private pendingCount = 0;

  /** Serialize requests; the mouse layer issues one action at a time.
   *  E5 M1d: bounded queue — overflow is rejected, never silently queued. */
  run(script: string): Promise<string> {
    if (this.pendingCount >= 8) {
      return Promise.reject(new Error("PowerShell worker queue full"));
    }
    this.pendingCount += 1;
    const task = this.queue
      .then(() => this.runNow(script))
      .finally(() => {
        this.pendingCount -= 1;
      });
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

// ---- Deep research capability endpoints (additional capability, outside the
// numbered roadmap — NOT roadmap Phase 16) ----
// Server-side search + page fetch for the research subsystem: same-origin
// pattern used by every other agent backend (no browser CORS limits, no new
// dependencies — regex HTML parsing only). Everything is bounded (timeouts,
// response caps) and refuses private network targets (server-side SSRF guard).
const RESEARCH_FETCH_TIMEOUT_MS = 15_000;
const RESEARCH_MAX_BYTES = 1_500_000;
const RESEARCH_TEXT_MAX_CHARS = 40_000;

const RESEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 KrishaResearch/1.0";

function isPrivateResearchHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]" || host === "0.0.0.0") return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function decodeResearchEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code);
      return num > 0 && num < 0x10ffff ? String.fromCodePoint(num) : "";
    });
}

function stripResearchTags(html: string): string {
  return decodeResearchEntities(html.replace(/<[^>]*>/g, " "));
}

/** Resolve a DuckDuckGo result href (direct URL or /l/?uddg= redirect). */
function resolveDdgHref(href: string): string | null {
  let value = href.trim();
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (parsed.hostname.includes("duckduckgo.com")) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function duckDuckGoSearch(query: string, variant: "html" | "lite"): Promise<{ url: string; title: string; snippet: string }[]> {
  const target =
    variant === "html"
      ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      : `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(target, {
      headers: { "User-Agent": RESEARCH_UA, "Accept": "text/html" },
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const html = (await resp.text()).slice(0, RESEARCH_MAX_BYTES);

    const anchorRe =
      variant === "html"
        ? /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
        : /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe =
      variant === "html"
        ? /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
        : /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

    const anchors = [...html.matchAll(anchorRe)].slice(0, 10);
    const snippets = [...html.matchAll(snippetRe)].slice(0, 10);

    const results: { url: string; title: string; snippet: string }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < anchors.length; i++) {
      // Skip sponsored/internal links before resolving (ads, y.js redirects).
      if (/duckduckgo\.com\/y\.js|[?&]ad_domain=|ad_provider=/i.test(anchors[i][1])) continue;
      const url = resolveDdgHref(anchors[i][1]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const snippet = snippets[i] ? stripResearchTags(snippets[i][1]).replace(/\s+/g, " ").trim().slice(0, 300) : "";
      results.push({
        url,
        title: stripResearchTags(anchors[i][2]).replace(/\s+/g, " ").trim().slice(0, 200),
        snippet,
      });
      if (results.length >= 8) break;
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** HTML → bounded readable text (scripts/styles/comments stripped). */
function researchHtmlToText(html: string): string {
  return decodeResearchEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(?:p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** Bing search via its stable RSS output (bot-tolerant fallback engine). */
async function bingSearch(query: string): Promise<{ url: string; title: string; snippet: string }[]> {
  const target = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=10`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(target, {
      headers: { "User-Agent": RESEARCH_UA, "Accept": "application/rss+xml, application/xml, text/xml" },
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const xml = (await resp.text()).slice(0, RESEARCH_MAX_BYTES).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

    const results: { url: string; title: string; snippet: string }[] = [];
    const seen = new Set<string>();
    for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = item[1];
      const tag = (name: string): string => {
        const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
        return m ? m[1].trim() : "";
      };
      const url = decodeResearchEntities(tag("link"));
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      results.push({
        url,
        title: decodeResearchEntities(tag("title")).replace(/\s+/g, " ").slice(0, 200),
        snippet: stripResearchTags(decodeResearchEntities(tag("description"))).replace(/\s+/g, " ").slice(0, 300),
      });
      if (results.length >= 8) break;
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

app.post("/api/research/search", async (req, res) => {
  const query = String(req.body?.query ?? "").trim().slice(0, 300);
  if (!query) {
    return res.json({ success: false, error: "Missing search query" });
  }
  // Context Engine v1: cache-first, network-last — a still-valid cached result
  // set for this exact query is served instead of re-hitting the public
  // engines (fresh-only: stale entries are never served for research).
  const cached = getContextEngine().lookupKnowledge(`research_search:${query}`);
  if (cached.hit && Array.isArray(cached.value) && cached.value.length > 0) {
    return res.json({ success: true, engine: "cache", cached: true, results: cached.value });
  }
  try {
    // Engine waterfall: DuckDuckGo (html → lite) then Bing RSS. The public
    // engines rate-limit by IP, so a fallback keeps research working.
    const engines: { name: string; run: () => Promise<{ url: string; title: string; snippet: string }[]> }[] = [
      { name: "duckduckgo-html", run: () => duckDuckGoSearch(query, "html") },
      { name: "duckduckgo-lite", run: () => duckDuckGoSearch(query, "lite") },
      { name: "bing", run: () => bingSearch(query) },
    ];
    for (const engine of engines) {
      const results = await engine.run();
      if (results.length > 0) {
        // Post-result caching (spec §13): bounded TTL; oversized result sets
        // are silently skipped by the cache's size cap — never truncated.
        getContextEngine().cacheKnowledge(`research_search:${query}`, results, {
          ttlMs: 6 * 60 * 60_000,
          source: "research_search",
        });
        return res.json({ success: true, engine: engine.name, results });
      }
    }
    return res.json({ success: false, error: "No search results (search engines unreachable or blocked)" });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post("/api/research/fetch", async (req, res) => {
  let parsed: URL;
  try {
    parsed = assertSafeHttpUrl(String(req.body?.url ?? ""));
  } catch (err: any) {
    return res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
  if (isPrivateResearchHost(parsed.hostname)) {
    return res.json({ success: false, error: "Refusing to fetch private network addresses" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(parsed.toString(), {
      headers: { "User-Agent": RESEARCH_UA, "Accept": "text/html,text/plain" },
      signal: controller.signal,
      redirect: "follow",
    });
    const contentType = resp.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml|application\/json/i.test(contentType)) {
      return res.json({ success: false, error: `Unsupported content type "${contentType.split(";")[0] || "unknown"}" — only readable pages can be inspected` });
    }
    if (!resp.ok) {
      return res.json({ success: false, error: `Source responded with HTTP ${resp.status}` });
    }
    const raw = (await resp.text()).slice(0, RESEARCH_MAX_BYTES);
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeResearchEntities(titleMatch[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const isHtml = /text\/html|application\/xhtml/i.test(contentType);
    const text = (isHtml ? researchHtmlToText(raw) : decodeResearchEntities(raw).replace(/[ \t]+/g, " ")).slice(0, RESEARCH_TEXT_MAX_CHARS);
    if (text.trim().length < 40) {
      return res.json({ success: false, error: "Page contained no readable text" });
    }
    res.json({ success: true, url: resp.url || parsed.toString(), title, text });
  } catch (err: any) {
    const reason = controller.signal.aborted ? "Source fetch timed out" : String(err?.message || err);
    res.json({ success: false, error: reason.slice(0, 300) });
  } finally {
    clearTimeout(timer);
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

// ---- E5 M1: server-authoritative safety status + activation ----
// There is deliberately NO HTTP deactivation endpoint: deactivation runs
// exclusively through the recovery CLI + named pipe + credential.
app.get("/api/safety/stop", (req, res) => {
  res.json({ success: true, result: stopSnapshot() });
});
app.post("/api/safety/stop/activate", (req, res) => {
  if (!rateLimit("stop-activate", 5, 60_000)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }
  try {
    const result = activateStop(String(req.body?.reason ?? "operator requested emergency stop"), "http");
    res.json({ success: true, result: { ...result, snapshot: stopSnapshot() } });
  } catch (err) {
    res.status(409).json({ success: false, error: String((err as Error)?.message || err) });
  }
});

// ---- E5 H4: read-only runtime integrity status (no authorization change) ----
app.get("/api/integrity/status", (req, res) => {
  const report = lastIntegrityReport();
  if (!report) {
    res.json({ success: false, error: "integrity monitoring has not evaluated yet", intervalMs: configuredIntervalMs() });
    return;
  }
  res.json({ success: true, result: report, intervalMs: configuredIntervalMs() });
});

// ---- E5 M3: rollback planning + operator-bound challenge lifecycle ----
// The model may REQUEST a plan; approval happens ONLY through the Krisha UI
// affordance (operator click → /api/rollback/approve). Plans and challenge
// bindings live server-side; clients pass opaque ids only.
function rollbackResult(res: import("express").Response, fn: () => unknown): void {
  try {
    res.json({ success: true, result: fn() });
  } catch (err) {
    res.json({ success: false, error: String((err as Error)?.message || err) });
  }
}
app.get("/api/rollback/pending", (req, res) => rollbackResult(res, () => rollback.pendingChallenges()));
app.post("/api/rollback/plan", (req, res) => rollbackResult(res, () => rollback.planRollback(String(req.body?.opId ?? ""))));
app.post("/api/rollback/approve", (req, res) => rollbackResult(res, () => rollback.approveChallenge(String(req.body?.challengeId ?? ""))));
app.post("/api/rollback/decline", (req, res) => rollbackResult(res, () => rollback.declineChallenge(String(req.body?.challengeId ?? ""))));
app.post("/api/rollback/execute", (req, res) => rollbackResult(res, () => rollback.executeRollback({
  opId: String(req.body?.opId ?? ""),
  planHash: String(req.body?.planHash ?? ""),
  challengeId: String(req.body?.challengeId ?? ""),
})));

// ---- E5 M3: E7 quarantine (operator release by exact path declaration) ----
app.get("/api/quarantine/list", (req, res) => rollbackResult(res, () => quarantine.listQuarantine()));
// E5 H1/H2 — explicit, audited integrity scan. Read-only: it authorizes nothing,
// releases nothing, deletes nothing — orphaned artifacts stay locked and are
// reported for operator review. H2: bounded pagination with digest-bound
// continuation (an artifact-set change fails the continuation closed).
app.post("/api/quarantine/scan", (req, res) => rollbackResult(res, () => quarantine.auditedQuarantineScan({
  continuation: req.body?.continuation && typeof req.body.continuation === 'object'
    ? { after: req.body.continuation.after === undefined ? undefined : String(req.body.continuation.after), digest: req.body.continuation.digest === undefined ? undefined : String(req.body.continuation.digest) }
    : undefined,
  limit: Number.isFinite(Number(req.body?.limit)) && Number(req.body?.limit) > 0 ? Number(req.body.limit) : undefined,
})));
app.post("/api/quarantine/release", (req, res) => rollbackResult(res, () => {
  const declared = Array.isArray(req.body?.declaredPaths) ? req.body.declaredPaths.map((p: unknown) => String(p)) : [];
  return quarantine.releaseQuarantine(declared);
}));

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

  const httpServer = app.listen(PORT, BIND, () => {
    console.log(`Krisha server running on http://${BIND}:${PORT}${BIND === "127.0.0.1" ? " (loopback — E5 D1)" : " (LAN-EXPOSED — explicit KRISHA_BIND override)"}`);
  });
  // E5 H4 — server-owned runtime integrity monitoring: bounded, unref'd
  // periodic evaluation (default 60 s, KRISHA_INTEGRITY_INTERVAL_MS to
  // configure) + read-only status endpoint below. Monitoring reports; it
  // never repairs, releases, or changes the stop state.
  startIntegrityMonitor();
  console.log(`[E5] integrity monitoring active (interval ${configuredIntervalMs()} ms)`);
  // E5 M1d — bounded request lifetimes.
  httpServer.requestTimeout = 60_000;
  httpServer.headersTimeout = 65_000;
}

startServer();

