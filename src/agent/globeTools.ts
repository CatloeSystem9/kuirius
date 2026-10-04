/**
 * 3D Earth / Geospatial Agent Tools.
 * Enables Krisha to programmatically open the 3D Earth, fly to cities/regions,
 * switch layers, and return to full Earth view.
 */
import type { AgentTool, ToolResult } from './types';
import { ok, fail } from './types';
import type { GlobeAction } from '../types';
import { geocodeAddress } from '../utils/locationService';
import { OPEN_METEO_WIND_QUERY, directionToCardinal } from '../components/globe/environment/envService';

const GLOBE_VERIFICATION = {
  strategy: 'self_reported' as const,
  description: 'Reports declarative UI effects applied to the 3D Earth viewport.',
};

export function createGlobeTools(): AgentTool[] {
  const showGlobeTool: AgentTool = {
    name: 'globe.show',
    description:
      "Open Krisha's interactive 3D Earth globe. Optionally pass a target city, country, or coordinates to fly to.",
    category: 'location',
    riskLevel: 'safe',
    cost: 'free',
    capabilities: ['globe.show', 'globe.open', 'earth.explore'],
    inputSchema: {
      optional: ['locationName', 'lat', 'lng', 'zoom'],
      types: {
        locationName: 'string',
        lat: 'number',
        lng: 'number',
        zoom: 'number',
      },
    },
    verification: GLOBE_VERIFICATION,
    async execute(input): Promise<ToolResult> {
      let lat = typeof input.lat === 'number' ? input.lat : undefined;
      let lng = typeof input.lng === 'number' ? input.lng : undefined;
      const locationName = typeof input.locationName === 'string' ? input.locationName.trim() : undefined;
      const zoom = typeof input.zoom === 'number' ? input.zoom : undefined;

      if ((lat === undefined || lng === undefined) && locationName) {
        try {
          const geocoded = await geocodeAddress(locationName);
          if (geocoded) {
            lat = geocoded.lat;
            lng = geocoded.lng;
          }
        } catch (err) {
          console.warn('Geocoding error in globe.show:', err);
        }
      }

      const globeAction: GlobeAction = {
        type: 'fly_to',
        lat,
        lng,
        zoom,
        locationName,
      };

      return ok({
        output: {
          opened: true,
          locationName,
          lat,
          lng,
        },
        ui: [
          { kind: 'open_modal', modal: 'globe' },
          { kind: 'globe_action', action: globeAction },
          { kind: 'pose', pose: 'waving_greeting' },
        ],
      });
    },
  };

  const flyToTool: AgentTool = {
    name: 'globe.fly_to',
    description:
      'Smoothly navigate and fly the 3D Earth camera to a specified city, country, or coordinate point.',
    category: 'location',
    riskLevel: 'safe',
    cost: 'free',
    capabilities: ['globe.fly_to', 'globe.navigate', 'earth.goto'],
    inputSchema: {
      optional: ['locationName', 'lat', 'lng', 'zoom'],
      types: {
        locationName: 'string',
        lat: 'number',
        lng: 'number',
        zoom: 'number',
      },
    },
    verification: GLOBE_VERIFICATION,
    async execute(input): Promise<ToolResult> {
      let lat = typeof input.lat === 'number' ? input.lat : undefined;
      let lng = typeof input.lng === 'number' ? input.lng : undefined;
      const locationName = typeof input.locationName === 'string' ? input.locationName.trim() : undefined;
      const zoom = typeof input.zoom === 'number' ? input.zoom : undefined;

      if (!locationName && (lat === undefined || lng === undefined)) {
        return fail('Either locationName or both lat and lng must be provided to flyTo');
      }

      if ((lat === undefined || lng === undefined) && locationName) {
        try {
          const geocoded = await geocodeAddress(locationName);
          if (geocoded) {
            lat = geocoded.lat;
            lng = geocoded.lng;
          } else {
            return fail(`Could not resolve coordinates for "${locationName}".`);
          }
        } catch (err: any) {
          return fail(`Geocoding error: ${err?.message || err}`);
        }
      }

      const globeAction: GlobeAction = {
        type: 'fly_to',
        lat,
        lng,
        zoom,
        locationName,
      };

      return ok({
        output: {
          target: locationName || `${lat}, ${lng}`,
          lat,
          lng,
        },
        ui: [
          { kind: 'open_modal', modal: 'globe' },
          { kind: 'globe_action', action: globeAction },
        ],
      });
    },
  };

  const setLayerTool: AgentTool = {
    name: 'globe.set_layer',
    description:
      "Switch the 3D globe base imagery layer. Allowed layers: 'satellite', 'dark', 'standard', 'terrain'.",
    category: 'location',
    riskLevel: 'safe',
    cost: 'free',
    capabilities: ['globe.set_layer', 'earth.layer'],
    inputSchema: {
      required: ['layer'],
      types: { layer: 'string' },
    },
    verification: GLOBE_VERIFICATION,
    async execute(input): Promise<ToolResult> {
      const raw = String(input.layer || '').toLowerCase();
      let layer: 'satellite' | 'dark' | 'standard' | 'terrain' = 'satellite';
      if (raw.includes('dark') || raw.includes('night')) layer = 'dark';
      else if (raw.includes('terrain') || raw.includes('topo')) layer = 'terrain';
      else if (raw.includes('standard') || raw.includes('day') || raw.includes('map')) layer = 'standard';
      else if (raw.includes('sat')) layer = 'satellite';

      return ok({
        output: { layer },
        ui: [
          { kind: 'open_modal', modal: 'globe' },
          { kind: 'globe_action', action: { type: 'set_layer', layer } },
        ],
      });
    },
  };

  const resetViewTool: AgentTool = {
    name: 'globe.reset_view',
    description: 'Return the 3D Earth camera to the full planet orbital overview.',
    category: 'location',
    riskLevel: 'safe',
    cost: 'free',
    capabilities: ['globe.reset_view', 'earth.overview'],
    verification: GLOBE_VERIFICATION,
    async execute(): Promise<ToolResult> {
      return ok({
        output: { reset: true },
        ui: [
          { kind: 'globe_action', action: { type: 'reset_view' } },
        ],
      });
    },
  };

  const getCoordinatesTool: AgentTool = {
    name: 'globe.get_coordinates',
    description: 'Look up latitude and longitude coordinates for any place on Earth.',
    category: 'location',
    riskLevel: 'safe',
    cost: 'free',
    capabilities: ['globe.get_coordinates', 'location.coordinates'],
    inputSchema: {
      required: ['query'],
      types: { query: 'string' },
    },
    async execute(input): Promise<ToolResult> {
      const query = String(input.query || '').trim();
      if (!query) return fail('Query string is required');
      try {
        const result = await geocodeAddress(query);
        if (!result) return fail(`No coordinates found for "${query}"`);
        return ok({
          output: {
            lat: result.lat,
            lng: result.lng,
            city: result.city,
            country: result.country,
            formattedAddress: result.formattedAddress,
          },
        });
      } catch (err: any) {
        return fail(`Coordinate lookup failed: ${err?.message || err}`);
      }
    },
  };

  const showWindTool: AgentTool = {
    name: 'globe.show_wind',
    description:
      "Show animated live wind currents on the 3D globe. Optionally pass a target city/country/coordinates to fly there and enable the wind layer.",
    category: 'location',
    riskLevel: 'safe',
    cost: 'free',
    capabilities: ['globe.show_wind', 'wind.layer', 'earth.wind'],
    inputSchema: {
      optional: ['locationName', 'lat', 'lng'],
      types: { locationName: 'string', lat: 'number', lng: 'number' },
    },
    verification: GLOBE_VERIFICATION,
    async execute(input): Promise<ToolResult> {
      let lat = typeof input.lat === 'number' ? input.lat : undefined;
      let lng = typeof input.lng === 'number' ? input.lng : undefined;
      const locationName = typeof input.locationName === 'string' ? input.locationName.trim() : undefined;

      if ((lat === undefined || lng === undefined) && locationName) {
        try {
          const geocoded = await geocodeAddress(locationName);
          if (geocoded) {
            lat = geocoded.lat;
            lng = geocoded.lng;
          }
        } catch (err) {
          console.warn('Geocoding error in globe.show_wind:', err);
        }
      }

      const globeAction: GlobeAction = {
        type: 'wind_on',
        lat,
        lng,
        locationName,
      };

      return ok({
        output: {
          opened: true,
          windLayer: true,
          locationName,
          lat,
          lng,
        },
        ui: [
          { kind: 'open_modal', modal: 'globe' },
          { kind: 'globe_action', action: globeAction },
          { kind: 'pose', pose: 'waving_greeting' },
        ],
      });
    },
  };

  const hideWindTool: AgentTool = {
    name: 'globe.hide_wind',
    description: 'Turn off the animated wind currents layer on the 3D globe.',
    category: 'location',
    riskLevel: 'safe',
    cost: 'free',
    capabilities: ['globe.hide_wind', 'wind.layer'],
    verification: GLOBE_VERIFICATION,
    async execute(): Promise<ToolResult> {
      return ok({
        output: { windLayer: false },
        ui: [
          { kind: 'globe_action', action: { type: 'wind_off' } },
        ],
      });
    },
  };

  const windInfoTool: AgentTool = {
    name: 'globe.wind_info',
    description:
      'Look up the current real wind speed and direction for a place (city, country, or coordinates). Returns honest data from Open-Meteo; never estimates.',
    category: 'location',
    riskLevel: 'safe',
    cost: 'free',
    capabilities: ['globe.wind_info', 'wind.speed', 'wind.direction'],
    inputSchema: {
      required: ['query'],
      types: { query: 'string' },
    },
    async execute(input): Promise<ToolResult> {
      const query = String(input.query || '').trim();
      if (!query) return fail('Query string is required');

      let lat = typeof input.lat === 'number' ? input.lat : undefined;
      let lng = typeof input.lng === 'number' ? input.lng : undefined;

      try {
        if (lat === undefined || lng === undefined) {
          const geocoded = await geocodeAddress(query);
          if (!geocoded) return fail(`Could not resolve coordinates for "${query}"`);
          lat = geocoded.lat;
          lng = geocoded.lng;
        }

        const reading = await OPEN_METEO_WIND_QUERY.fetchPoint(lat, lng);
        return ok({
          output: {
            query,
            lat,
            lng,
            windSpeedKmh: reading.speedKmh,
            windSpeedMs: reading.speedMs,
            windDirectionDeg: reading.directionDeg,
            windDirectionFrom: `${reading.directionDeg.toFixed(0)}deg ${reading.cardinal}`,
            cardinal: directionToCardinal(reading.directionDeg),
            timestamp: reading.timestamp,
            source: reading.source,
          },
        });
      } catch (err: any) {
        return fail(`Wind data lookup failed for "${query}": ${err?.message || err}`);
      }
    },
  };

  return [showGlobeTool, flyToTool, setLayerTool, resetViewTool, getCoordinatesTool, showWindTool, hideWindTool, windInfoTool];
}
