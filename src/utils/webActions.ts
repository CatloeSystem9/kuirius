import { WebAction } from '../types';

export interface WebPlatformInfo {
  id: string;
  name: string;
  baseUrl: string;
  searchUrl: (query: string) => string;
  icon: string;
  category: 'video' | 'search' | 'knowledge' | 'social' | 'code' | 'music' | 'shopping' | 'streaming';
  color: string;
  aliases: string[];
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
    aliases: ['youtube', 'yt', 'you tube', 'youtube.com', 'youtub'],
  },
  {
    id: 'google',
    name: 'Google',
    baseUrl: 'https://www.google.com',
    searchUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    icon: 'Search',
    category: 'search',
    color: '#3b82f6',
    aliases: ['google', 'google.com', 'goog', 'google search'],
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    baseUrl: 'https://en.wikipedia.org',
    searchUrl: (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
    icon: 'BookOpen',
    category: 'knowledge',
    color: '#94a3b8',
    aliases: ['wikipedia', 'wiki', 'wikipedia.org', 'wikipidia'],
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
  },
  {
    id: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.com',
    searchUrl: (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
    icon: 'Github',
    category: 'code',
    color: '#a855f7',
    aliases: ['github', 'git hub', 'github.com', 'repo', 'repositories'],
  },
  {
    id: 'spotify',
    name: 'Spotify',
    baseUrl: 'https://open.spotify.com',
    searchUrl: (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}`,
    icon: 'Music',
    category: 'music',
    color: '#22c55e',
    aliases: ['spotify', 'spotify.com', 'open.spotify.com'],
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
  },
  {
    id: 'amazon',
    name: 'Amazon',
    baseUrl: 'https://www.amazon.com',
    searchUrl: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
    icon: 'ShoppingBag',
    category: 'shopping',
    color: '#f59e0b',
    aliases: ['amazon', 'amazon.com'],
  },
  {
    id: 'netflix',
    name: 'Netflix',
    baseUrl: 'https://www.netflix.com',
    searchUrl: (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}`,
    icon: 'Film',
    category: 'streaming',
    color: '#e11d48',
    aliases: ['netflix', 'netflix.com'],
  },
  {
    id: 'pinterest',
    name: 'Pinterest',
    baseUrl: 'https://www.pinterest.com',
    searchUrl: (q) => `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}`,
    icon: 'Image',
    category: 'social',
    color: '#f43f5e',
    aliases: ['pinterest', 'pinterest.com'],
  },
  {
    id: 'twitch',
    name: 'Twitch',
    baseUrl: 'https://www.twitch.tv',
    searchUrl: (q) => `https://www.twitch.tv/search?term=${encodeURIComponent(q)}`,
    icon: 'Tv',
    category: 'streaming',
    color: '#9333ea',
    aliases: ['twitch', 'twitch.tv'],
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
  },
];

/**
 * Intelligent detector and parser for website opening and search intent.
 */
export function detectAndParseWebAction(text: string): WebAction | null {
  const clean = text.trim();
  if (!clean) return null;

  // 1. Direct URL detection (e.g. "https://example.com" or "open github.com")
  const urlMatch = clean.match(/(?:open|go to|visit|launch)?\s*(https?:\/\/[^\s]+)/i);
  if (urlMatch) {
    const rawUrl = urlMatch[1];
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.replace(/^www\./, '');
      return {
        type: 'open_website',
        siteName: host.charAt(0).toUpperCase() + host.slice(1),
        url: rawUrl,
        icon: 'Globe',
      };
    } catch {
      // ignore
    }
  }

  // 2. Domain pattern e.g. "open nytimes.com", "go to discord.com", "open twitch.tv"
  const domainMatch = clean.match(/\b(?:open|go to|visit|launch)\s+([a-zA-Z0-9-]+\.(?:com|org|io|net|tv|dev|ai|app|co|me|gg))\b/i);
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

  // 3. Check for specific platform searches or opens
  for (const platform of SUPPORTED_PLATFORMS) {
    for (const alias of platform.aliases) {
      const aliasPattern = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Patterns:
      // A) "search (for) <QUERY> on/in <PLATFORM>" or "find <QUERY> on <PLATFORM>" or "look up <QUERY> on <PLATFORM>"
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

      // B) "<PLATFORM> search (for) <QUERY>" or "<PLATFORM> find <QUERY>"
      const platformSearchRegex = new RegExp(
        `\\b${aliasPattern}\\s+(?:search|search\\s+for|find|lookup|look\\s*up)\\s+(.+)$`,
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

      // C) "open <PLATFORM> and search (for) <QUERY>" or "open <PLATFORM> to search <QUERY>" or "open <PLATFORM> for <QUERY>"
      const openAndSearchRegex = new RegExp(
        `(?:open|launch|go\\s*to)\\s+${aliasPattern}\\s+(?:and|to|for)\\s+(?:search\\s+(?:for\\s+)?|find\\s+|watch\\s+|listen\\s+to\\s+|look\\s*up\\s+)?(.+)$`,
        'i'
      );
      const m3 = clean.match(openAndSearchRegex);
      if (m3 && m3[1].trim()) {
        const query = m3[1].trim().replace(/^['"]|['"]$/g, '');
        // If query is just "it" or "something", treat as open or search
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

      // D) Simple open command: "open <PLATFORM>", "go to <PLATFORM>", "launch <PLATFORM>", "<PLATFORM>"
      const openOnlyRegex = new RegExp(
        `^(?:please\\s+)?(?:open|launch|go\\s*to|visit|show\\s+me|take\\s+me\\s+to)?\\s*${aliasPattern}\\s*(?:website|app|page|site)?$`,
        'i'
      );
      if (openOnlyRegex.test(clean)) {
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

  // 4. Generic search command without specified platform (e.g. "search for lofi beats", "search cute kittens", "look up quantum computing")
  const genericSearchMatch = clean.match(/^(?:please\s+)?(?:search|look\s*up|find|google)\s+(?:for\s+)?(.+)$/i);
  if (genericSearchMatch && genericSearchMatch[1].trim()) {
    const rawQuery = genericSearchMatch[1].trim();
    // Exclude if it looks like a dance or greeting command
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
 * Safely triggers window.open in browser with fallback
 */
export function openExternalUrl(url: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
    return Boolean(newWindow);
  } catch (e) {
    console.warn('Failed to open window directly:', e);
    return false;
  }
}
