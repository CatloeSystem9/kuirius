/**
 * Verification Suite for Google Earth / 3D Detail Integration.
 * Verifies:
 * 1. EarthDetailController LOD transitions and zoom thresholds.
 * 2. Coordinate and distance translation between Three.js and Google Earth.
 * 3. GoogleEarthProvider contract and interface adherence.
 * 4. Krisha Agent Tools (globe.show, globe.fly_to, globe.zoom_detail, globe.max_detail, globe.reset_view).
 */
import { EarthDetailController } from '../src/components/globe/providers/EarthDetailController';
import { GoogleEarthProvider } from '../src/components/globe/providers/GoogleEarthProvider';
import { createGlobeTools } from '../src/agent/globeTools';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function runTests() {
  console.log('--- 1. Testing EarthDetailController LOD & Thresholds ---');
  const controller = new EarthDetailController('threejs');
  assert(controller.getActiveMode() === 'threejs', 'Initial mode is threejs (orbital globe)');
  assert(controller.getDetailLevel() === 'globe', 'Initial detail level is globe');

  // Three.js camera distance: Far orbit (> 140) should keep Three.js mode
  const stayThree = controller.evaluateThreeJsDistance(200);
  assert(!stayThree && controller.getActiveMode() === 'threejs', 'Far orbit (200) remains in Three.js mode');

  // Zooming in closer (<= 138) should trigger Google Earth mode
  const triggeredDetail = controller.evaluateThreeJsDistance(130);
  assert(triggeredDetail && controller.getActiveMode() === 'google_earth', 'Zooming closer (130) transitions to Google Earth mode');

  // Inside Google Earth: Test LOD ranges
  controller.evaluateGoogleEarthRange(500000); // 500km
  assert(controller.getDetailLevel() === 'regional', 'Range 500km is regional detail');

  controller.evaluateGoogleEarthRange(45000); // 45km
  assert(controller.getDetailLevel() === 'city', 'Range 45km is city 3D detail');

  controller.evaluateGoogleEarthRange(4000); // 4km
  assert(controller.getDetailLevel() === 'photorealistic_3d', 'Range 4km triggers photorealistic 3D building/terrain mesh');

  // Moving and panning around the globe updates detail without exiting Google Earth
  const panStay = controller.evaluateGoogleEarthRange(5000000);
  assert(!panStay && controller.getActiveMode() === 'google_earth', 'Panning/moving around the globe does NOT exit Google Earth');

  // Zooming out past outer space threshold (>= 25,000,000m) should return to Three.js globe
  const backToThree = controller.evaluateZoomOut(26000000);
  assert(backToThree && controller.getActiveMode() === 'threejs', 'Zooming out to outer space (26,000km) returns to Three.js globe view');
  assert(controller.getDetailLevel() === 'globe', 'Returned detail level is globe overview');

  console.log('\n--- 2. Testing Spatial & Distance Transformations ---');
  const testCoords = { lat: 19.076, lng: 72.8777, altitude: 10 }; // Mumbai
  const googleCam = EarthDetailController.threeCoordsToGoogleCamera(testCoords, 120);
  assert(googleCam.lat === 19.076 && googleCam.lng === 72.8777, 'Latitude/longitude preserved in Google camera');
  assert(googleCam.rangeMeters > 0, 'Google camera range is computed in real meters');
  assert(googleCam.tilt > 0, 'High zoom applies cinematic tilt');

  const threeDist = EarthDetailController.googleCameraToThreeDistance(googleCam);
  assert(threeDist >= 115 && threeDist <= 320, 'Three.js distance mapped within valid bounds [115, 320]');

  console.log('\n--- 3. Testing GoogleEarthProvider Contract ---');
  const provider = new GoogleEarthProvider();
  assert(provider.id === 'google_earth', 'Provider ID is google_earth');
  assert(provider.isAvailable(), 'Provider detects API key availability');
  const status = provider.getStatus();
  assert(typeof status.isReady === 'boolean', 'Status reports isReady boolean');
  assert(status.detailLevel === 'globe', 'Initial provider detail level is globe');

  console.log('\n--- 4. Testing Krisha Agent Globe Tools ---');
  const tools = createGlobeTools();
  const toolNames = tools.map((t) => t.name);

  assert(toolNames.includes('globe.show'), 'Has globe.show tool');
  assert(toolNames.includes('globe.fly_to'), 'Has globe.fly_to tool');
  assert(toolNames.includes('globe.zoom_detail'), 'Has globe.zoom_detail tool');
  assert(toolNames.includes('globe.max_detail'), 'Has globe.max_detail tool');
  assert(toolNames.includes('globe.reset_view'), 'Has globe.reset_view tool');

  // Test "Krisha, show Mumbai" -> fly_to
  const flyToTool = tools.find((t) => t.name === 'globe.fly_to')!;
  const flyResult = await flyToTool.execute({ locationName: 'Mumbai', lat: 19.076, lng: 72.8777 }, {} as any);
  assert(flyResult.success, 'globe.fly_to succeeds for Mumbai');
  assert(
    (flyResult as any).ui?.[0]?.modal === 'globe' &&
      (flyResult as any).ui?.[1]?.action?.type === 'fly_to',
    'globe.fly_to dispatches open_modal and fly_to action'
  );

  // Test "Zoom into Mumbai" -> zoom_detail
  const zoomDetailTool = tools.find((t) => t.name === 'globe.zoom_detail')!;
  const zoomResult = await zoomDetailTool.execute({ locationName: 'Mumbai', lat: 19.076, lng: 72.8777, detailLevel: 'city' }, {} as any);
  assert(zoomResult.success, 'globe.zoom_detail succeeds');
  const zoomAction = (zoomResult as any).ui?.[1]?.action;
  assert(zoomAction?.type === 'zoom_detail', 'Action type is zoom_detail');
  assert(zoomAction?.detailLevel === 'city', 'Detail level is city');
  assert(zoomAction?.zoom <= 125, 'Zoom distance is close enough to engage Google Earth');

  // Test "Show this place in maximum available detail" -> max_detail
  const maxDetailTool = tools.find((t) => t.name === 'globe.max_detail')!;
  const maxResult = await maxDetailTool.execute({}, {} as any);
  assert(maxResult.success, 'globe.max_detail succeeds');
  const maxAction = (maxResult as any).ui?.[1]?.action;
  assert(maxAction?.type === 'zoom_detail' && maxAction?.detailLevel === 'photorealistic_3d', 'Max detail specifies photorealistic_3d');

  // Test "Go back to globe view" -> reset_view
  const resetTool = tools.find((t) => t.name === 'globe.reset_view')!;
  const resetResult = await resetTool.execute({}, {} as any);
  assert(resetResult.success, 'globe.reset_view succeeds');
  const resetAction = (resetResult as any).ui?.[0]?.action;
  assert(resetAction?.type === 'reset_view', 'Action type is reset_view to return to Three.js globe');

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
