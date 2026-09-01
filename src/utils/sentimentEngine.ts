import { AvatarExpression, EmotionAnalysis } from '../types';

interface KeywordRule {
  patterns: RegExp[];
  expression: AvatarExpression;
  intensity: number;
  gesture: EmotionAnalysis['gesture'];
  blushLevel: number;
  sentiment: EmotionAnalysis['sentiment'];
}

// Comprehensive sentiment rules mapping keywords and subtext to nuanced expressions & gestures
const RULES: KeywordRule[] = [
  // 1. Teasing, Banter, Mischief -> Playful Smirk
  {
    patterns: [
      /\b(teas(e|ing)|silly|goof(y|ball)|dummy|baka|smug|wink|joke|joking|caught you|you wish|bet you|whatever you say|lol|haha|lmao|hehe|mischief|brat|trouble)\b/i,
      /\b(don't get cocky|as if|in your dreams|playing hard to get)\b/i,
      /[;~😏😜😋]/,
    ],
    expression: 'playful_smirk',
    intensity: 0.85,
    gesture: 'tilt_right',
    blushLevel: 0.25,
    sentiment: 'teasing',
  },

  // 2. Flustered, Compliments, Romantic Vulnerability -> Flustered Blush
  {
    patterns: [
      /\b(blush|cute|cutie|pretty|beautiful|gorgeous|stunning|attractive|kiss|marry|darling|sweetheart|my girl|girlfriend|adore|fall for you|makes my heart|so precious)\b/i,
      /\b(you look amazing|love you|you're lovely|you're the prettiest)\b/i,
      /[😳🥰🥺❤️]/,
    ],
    expression: 'flustered_blush',
    intensity: 0.9,
    gesture: 'shyness',
    blushLevel: 0.8,
    sentiment: 'affectionate',
  },

  // 3. Supportive, Comforting, Gentle Warmth -> Gentle Smile
  {
    patterns: [
      /\b(comfort|gentle|warm|hug|holding you|safe with you|thank you|appreciate|grateful|kind of you|long day|exhausted|tired|stress(ed)?|rough day|hard time|here for you|proud of you|rest|relax|sleep well|goodnight)\b/i,
      /\b(you did well|everything will be okay|take care|calm down|peaceful)\b/i,
      /[😌✨🌙]/,
    ],
    expression: 'gentle_smile',
    intensity: 0.8,
    gesture: 'subtle_nod',
    blushLevel: 0.35,
    sentiment: 'comforting',
  },

  // 4. Jealousy, Playful Indignation, Sulk -> Pout Jealous
  {
    patterns: [
      /\b(other (girl|boy|person|woman|man)|ex|someone else|ignored me|left me|forgot about me|hmph|busy with another|date with|mean|rude|cheater|replace me|jealous)\b/i,
      /\b(who was that|why didn't you text|too busy for me|don't care about me)\b/i,
      /[😤😒pout]/i,
    ],
    expression: 'pout_jealous',
    intensity: 0.85,
    gesture: 'glance_away',
    blushLevel: 0.45,
    sentiment: 'jealous',
  },

  // 5. Curiosity, Inquisitive, Surprised -> Curious Tilt
  {
    patterns: [
      /\b(really\?|tell me (more|about)|how come|what if|guess what|did you know|secret|wondering|curious|fascinating|wait what|explain|what happened|who|where|why)\b/i,
      /\b(seriously\?|no way|is that true\?|tell me everything)\b/i,
      /[🤔❓⁉️]/,
    ],
    expression: 'curious_tilt',
    intensity: 0.75,
    gesture: 'tilt_left',
    blushLevel: 0.1,
    sentiment: 'curious',
  },

  // 6. Delighted, Celebratory, Joyful -> Happy Sparkle
  {
    patterns: [
      /\b(yay|awesome|incredible|fantastic|wonderful|celebrat(e|ing)|congrat(s|ulations)|won|passed|promoted|success|best news|so happy|thrilled|cheers)\b/i,
      /[🎉🥳😁🌟💃]/,
    ],
    expression: 'happy_sparkle',
    intensity: 0.95,
    gesture: 'perk_up',
    blushLevel: 0.5,
    sentiment: 'positive',
  },

  // 7. Thoughtful, Nostalgic, Philosophical -> Thoughtful Gaze
  {
    patterns: [
      /\b(remember (when|that)|long ago|in the past|back then|future|destiny|stars|universe|meaning|philosophy|life|deep down|sometimes I think|memories|nostalgia)\b/i,
      /\b(what does it mean|looking back|someday)\b/i,
    ],
    expression: 'thoughtful_gaze',
    intensity: 0.7,
    gesture: 'subtle_nod',
    blushLevel: 0.15,
    sentiment: 'reflective',
  },
];

/**
 * Real-time client-side sentiment analysis for text (instant feedback while user types or reads)
 */
export function analyzeSentimentAndKeywords(text: string): EmotionAnalysis {
  if (!text || text.trim().length === 0) {
    return {
      expression: 'gentle_smile',
      intensity: 0.4,
      gesture: 'none',
      blushLevel: 0.15,
      sentiment: 'neutral',
    };
  }

  // Check matching rules
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return {
          expression: rule.expression,
          intensity: rule.intensity,
          gesture: rule.gesture,
          blushLevel: rule.blushLevel,
          sentiment: rule.sentiment,
        };
      }
    }
  }

  // Fallback heuristic based on length and punctuation
  if (text.includes('?')) {
    return {
      expression: 'curious_tilt',
      intensity: 0.6,
      gesture: 'tilt_left',
      blushLevel: 0.15,
      sentiment: 'curious',
    };
  }

  if (text.includes('!')) {
    return {
      expression: 'happy_sparkle',
      intensity: 0.7,
      gesture: 'perk_up',
      blushLevel: 0.35,
      sentiment: 'positive',
    };
  }

  return {
    expression: 'gentle_smile',
    intensity: 0.5,
    gesture: 'none',
    blushLevel: 0.2,
    sentiment: 'positive',
  };
}

/**
 * Helper to normalize any legacy expression name to the modern nuanced expression
 */
export function normalizeExpression(exp: string | undefined): AvatarExpression {
  if (!exp) return 'gentle_smile';
  const lower = exp.toLowerCase();
  if (lower === 'playful' || lower.includes('smirk') || lower.includes('playful')) {
    return 'playful_smirk';
  }
  if (lower === 'pout' || lower.includes('jealous') || lower.includes('sulk')) {
    return 'pout_jealous';
  }
  if (lower === 'happy' || lower.includes('sparkle') || lower.includes('joy')) {
    return 'happy_sparkle';
  }
  if (lower === 'listening' || lower.includes('attentive')) {
    return 'listening_attentive';
  }
  if (lower === 'curious' || lower.includes('tilt')) {
    return 'curious_tilt';
  }
  if (lower === 'blush' || lower.includes('flustered') || lower.includes('shy')) {
    return 'flustered_blush';
  }
  if (lower === 'thoughtful' || lower.includes('gaze') || lower.includes('reflective')) {
    return 'thoughtful_gaze';
  }
  if (lower === 'warm' || lower.includes('smile') || lower.includes('gentle')) {
    return 'gentle_smile';
  }
  return 'neutral';
}
