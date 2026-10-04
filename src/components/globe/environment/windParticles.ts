/**
 * Krisha Animated Wind-Flow Particle Field.
 *
 * Lightweight GPU-friendly animated wind visualization over the 3D Earth:
 *  - Particle state is stored in GEOGRAPHIC coordinates (lat, lng) so the
 *    flow stays geographically aligned while the camera rotates/zooms.
 *  - Wind motion follows the actual vector field (bilinear interpolation
 *    between real data points), never random movement.
 *  - One THREE.Points layer (heads) + one THREE.LineSegments layer (fading
 *    trails) with additive blending -- a few hundred particles total.
 *  - Adaptive density driven by camera distance and measured device
 *    performance; zero processing when the layer is disabled.
 */
import * as THREE from 'three';
import { PreparedGrid, sampleField, uvToSpeedDirection } from './envService';

const GLOBE_RADIUS = 100; // must match EarthCanvas
const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_DEGREE = 111_320;

/** Geographic wind motion is far slower than a comfortable animation speed,
 *  so drift is scaled up (relative speed is preserved: 2x wind moves 2x
 *  faster). Visual scaling only -- the underlying vectors stay untouched. */
const VISUAL_SPEED_MULTIPLIER = 14_000;

// Render altitude above the Earth surface.
const PIN_HEIGHT = 1.6;

const DENSITY_LOW_RADIUS = 140;
const DENSITY_HIGH_RADIUS = 260;
const DENSITY_LOW = 300;
const DENSITY_HIGH = 420;
const COUNT_MIN = 120;
const RESPAWN_MARGIN_DEG = 2;

interface Particle {
  lat: number;
  lng: number;
  prevLat: number;
  prevLng: number;
  speedMs: number;
}

export class WindParticleField {
  private group = new THREE.Group();
  private particles: Particle[] = [];
  private prepared: PreparedGrid | null = null;
  private bounds = { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0, spanLng: 360 };

  private pointsGeometry: THREE.BufferGeometry;
  private trailGeometry: THREE.BufferGeometry;
  private pointsMaterial: THREE.ShaderMaterial;
  private trailMaterial: THREE.LineBasicMaterial;

  private headPositions: Float32Array;
  private headSpeeds: Float32Array;
  private trailPositions: Float32Array;
  private trailColors: Float32Array;

  private enabled = false;
  private ready = false;
  private cameraRadius = 240;
  private targetCount = DENSITY_LOW;
  private frameMsAvg = 16;

  // Scratch vectors to avoid per-frame allocations.
  private scratchHead = new THREE.Vector3();
  private scratchPrev = new THREE.Vector3();

  constructor(private scene: THREE.Scene) {
    // Slots must cover the maximum adaptive density (DENSITY_HIGH), not just
    // the floor -- otherwise higher densities would render partially.
    const headSlots = DENSITY_HIGH;
    const trailSlots = DENSITY_HIGH * 2;

    this.headPositions = new Float32Array(headSlots * 3);
    this.headSpeeds = new Float32Array(headSlots);
    this.trailPositions = new Float32Array(trailSlots * 3);
    this.trailColors = new Float32Array(trailSlots * 3);

    this.pointsGeometry = new THREE.BufferGeometry();
    this.pointsGeometry.setAttribute('position', new THREE.BufferAttribute(this.headPositions, 3));
    this.pointsGeometry.setAttribute('aSpeed', new THREE.BufferAttribute(this.headSpeeds, 1));
    this.pointsGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 300);

    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trailGeometry.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 3));
    this.trailGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 300);

    this.pointsMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: window.innerHeight * 0.5 },
      },
      vertexShader: `
        attribute float aSpeed;
        uniform float uScale;
        varying float vSpeed;
        void main() {
          vSpeed = aSpeed;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float size = 2.2 + 2.4 * smoothstep(0.0, 30.0, aSpeed);
          gl_PointSize = size * (uScale / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vSpeed;
        vec3 ramp(float s) {
          if (s < 5.0) return mix(vec3(0.22, 0.74, 0.97), vec3(0.13, 0.83, 0.93), s / 5.0);
          if (s < 10.0) return mix(vec3(0.13, 0.83, 0.93), vec3(0.20, 0.83, 0.60), (s - 5.0) / 5.0);
          if (s < 18.0) return mix(vec3(0.20, 0.83, 0.60), vec3(0.98, 0.80, 0.08), (s - 10.0) / 8.0);
          return mix(vec3(0.98, 0.80, 0.08), vec3(0.97, 0.44, 0.44), smoothstep(18.0, 28.0, s));
        }
        void main() {
          float edge = length(gl_PointCoord - vec2(0.5));
          if (edge > 0.5) discard;
          float glow = smoothstep(0.5, 0.0, edge);
          gl_FragColor = vec4(ramp(vSpeed), 0.9 * glow);
        }
      `,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });

    this.trailMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.55,
    });

    const points = new THREE.Points(this.pointsGeometry, this.pointsMaterial);
    points.frustumCulled = false;
    points.renderOrder = 5;
    const trails = new THREE.LineSegments(this.trailGeometry, this.trailMaterial);
    trails.frustumCulled = false;
    trails.renderOrder = 4;

    this.group.add(points);
    this.group.add(trails);
    this.group.visible = false;
    this.scene.add(this.group);
  }

  setLayerEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.group.visible = false;
      this.particles = [];
      this.prepared = null;
      this.ready = false;
    }
  }

  setCameraRadius(radius: number): void {
    this.cameraRadius = radius;
  }

  /** Swap in newly fetched real wind data (particles spread across it). */
  updateField(prepared: PreparedGrid | null): void {
    this.prepared = prepared;
    this.ready = !!prepared && prepared.field.vectors.length > 0;
    if (!prepared) return;
    this.computeBounds(prepared);
    this.seedParticles();
  }

  private computeBounds(prepared: PreparedGrid): void {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const v of prepared.field.vectors) {
      if (v.lat < minLat) minLat = v.lat;
      if (v.lat > maxLat) maxLat = v.lat;
      if (v.lng < minLng) minLng = v.lng;
      if (v.lng > maxLng) maxLng = v.lng;
    }
    // If the lng range spans more than half the globe, treat as global band.
    if (maxLng - minLng > 180) {
      minLng = -180;
      maxLng = 180;
    }
    this.bounds = { minLat, maxLat, minLng, maxLng, spanLng: maxLng - minLng };
  }

  private seedParticles(): void {
    this.particles = [];
    for (let i = 0; i < this.targetCount; i++) {
      this.particles.push(this.spawnParticle());
    }
    if (this.enabled && this.ready) this.group.visible = true;
  }

  private spawnParticle(): Particle {
    const p: Particle = {
      lat: this.randomLat(),
      lng: this.randomLng(),
      prevLat: 0,
      prevLng: 0,
      speedMs: 0,
    };
    p.prevLat = p.lat;
    p.prevLng = p.lng;
    this.updateSpeed(p);
    return p;
  }

  private respawn(p: Particle): void {
    p.lat = this.randomLat();
    p.lng = this.randomLng();
    p.prevLat = p.lat;
    p.prevLng = p.lng;
    this.updateSpeed(p);
  }

  private randomLat(): number {
    return this.bounds.minLat + Math.random() * (this.bounds.maxLat - this.bounds.minLat);
  }

  private randomLng(): number {
    return this.bounds.minLng + Math.random() * this.bounds.spanLng;
  }

  private updateSpeed(p: Particle): void {
    if (!this.prepared) {
      p.speedMs = 0;
      return;
    }
    const sample = sampleField(this.prepared, p.lat, p.lng);
    p.speedMs = sample ? uvToSpeedDirection(sample.u, sample.v).speedMs : 0;
  }

  /**
   * Advance the flow one animation step. `dtMs` is wall time between
   * animation frames. Returns true when buffers changed and were uploaded.
   */
  update(dtMs: number): boolean {
    if (!this.enabled || !this.ready) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;

    this.adaptDensity(dtMs);
    if (this.particles.length === 0) return false;

    const dtSeconds = Math.min(Math.max(dtMs, 0.5), 100) / 1000;
    const degPerSpeedUnit = (VISUAL_SPEED_MULTIPLIER / METERS_PER_DEGREE) * dtSeconds;
    const margin = RESPAWN_MARGIN_DEG;

    for (const p of this.particles) {
      const sample = sampleField(this.prepared!, p.lat, p.lng);
      if (!sample) {
        this.respawn(p);
        continue;
      }
      p.speedMs = uvToSpeedDirection(sample.u, sample.v).speedMs;
      p.prevLat = p.lat;
      p.prevLng = p.lng;
      // Standard meteorological components: u>0 = toward east (+lng), v>0 = toward north (+lat)
      p.lat += sample.v * degPerSpeedUnit;
      p.lng += sample.u * degPerSpeedUnit;

      if (p.lat < this.bounds.minLat - margin || p.lat > this.bounds.maxLat + margin) {
        this.respawn(p);
        continue;
      }
      const lngDelta = ((p.lng - this.bounds.minLng) % 360 + 360) % 360;
      if (lngDelta > this.bounds.spanLng + margin) {
        this.respawn(p);
      }
    }
    this.uploadBuffers();
    return true;
  }

  private uploadBuffers(): void {
    const radius = GLOBE_RADIUS + PIN_HEIGHT;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      this.latLngToXYZ(p.lat, p.lng, radius, this.scratchHead);
      this.latLngToXYZ(p.prevLat, p.prevLng, radius, this.scratchPrev);

      this.headPositions[i * 3] = this.scratchHead.x;
      this.headPositions[i * 3 + 1] = this.scratchHead.y;
      this.headPositions[i * 3 + 2] = this.scratchHead.z;
      this.headSpeeds[i] = p.speedMs;

      this.trailPositions[i * 6] = this.scratchPrev.x;
      this.trailPositions[i * 6 + 1] = this.scratchPrev.y;
      this.trailPositions[i * 6 + 2] = this.scratchPrev.z;
      this.trailPositions[i * 6 + 3] = this.scratchHead.x;
      this.trailPositions[i * 6 + 4] = this.scratchHead.y;
      this.trailPositions[i * 6 + 5] = this.scratchHead.z;

      const headColor = RAMP_COLOR_CACHE(p.speedMs);
      this.trailColors[i * 6] = headColor.r * 0.15;
      this.trailColors[i * 6 + 1] = headColor.g * 0.15;
      this.trailColors[i * 6 + 2] = headColor.b * 0.15;
      this.trailColors[i * 6 + 3] = headColor.r;
      this.trailColors[i * 6 + 4] = headColor.g;
      this.trailColors[i * 6 + 5] = headColor.b;
    }

    this.pointsGeometry.setDrawRange(0, this.particles.length);
    this.trailGeometry.setDrawRange(0, this.particles.length * 2);
    (this.pointsGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.pointsGeometry.getAttribute('aSpeed') as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Measure device performance and adjust particle density accordingly. */
  private adaptDensity(dtMs: number): void {
    this.frameMsAvg = this.frameMsAvg * 0.95 + dtMs * 0.05;

    const base =
      this.cameraRadius <= DENSITY_LOW_RADIUS
        ? DENSITY_LOW
        : this.cameraRadius >= DENSITY_HIGH_RADIUS
        ? DENSITY_HIGH
        : DENSITY_LOW + ((DENSITY_HIGH - DENSITY_LOW) * (this.cameraRadius - DENSITY_LOW_RADIUS)) /
          (DENSITY_HIGH_RADIUS - DENSITY_LOW_RADIUS);

    let factor = 1;
    if (this.frameMsAvg > 30) factor = 0.7;
    else if (this.frameMsAvg > 24) factor = 0.85;
    else if (this.frameMsAvg < 13) factor = 1;

    const newTarget = Math.max(COUNT_MIN, Math.min(Math.round(base * factor), Math.round(base)));
    if (newTarget !== this.targetCount) {
      this.targetCount = newTarget;
      if (this.prepared) this.seedParticles();
    }
  }

  /** Show the flow once real data is available. */
  show(): void {
    if (this.enabled && this.ready) this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get preparedLayer(): PreparedGrid | null {
    return this.prepared;
  }

  /** Full GPU/CPU cleanup when the globe closes or the layer is removed. */
  dispose(): void {
    this.particles = [];
    this.prepared = null;
    this.ready = false;
    this.pointsGeometry.dispose();
    this.trailGeometry.dispose();
    this.pointsMaterial.dispose();
    this.trailMaterial.dispose();
    this.scene.remove(this.group);
  }

  private latLngToXYZ(lat: number, lng: number, radius: number, out: THREE.Vector3): THREE.Vector3 {
    // Same geographic mapping as EarthCanvas.latLngToVector3 (kept local to
    // avoid a circular dependency).
    const phi = (90 - lat) * DEG_TO_RAD;
    const theta = (lng + 180) * DEG_TO_RAD;
    const sinPhi = Math.sin(phi);
    out.set(
      -(radius * sinPhi * Math.cos(theta)),
      radius * Math.cos(phi),
      radius * sinPhi * Math.sin(theta)
    );
    return out;
  }
}

// Speed ramp (m/s -> color) fitting Krisha's cyan/blue aesthetic.
const RAMP_STOPS: { speed: number; color: THREE.Color }[] = [
  { speed: 0, color: new THREE.Color('#38bdf8') }, // light blue
  { speed: 5, color: new THREE.Color('#22d3ee') }, // cyan
  { speed: 10, color: new THREE.Color('#34d399') }, // green
  { speed: 18, color: new THREE.Color('#facc15') }, // yellow
  { speed: 28, color: new THREE.Color('#f87171') }, // red
];

function RAMP_COLOR_CACHE(speedMs: number): THREE.Color {
  if (speedMs <= RAMP_STOPS[0].speed) return RAMP_STOPS[0].color;
  for (let i = 1; i < RAMP_STOPS.length; i++) {
    if (speedMs <= RAMP_STOPS[i].speed) {
      const prev = RAMP_STOPS[i - 1];
      const next = RAMP_STOPS[i];
      const t = (speedMs - prev.speed) / (next.speed - prev.speed);
      return prev.color.clone().lerp(next.color, t);
    }
  }
  return RAMP_STOPS[RAMP_STOPS.length - 1].color;
}
