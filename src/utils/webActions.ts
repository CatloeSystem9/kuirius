import { WebAction } from '../types';

export interface WebPlatformInfo {
  id: string;
  name: string;
  baseUrl: string;
  searchUrl: (query: string) => string;
  icon: string;
  category: 'video' | 'search' | 'knowledge' | 'social' | 'code' | 'music' | 'shopping' | 'streaming' | 'ai' | 'productivity';
  color: string;
  aliases: string[];
  description: string;
}

export const SUPPORTED_PLATFORMS: WebPlatformInfo[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    baseUrl: 'https://www.youtube.com',
    searchUrl: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
    icon: 'Youtube',
    category: 'video',
    color: '#ef4444',
    aliases: ['youtube', 'yt', 'you tube', 'youtube.com', 'youtub', 'videos', 'video'],
    description: 'Watch videos, music, streams, and trailers',
  },
  {
    id: 'google',
    name: 'Google',
    baseUrl: 'https://www.google.com',
    searchUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    icon: 'Search',
    category: 'search',
    color: '#3b82f6',
    aliases: ['google', 'google.com', 'goog', 'google search', 'web search', 'search engine'],
    description: 'Search the web for anything',
  },
  {
    id: 'spotify',
    name: 'Spotify',
    baseUrl: 'https://open.spotify.com',
    searchUrl: (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}`,
    icon: 'Music',
    category: 'music',
    color: '#22c55e',
    aliases: ['spotify', 'spotify.com', 'open.spotify.com', 'music', 'songs'],
    description: 'Stream music, playlists, and podcasts',
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    baseUrl: 'https://en.wikipedia.org',
    searchUrl: (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
    icon: 'BookOpen',
    category: 'knowledge',
    color: '#94a3b8',
    aliases: ['wikipedia', 'wiki', 'wikipedia.org', 'wikipidia', 'encyclopedia'],
    description: 'Free online encyclopedia and knowledge',
  },
  {
    id: 'reddit',
    name: 'Reddit',
    baseUrl: 'https://www.reddit.com',
    searchUrl: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
    icon: 'Flame',
    category: 'social',
    color: '#f97316',
    aliases: ['reddit', 'reddit.com', 'subreddit', 'subreddits'],
    description: 'Community discussions and trending topics',
  },
  {
    id: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.com',
    searchUrl: (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
    icon: 'Github',
    category: 'code',
    color: '#a855f7',
    aliases: ['github', 'git hub', 'github.com', 'repo', 'repositories', 'code'],
    description: 'Software development and open source repositories',
  },
  {
    id: 'netflix',
    name: 'Netflix',
    baseUrl: 'https://www.netflix.com',
    searchUrl: (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}`,
    icon: 'Film',
    category: 'streaming',
    color: '#e11d48',
    aliases: ['netflix', 'netflix.com', 'movies', 'shows'],
    description: 'Watch TV shows and movies online',
  },
  {
    id: 'twitch',
    name: 'Twitch',
    baseUrl: 'https://www.twitch.tv',
    searchUrl: (q) => `https://www.twitch.tv/search?term=${encodeURIComponent(q)}`,
    icon: 'Tv',
    category: 'streaming',
    color: '#9333ea',
    aliases: ['twitch', 'twitch.tv', 'livestream', 'stream'],
    description: 'Live gaming and entertainment streams',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    baseUrl: 'https://chatgpt.com',
    searchUrl: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
    icon: 'Sparkles',
    category: 'ai',
    color: '#10b981',
    aliases: ['chatgpt', 'chat gpt', 'openai', 'chatgpt.com'],
    description: 'AI conversational assistant and research',
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    baseUrl: 'https://x.com',
    searchUrl: (q) => `https://x.com/search?q=${encodeURIComponent(q)}`,
    icon: 'Twitter',
    category: 'social',
    color: '#38bdf8',
    aliases: ['twitter', 'twitter.com', 'x', 'x.com', 'tweets', 'tweet'],
    description: 'Breaking news, updates, and social posts',
  },
  {
    id: 'amazon',
    name: 'Amazon',
    baseUrl: 'https://www.amazon.com',
    searchUrl: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
    icon: 'ShoppingBag',
    category: 'shopping',
    color: '#f59e0b',
    aliases: ['amazon', 'amazon.com', 'shopping', 'store'],
    description: 'Online shopping for electronics, books, and goods',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    baseUrl: 'https://www.instagram.com',
    searchUrl: (q) => `https://www.instagram.com/explore/tags/${encodeURIComponent(q.replace(/\s+/g, ''))}`,
    icon: 'Camera',
    category: 'social',
    color: '#ec4899',
    aliases: ['instagram', 'instagram.com', 'insta', 'ig'],
    description: 'Photos, reels, and stories from creators',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    baseUrl: 'https://duckduckgo.com',
    searchUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    icon: 'Search',
    category: 'search',
    color: '#ea580c',
    aliases: ['duckduckgo', 'duck duck go', 'ddg', 'duckduckgo.com'],
    description: 'Privacy-focused web search',
  },
  {
    id: 'stackoverflow',
    name: 'Stack Overflow',
    baseUrl: 'https://stackoverflow.com',
    searchUrl: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
    icon: 'Code2',
    category: 'code',
    color: '#f97316',
    aliases: ['stackoverflow', 'stack overflow', 'stackoverflow.com'],
    description: 'Developer Q&A and coding solutions',
  },
];

/**
 * Intelligent detector and parser for website opening and search intent.
 */
export function detectAndParseWebAction(text: string): WebAction | null {
  const clean = text.trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();

  // 1. Direct URL detection (e.g. "https://example.com" or "open https://youtube.com")
  const urlMatch = clean.match(/(?:open|go to|visit|launch)?\s*(https?:\/\/[^\s]+)/i);
  if (urlMatch) {
    const rawUrl = urlMatch[1];
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.replace(/^www\./, '');
      const siteName = host.split('.')[0];
      return {
        type: 'open_website',
        siteName: siteName.charAt(0).toUpperCase() + siteName.slice(1),
        url: rawUrl,
        icon: 'Globe',
      };
    } catch {
      // ignore
    }
  }

  // 2. Domain pattern e.g. "open youtube.com", "go to discord.com", "open twitch.tv"
  const domainMatch = clean.match(/\b(?:open|go to|visit|launch|check|access)\s+([a-zA-Z0-9-]+\.(?:com|org|io|net|tv|dev|ai|app|co|me|gg|in|gov|edu))\b/i);
  if (domainMatch) {
    const domain = domainMatch[1].toLowerCase();
    const siteName = domain.replace(/\.[a-z]+$/, '');
    return {
      type: 'open_website',
      siteName: siteName.charAt(0).toUpperCase() + siteName.slice(1),
      url: `https://${domain}`,
      icon: 'Globe',
    };
  }

  // 3. Questions about inability to open websites or generic requests for "websites like youtube"
  // e.g. "she is unable to open websites like youtube or any other thing", "open websites like youtube", "open youtube or anything"
  if (
    lower.includes('unable to open website') ||
    lower.includes('unable to open youtube') ||
    lower.includes("can't open website") ||
    lower.includes("can't open youtube") ||
    lower.includes('cannot open website') ||
    lower.includes('cannot open youtube') ||
    lower.includes('websites like youtube') ||
    lower.includes('website like youtube') ||
    lower.includes('youtube or any other thing') ||
    lower.includes('youtube or anything')
  ) {
    const yt = SUPPORTED_PLATFORMS.find((p) => p.id === 'youtube')!;
    return {
      type: 'open_website',
      siteName: yt.name,
      url: yt.baseUrl,
      icon: yt.icon,
      category: yt.category,
    };
  }

  // 4. Check for platform-specific intents (YouTube, Google, Spotify, etc.)
  for (const platform of SUPPORTED_PLATFORMS) {
    for (const alias of platform.aliases) {
      const aliasPattern = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // A) "search (for) <QUERY> on/in <PLATFORM>" or "play/watch <QUERY> on <PLATFORM>"
      const searchOnRegex = new RegExp(
        `(?:search|find|look\\s*up|check|explore|play|listen\\s*to|watch)\\s+(?:for\\s+)?(.+?)\\s+(?:on|in|using|at)\\s+${aliasPattern}\\b`,
        'i'
      );
      const m1 = clean.match(searchOnRegex);
      if (m1 && m1[1].trim()) {
        const query = m1[1].trim().replace(/^['"]|['"]$/g, '');
        return {
          type: 'search_website',
          siteName: platform.name,
          query,
          url: platform.searchUrl(query),
          icon: platform.icon,
          category: platform.category,
        };
      }

      // B) "<PLATFORM> search (for) <QUERY>" or "<PLATFORM> find/play <QUERY>"
      const platformSearchRegex = new RegExp(
        `\\b${aliasPattern}\\s+(?:search|search\\s+for|find|lookup|look\\s*up|play|watch)\\s+(.+)$`,
        'i'
      );
      const m2 = clean.match(platformSearchRegex);
      if (m2 && m2[1].trim()) {
        const query = m2[1].trim().replace(/^['"]|['"]$/g, '');
        return {
          type: 'search_website',
          siteName: platform.name,
          query,
          url: platform.searchUrl(query),
          icon: platform.icon,
          category: platform.category,
        };
      }

      // C) "open <PLATFORM> and search/play/watch (for) <QUERY>"
      const openAndSearchRegex = new RegExp(
        `(?:open|launch|go\\s*to|start)\\s+(?:up\\s+)?(?:the\\s+)?${aliasPattern}\\s+(?:and|to|for)\\s+(?:search\\s+(?:for\\s+)?|find\\s+|watch\\s+|listen\\s+to\\s+|play\\s+|look\\s*up\\s+)?(.+)$`,
        'i'
      );
      const m3 = clean.match(openAndSearchRegex);
      if (m3 && m3[1].trim()) {
        const query = m3[1].trim().replace(/^['"]|['"]$/g, '');
        if (query !== 'it' && query.length > 1) {
          return {
            type: 'search_website',
            siteName: platform.name,
            query,
            url: platform.searchUrl(query),
            icon: platform.icon,
            category: platform.category,
          };
        }
      }

      // D) Natural open command anywhere in prompt!
      // e.g. "open youtube", "can you open youtube", "open up youtube", "please open youtube for me",
      // "krisha open youtube", "open the website youtube", "go to youtube", "visit youtube"
      const openCmdRegex = new RegExp(
        `\\b(?:open|launch|go\\s*to|visit|show\\s+me|take\\s+me\\s+to|start|access)\\s+(?:up\\s+)?(?:the\\s+)?(?:website\\s+|site\\s+|app\\s+|page\\s+)?${aliasPattern}\\b`,
        'i'
      );
      if (openCmdRegex.test(clean)) {
        return {
          type: 'open_website',
          siteName: platform.name,
          url: platform.baseUrl,
          icon: platform.icon,
          category: platform.category,
        };
      }

      // E) Inverted "youtube open" or "youtube launch"
      const invertedRegex = new RegExp(`\\b${aliasPattern}\\s+(?:open|launch|start|site|website)\\b`, 'i');
      if (invertedRegex.test(clean)) {
        return {
          type: 'open_website',
          siteName: platform.name,
          url: platform.baseUrl,
          icon: platform.icon,
          category: platform.category,
        };
      }
    }
  }

  // 5. Generic "open website" or "open browser" command
  if (/\b(?:open|launch|go\s*to)\s+(?:a\s+)?(?:website|browser|web|the\s+internet|sites)\b/i.test(clean)) {
    const yt = SUPPORTED_PLATFORMS.find((p) => p.id === 'youtube')!;
    return {
      type: 'open_website',
      siteName: yt.name,
      url: yt.baseUrl,
      icon: yt.icon,
      category: yt.category,
    };
  }

  // 6. Generic search command without specified platform (e.g. "search for lofi beats", "search cute kittens")
  const genericSearchMatch = clean.match(/^(?:please\s+)?(?:search|look\s*up|find|google)\s+(?:for\s+)?(.+)$/i);
  if (genericSearchMatch && genericSearchMatch[1].trim()) {
    const rawQuery = genericSearchMatch[1].trim();
    if (!/^(dancing|dance|me|different directions|around|quietly)/i.test(rawQuery)) {
      const query = rawQuery.replace(/^['"]|['"]$/g, '');
      const isVideoQuery = /\b(video|song|music|trailer|clip|gameplay|stream|vlog|anime episode|mv|ost)\b/i.test(query);

      const targetPlatform = isVideoQuery
        ? SUPPORTED_PLATFORMS.find((p) => p.id === 'youtube')!
        : SUPPORTED_PLATFORMS.find((p) => p.id === 'google')!;

      return {
        type: 'search_website',
        siteName: targetPlatform.name,
        query,
        url: targetPlatform.searchUrl(query),
        icon: targetPlatform.icon,
        category: targetPlatform.category,
      };
    }
  }

  return null;
}

/**
 * Safely triggers opening an external URL in browser with multiple fallbacks
 */
export function openExternalUrl(url: string): { success: boolean; error?: string } {
  if (typeof window === 'undefined') return { success: false, error: 'Window not available' };

  let opened = false;
  try {
    // Attempt 1: Direct window.open with features
    const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
    if (newWindow) {
      opened = true;
    }
  } catch (e: any) {
    console.warn('[WebActions] Direct window.open failed:', e);
  }

  // Attempt 2: Synthetic click on real <a> anchor tag
  try {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    opened = true;
  } catch (e: any) {
    console.warn('[WebActions] Anchor click failed:', e);
  }

  return { success: opened };
}
