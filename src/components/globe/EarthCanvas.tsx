import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import * as THREE from 'three';
import { GlobeCoordinates, GlobeMarker, MapLayerType, GlobeControllerHandle, WindInfoReading } from './types';
import { AVAILABLE_LAYERS, createFallbackProceduralTexture } from './layerManager';
import { WindService, WindStatusMeta, prepareGrid } from './environment/envService';
import { WindParticleField } from './environment/windParticles';

interface EarthCanvasProps {
  activeLayer: MapLayerType;
  onCoordinatesChange?: (coords: GlobeCoordinates | null) => void;
  onLocationSelect?: (coords: GlobeCoordinates) => void;
  initialLat?: number;
  initialLng?: number;
  selectedMarker?: GlobeMarker | null;
  windEnabled?: boolean;
  onWindStatusChange?: (meta: WindStatusMeta) => void;
  onDistanceChange?: (distance: number, centerCoords: GlobeCoordinates) => void;
}

const GLOBE_RADIUS = 100;
const MIN_DISTANCE = 115;
export const MAX_DISTANCE = 1400; // Expansive deep space orbital distance allowing zooming far out beyond default
export const DEFAULT_DISTANCE = 240;

// Coordinate transformations between Geographic (Lat, Lng) and Cartesian 3D (X, Y, Z)
export function latLngToVector3(lat: number, lng: number, radius: number = GLOBE_RADIUS): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);

  const x = -(radius * Math.sin(phi) * Math.cos(theta));
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);

  return new THREE.Vector3(x, y, z);
}

export function vector3ToLatLng(point: THREE.Vector3, radius: number = GLOBE_RADIUS): GlobeCoordinates {
  const normalized = point.clone().normalize();
  const phi = Math.acos(Math.max(-1, Math.min(1, normalized.y)));
  const theta = Math.atan2(normalized.z, -normalized.x);

  let lat = 90 - (phi * 180) / Math.PI;
  let lng = (theta * 180) / Math.PI - 180;

  // Normalize lng to [-180, 180]
  while (lng < -180) lng += 360;
  while (lng > 180) lng -= 360;

  return {
    lat: Number(lat.toFixed(4)),
    lng: Number(lng.toFixed(4)),
    altitude: Number((point.length() - radius).toFixed(1)),
  };
}

export const EarthCanvas = forwardRef<GlobeControllerHandle, EarthCanvasProps>(
  (
    {
      activeLayer,
      onCoordinatesChange,
      onLocationSelect,
      initialLat = 20,
      initialLng = 0,
      selectedMarker,
      windEnabled = false,
      onWindStatusChange,
      onDistanceChange,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const earthMeshRef = useRef<THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial> | null>(null);
    const atmosphereMeshRef = useRef<THREE.Mesh | null>(null);
    const markerGroupRef = useRef<THREE.Group | null>(null);

    // Interaction & Animation State
    const isInteractingRef = useRef(false);
    const isDirtyRef = useRef(true);
    const flightAnimationRef = useRef<{
      startPos: THREE.Vector3;
      targetPos: THREE.Vector3;
      startTime: number;
      duration: number;
      onComplete?: () => void;
    } | null>(null);

    // Spherical Camera Control State
    const sphericalRef = useRef({
      radius: DEFAULT_DISTANCE,
      phi: (90 - initialLat) * (Math.PI / 180),
      theta: (initialLng + 180) * (Math.PI / 180),
    });

    const targetSphericalRef = useRef({
      radius: DEFAULT_DISTANCE,
      phi: (90 - initialLat) * (Math.PI / 180),
      theta: (initialLng + 180) * (Math.PI / 180),
    });

    const pointerRef = useRef<{
      isDown: boolean;
      prevX: number;
      prevY: number;
      startX: number;
      startY: number;
      moved: boolean;
    }>({
      isDown: false,
      prevX: 0,
      prevY: 0,
      startX: 0,
      startY: 0,
      moved: false,
    });

    const raycasterRef = useRef(new THREE.Raycaster());
    const mouseNdcRef = useRef(new THREE.Vector2(-999, -999));
    const currentCoordsRef = useRef<GlobeCoordinates | null>(null);

    // Environmental (wind) layer state
    const windServiceRef = useRef<WindService | null>(null);
    const windFieldRef = useRef<WindParticleField | null>(null);
    const windActiveRef = useRef(false);
    const lastWindBoundsKeyRef = useRef<string>('');
    const cameraSettledFramesRef = useRef(0);
    const lastWindTickRef = useRef(0);

    // Imperative Controller Handle exposed to Krisha Agent & Parent UI
    useImperativeHandle(ref, () => ({
      flyTo: (lat: number, lng: number, distance: number = 150, durationMs: number = 1600): Promise<void> => {
        return new Promise((resolve) => {
          if (!cameraRef.current) {
            resolve();
            return;
          }

          const targetPhi = THREE.MathUtils.clamp((90 - lat) * (Math.PI / 180), 0.05, Math.PI - 0.05);
          // Calculate shortest path for longitude
          let targetTheta = (lng + 180) * (Math.PI / 180);
          const currentTheta = targetSphericalRef.current.theta;
          
          // Wrap theta for shortest arc rotation
          const diff = (targetTheta - currentTheta) % (2 * Math.PI);
          const shortestDiff = ((diff + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
          targetTheta = currentTheta + shortestDiff;

          const startRadius = targetSphericalRef.current.radius;
          const targetRadius = THREE.MathUtils.clamp(distance, MIN_DISTANCE, MAX_DISTANCE);

          const startTime = performance.now();
          const startPhi = targetSphericalRef.current.phi;
          const startTheta = targetSphericalRef.current.theta;

          const tickFlight = (now: number) => {
            const elapsed = now - startTime;
            const progress = THREE.MathUtils.clamp(elapsed / durationMs, 0, 1);
            // Smooth cubic ease-in-out curve
            const ease = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;

            // Optional orbital arc altitude lift during long distance transitions
            const arcLift = Math.sin(progress * Math.PI) * Math.min(40, Math.abs(shortestDiff) * 15);

            targetSphericalRef.current.phi = THREE.MathUtils.lerp(startPhi, targetPhi, ease);
            targetSphericalRef.current.theta = THREE.MathUtils.lerp(startTheta, targetTheta, ease);
            targetSphericalRef.current.radius = THREE.MathUtils.lerp(startRadius, targetRadius, ease) + arcLift;

            isDirtyRef.current = true;

            if (progress < 1) {
              requestAnimationFrame(tickFlight);
            } else {
              targetSphericalRef.current.radius = targetRadius;
              flightAnimationRef.current = null;
              resolve();
            }
          };

          requestAnimationFrame(tickFlight);
        });
      },

      resetToEarthView: (durationMs: number = 1200): Promise<void> => {
        return new Promise((resolve) => {
          const startRadius = targetSphericalRef.current.radius;
          const startPhi = targetSphericalRef.current.phi;
          const targetPhi = Math.PI / 2.3; // Gentle natural perspective
          const startTime = performance.now();

          const tickReset = (now: number) => {
            const elapsed = now - startTime;
            const progress = THREE.MathUtils.clamp(elapsed / durationMs, 0, 1);
            const ease = 1 - Math.pow(1 - progress, 3); // ease-out cubic

            targetSphericalRef.current.radius = THREE.MathUtils.lerp(startRadius, DEFAULT_DISTANCE, ease);
            targetSphericalRef.current.phi = THREE.MathUtils.lerp(startPhi, targetPhi, ease);
            isDirtyRef.current = true;

            if (progress < 1) {
              requestAnimationFrame(tickReset);
            } else {
              resolve();
            }
          };
          requestAnimationFrame(tickReset);
        });
      },

      zoomIn: () => {
        const currentR = targetSphericalRef.current.radius;
        const step = Math.max(25, currentR * 0.18);
        const newRadius = THREE.MathUtils.clamp(
          currentR - step,
          MIN_DISTANCE,
          MAX_DISTANCE
        );
        targetSphericalRef.current.radius = newRadius;
        isDirtyRef.current = true;

        const phi = sphericalRef.current.phi;
        const theta = sphericalRef.current.theta;
        const lat = 90 - (phi * 180) / Math.PI;
        const lng = (theta * 180) / Math.PI - 180;
        onDistanceChange?.(newRadius, { lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)) });
      },

      zoomOut: () => {
        const currentR = targetSphericalRef.current.radius;
        // Adaptive zoom step: expands smoothly as camera retreats into deep space
        const step = Math.max(45, currentR * 0.26);
        const newRadius = THREE.MathUtils.clamp(
          currentR + step,
          MIN_DISTANCE,
          MAX_DISTANCE
        );
        targetSphericalRef.current.radius = newRadius;
        isDirtyRef.current = true;

        const phi = sphericalRef.current.phi;
        const theta = sphericalRef.current.theta;
        const lat = 90 - (phi * 180) / Math.PI;
        const lng = (theta * 180) / Math.PI - 180;
        onDistanceChange?.(newRadius, { lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)) });
      },

      setLayer: (layer: MapLayerType) => {
        loadLayerTexture(layer);
      },

      getCoordinatesUnderCursor: () => currentCoordsRef.current,

      getCameraCoordinates: () => {
        const phi = sphericalRef.current.phi;
        const theta = sphericalRef.current.theta;
        const lat = 90 - (phi * 180) / Math.PI;
        const lng = (theta * 180) / Math.PI - 180;
        return {
          lat: Number(lat.toFixed(4)),
          lng: Number(lng.toFixed(4)),
          altitude: Number((sphericalRef.current.radius - GLOBE_RADIUS).toFixed(1)),
        };
      },

      addMarker: (marker: GlobeMarker) => {
        renderMarkerOnGlobe(marker);
      },

      clearMarkers: () => {
        if (markerGroupRef.current) {
          while (markerGroupRef.current.children.length > 0) {
            const obj = markerGroupRef.current.children[0];
            markerGroupRef.current.remove(obj);
          }
          isDirtyRef.current = true;
        }
      },

      getWindReadingAt: async (lat: number, lng: number): Promise<WindInfoReading | null> => {
        const service = windServiceRef.current;
        if (!service) return null;
        const field = windFieldRef.current;
        return service.getReadingAt(lat, lng, field?.preparedLayer ?? null);
      },

      isWindDataReady: () => !!windFieldRef.current?.isReady,
    }));

    // Texture loader with caching & offline fallback
    const textureLoaderRef = useRef(new THREE.TextureLoader());
    const loadLayerTexture = (layerType: MapLayerType) => {
      const mesh = earthMeshRef.current;
      if (!mesh) return;

      const layerConfig = AVAILABLE_LAYERS[layerType] || AVAILABLE_LAYERS.satellite;

      const applyTexture = (texture: THREE.Texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        mesh.material.map = texture;
        mesh.material.needsUpdate = true;
        isDirtyRef.current = true;
      };

      // Load main imagery texture
      textureLoaderRef.current.load(
        layerConfig.textureUrl,
        (loadedTex) => applyTexture(loadedTex),
        undefined,
        (err) => {
          console.warn(`Layer texture load error for ${layerType}, using procedural fallback:`, err);
          const fallbackDataUrl = createFallbackProceduralTexture(layerType);
          textureLoaderRef.current.load(fallbackDataUrl, (fbTex) => applyTexture(fbTex));
        }
      );

      // Load bump/topography if available
      if (layerConfig.bumpMapUrl) {
        textureLoaderRef.current.load(
          layerConfig.bumpMapUrl,
          (bumpTex) => {
            mesh.material.bumpMap = bumpTex;
            mesh.material.bumpScale = 0.8;
            mesh.material.needsUpdate = true;
            isDirtyRef.current = true;
          },
          undefined,
          () => {}
        );
      } else {
        mesh.material.bumpMap = null;
        mesh.material.needsUpdate = true;
      }
    };

    // Render single 3D Pin Marker with glowing ring
    const renderMarkerOnGlobe = (marker: GlobeMarker) => {
      if (!markerGroupRef.current) return;

      // Clear existing pins
      while (markerGroupRef.current.children.length > 0) {
        markerGroupRef.current.remove(markerGroupRef.current.children[0]);
      }

      const pos = latLngToVector3(marker.lat, marker.lng, GLOBE_RADIUS + 0.8);
      const markerRoot = new THREE.Group();
      markerRoot.position.copy(pos);

      // Orient marker perpendicular to Earth's surface
      markerRoot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pos.clone().normalize());

      // Glowing core sphere
      const pinSphereGeo = new THREE.SphereGeometry(1.4, 16, 16);
      const pinSphereMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
      const pinSphere = new THREE.Mesh(pinSphereGeo, pinSphereMat);
      pinSphere.position.y = 2.5;
      markerRoot.add(pinSphere);

      // Sleek holographic needle / stem
      const stemGeo = new THREE.CylinderGeometry(0.2, 0.4, 3, 8);
      const stemMat = new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.8 });
      const stem = new THREE.Mesh(stemGeo, stemMat);
      stem.position.y = 1.5;
      markerRoot.add(stem);

      // Pulsing pulse ring on surface
      const ringGeo = new THREE.RingGeometry(1.2, 2.2, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x00f0ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      markerRoot.add(ring);

      markerGroupRef.current.add(markerRoot);
      isDirtyRef.current = true;
    };

    // Initialize WebGL Scene
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const width = container.clientWidth || window.innerWidth;
      const height = container.clientHeight || window.innerHeight;

      // 1. Scene
      const scene = new THREE.Scene();
      sceneRef.current = scene;

      // 2. Camera
      const camera = new THREE.PerspectiveCamera(45, width / height, 1, 4000);
      cameraRef.current = camera;

      // 3. Renderer with high performance & smooth pixel ratio
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;

      // 4. Subtle Starfield / Cosmic dust matching Krisha dark anime aesthetic
      const starCount = 800;
      const starGeo = new THREE.BufferGeometry();
      const starPositions = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount * 3; i += 3) {
        const r = 850 + Math.random() * 1800;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        starPositions[i] = r * Math.sin(phi) * Math.cos(theta);
        starPositions[i + 1] = r * Math.sin(phi) * Math.sin(theta);
        starPositions[i + 2] = r * Math.cos(phi);
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
      const starMat = new THREE.PointsMaterial({
        color: 0x93c5fd,
        size: 1.5,
        transparent: true,
        opacity: 0.6,
      });
      const starField = new THREE.Points(starGeo, starMat);
      scene.add(starField);

      // 5. Lighting: Ambient + Sunlight Directional
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
      scene.add(ambientLight);

      const sunLight = new THREE.DirectionalLight(0xfff7ed, 1.4);
      sunLight.position.set(300, 150, 200);
      scene.add(sunLight);

      const blueRimLight = new THREE.DirectionalLight(0x38bdf8, 0.6);
      blueRimLight.position.set(-200, -100, -200);
      scene.add(blueRimLight);

      // 6. Earth Mesh (Standard Material)
      const earthGeo = new THREE.SphereGeometry(GLOBE_RADIUS, 64, 64);
      const earthMat = new THREE.MeshStandardMaterial({
        roughness: 0.65,
        metalness: 0.05,
      });
      const earthMesh = new THREE.Mesh(earthGeo, earthMat);
      scene.add(earthMesh);
      earthMeshRef.current = earthMesh;

      // 7. Atmospheric Fresnel Glow Halo
      const atmosphereGeo = new THREE.SphereGeometry(GLOBE_RADIUS * 1.018, 64, 64);
      const atmosphereMat = new THREE.ShaderMaterial({
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vNormal;
          void main() {
            float intensity = pow(0.68 - dot(vNormal, vec3(0, 0, 1.0)), 2.5);
            gl_FragColor = vec4(0.22, 0.65, 1.0, 1.0) * intensity;
          }
        `,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        transparent: true,
      });
      const atmosphereMesh = new THREE.Mesh(atmosphereGeo, atmosphereMat);
      scene.add(atmosphereMesh);
      atmosphereMeshRef.current = atmosphereMesh;

      // 8. Marker Group
      const markerGroup = new THREE.Group();
      scene.add(markerGroup);
      markerGroupRef.current = markerGroup;

      // Load initial layer texture
      loadLayerTexture(activeLayer);

      // 9. Resize Observer
      const handleResize = () => {
        if (!container || !renderer || !camera) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        isDirtyRef.current = true;
      };
      window.addEventListener('resize', handleResize);

      // 10. Performance-Optimized Render Loop with Auto-Idle Sleep
      let animationFrameId: number;
      let idleFrames = 0;

      const animate = () => {
        animationFrameId = requestAnimationFrame(animate);

        // Smooth damping towards target spherical angles
        const lerpFactor = 0.09;
        const phiDiff = targetSphericalRef.current.phi - sphericalRef.current.phi;
        const thetaDiff = targetSphericalRef.current.theta - sphericalRef.current.theta;
        const radiusDiff = targetSphericalRef.current.radius - sphericalRef.current.radius;

        const isMoving =
          Math.abs(phiDiff) > 0.0001 ||
          Math.abs(thetaDiff) > 0.0001 ||
          Math.abs(radiusDiff) > 0.01 ||
          isInteractingRef.current;

        if (isMoving) {
          sphericalRef.current.phi += phiDiff * lerpFactor;
          sphericalRef.current.theta += thetaDiff * lerpFactor;
          sphericalRef.current.radius += radiusDiff * lerpFactor;
          isDirtyRef.current = true;
          idleFrames = 0;
        } else {
          idleFrames++;
        }

        // Update Camera Position based on Spherical Coordinates.
        // IMPORTANT: this parameterization MUST match latLngToVector3 above
        // (x = -sin(phi)cos(theta), z = sin(phi)sin(theta)); otherwise the
        // camera hovers over a different geographic point than the (lat,lng)
        // it carries (a constant 90-degree longitude offset).
        const s = sphericalRef.current;
        camera.position.x = -s.radius * Math.sin(s.phi) * Math.cos(s.theta);
        camera.position.y = s.radius * Math.cos(s.phi);
        camera.position.z = s.radius * Math.sin(s.phi) * Math.sin(s.theta);
        camera.lookAt(0, 0, 0);

        // Advance the environmental (wind) engine when active. The engine
        // interpolates between the latest real data points locally; network
        // refresh happens separately (see requestWindForCurrentView).
        const windField = windFieldRef.current;
        if (windField && windActiveRef.current) {
          windField.setCameraRadius(s.radius);
          const nowTick = performance.now();
          const windDt = Math.min(Math.max(nowTick - (lastWindTickRef.current || nowTick), 0.5), 100);
          lastWindTickRef.current = nowTick;
          if (windField.update(windDt)) {
            isDirtyRef.current = true; // flow advanced -> draw next frame
          }
          if (!isMoving) {
            cameraSettledFramesRef.current++;
            if (cameraSettledFramesRef.current === 30) {
              requestWindForCurrentView();
            }
          } else {
            cameraSettledFramesRef.current = 0;
          }
        }

        // Only draw frame when dirty or gently decaying idle frames (saves GPU on laptops!)
        if (isDirtyRef.current || idleFrames < 10) {
          renderer.render(scene, camera);
          if (!isMoving && idleFrames >= 10) {
            isDirtyRef.current = false;
          }
        }
      };

      animate();

      return () => {
        cancelAnimationFrame(animationFrameId);
        window.removeEventListener('resize', handleResize);
        if (renderer.domElement && container.contains(renderer.domElement)) {
          container.removeChild(renderer.domElement);
        }
        // Release environmental layer animation & network resources.
        windActiveRef.current = false;
        windServiceRef.current?.dispose();
        windFieldRef.current?.dispose();
        windServiceRef.current = null;
        windFieldRef.current = null;
        renderer.dispose();
        earthGeo.dispose();
        earthMat.dispose();
        atmosphereGeo.dispose();
        atmosphereMat.dispose();
        starGeo.dispose();
        starMat.dispose();
      };
    }, []);

    // Respond to active layer switch
    useEffect(() => {
      loadLayerTexture(activeLayer);
    }, [activeLayer]);

    // Respond to external marker changes
    useEffect(() => {
      if (selectedMarker) {
        renderMarkerOnGlobe(selectedMarker);
      }
    }, [selectedMarker]);

    // -------------------------------------------------------------------------
    // Environmental (wind) layer lifecycle
    // -------------------------------------------------------------------------

    // View span from the horizon angle: closer camera -> smaller bounds.
    const computeCurrentViewBounds = () => {
      const s = sphericalRef.current;
      const lat = Math.max(-85, Math.min(85, 90 - (s.phi * 180) / Math.PI));
      const lng = Math.max(-180, Math.min(180, (s.theta * 180) / Math.PI - 180));
      const horizonDeg = (Math.acos(Math.min(1, Math.max(-1, GLOBE_RADIUS / s.radius))) * 180) / Math.PI;
      const span = Math.max(6, Math.min(170, horizonDeg * 1.7));
      return {
        minLat: Math.max(-85, lat - span / 2),
        maxLat: Math.min(85, lat + span / 2),
        minLng: lng - span / 2,
        maxLng: lng + span / 2,
      };
    };

    const handleWindStatus = (meta: WindStatusMeta) => {
      onWindStatusChange?.(meta);
      if (meta.status === 'live') {
        const field = windFieldRef.current;
        const service = windServiceRef.current;
        const cached = service?.cachedField;
        if (field && cached) {
          field.updateField(prepareGrid(cached));
          field.show();
        }
      }
    };

    const requestWindForCurrentView = (force = false) => {
      const service = windServiceRef.current;
      if (!service) return;
      const bounds = computeCurrentViewBounds();
      const key = `lat:${bounds.minLat.toFixed(0)}..${bounds.maxLat.toFixed(0)}|lng:${bounds.minLng.toFixed(0)}..${bounds.maxLng.toFixed(0)}`;
      if (!force) {
        const cached = service.cachedField;
        const freshEnough = cached && Date.now() - cached.timestamp < 2 * 60_000;
        if (freshEnough && lastWindBoundsKeyRef.current === key) return;
      }
      lastWindBoundsKeyRef.current = key;
      // Network calls are throttled/debounced inside WindService.
      service.requestWindField(bounds, handleWindStatus);
    };

    // Enable / disable the wind layer (React prop drives the engine).
    useEffect(() => {
      const scene = sceneRef.current;
      if (!scene) return;

      if (windEnabled) {
        if (!windFieldRef.current) {
          windFieldRef.current = new WindParticleField(scene);
        }
        if (!windServiceRef.current) {
          windServiceRef.current = new WindService();
        }
        windFieldRef.current.setLayerEnabled(true);
        windActiveRef.current = true;
        cameraSettledFramesRef.current = 0;
        requestWindForCurrentView(true);
      } else if (windFieldRef.current) {
        windFieldRef.current.setLayerEnabled(false);
        windActiveRef.current = false;
        lastWindBoundsKeyRef.current = '';
      }
    }, [windEnabled]);

    // -------------------------------------------------------------------------
    // Mouse Drag, Wheel Zoom & Cursor Raycasting Handlers
    // -------------------------------------------------------------------------

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      pointerRef.current = {
        isDown: true,
        prevX: e.clientX,
        prevY: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };
      isInteractingRef.current = true;
      isDirtyRef.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      const camera = cameraRef.current;
      const earth = earthMeshRef.current;

      // 1. Raycast to compute Latitude & Longitude under cursor
      if (container && camera && earth) {
        const rect = container.getBoundingClientRect();
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        mouseNdcRef.current.set(ndcX, ndcY);

        raycasterRef.current.setFromCamera(mouseNdcRef.current, camera);
        const hits = raycasterRef.current.intersectObject(earth);

        if (hits.length > 0) {
          const hitPoint = hits[0].point;
          const coords = vector3ToLatLng(hitPoint);
          currentCoordsRef.current = coords;
          onCoordinatesChange?.(coords);
        } else {
          currentCoordsRef.current = null;
          onCoordinatesChange?.(null);
        }
      }

      // 2. Drag Rotation
      if (!pointerRef.current.isDown) return;

      const deltaX = e.clientX - pointerRef.current.prevX;
      const deltaY = e.clientY - pointerRef.current.prevY;

      if (Math.abs(e.clientX - pointerRef.current.startX) > 4 || Math.abs(e.clientY - pointerRef.current.startY) > 4) {
        pointerRef.current.moved = true;
      }

      pointerRef.current.prevX = e.clientX;
      pointerRef.current.prevY = e.clientY;

      // Sensitivity scales with zoom distance so close-up navigation feels precise
      const zoomFactor = sphericalRef.current.radius / DEFAULT_DISTANCE;
      const sensitivity = 0.0055 * zoomFactor;

      targetSphericalRef.current.theta -= deltaX * sensitivity;
      targetSphericalRef.current.phi = THREE.MathUtils.clamp(
        targetSphericalRef.current.phi - deltaY * sensitivity,
        0.05,
        Math.PI - 0.05
      );

      isDirtyRef.current = true;
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const moved = pointerRef.current.moved;
      pointerRef.current.isDown = false;
      isInteractingRef.current = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}

      // Click event without drag: select location!
      if (!moved && currentCoordsRef.current) {
        onLocationSelect?.(currentCoordsRef.current);
      }
    };

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      // Zoom in / out smoothly with scale-aware delta
      const currentR = targetSphericalRef.current.radius;
      const zoomFactor = Math.max(0.6, currentR / DEFAULT_DISTANCE);
      const zoomDelta = e.deltaY * 0.32 * zoomFactor;
      const newRadius = THREE.MathUtils.clamp(
        currentR + zoomDelta,
        MIN_DISTANCE,
        MAX_DISTANCE
      );
      targetSphericalRef.current.radius = newRadius;
      isDirtyRef.current = true;

      // Report distance and center coordinates for progressive LOD / Google Earth switch
      const phi = sphericalRef.current.phi;
      const theta = sphericalRef.current.theta;
      const lat = 90 - (phi * 180) / Math.PI;
      const lng = (theta * 180) / Math.PI - 180;
      onDistanceChange?.(newRadius, { lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)) });
    };

    return (
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        className="relative w-full h-full cursor-grab active:cursor-grabbing select-none outline-none overflow-hidden touch-none"
      />
    );
  }
);
