/**
 * Lightweight screen-change detection (Phase 4, spec §9–10).
 * Downsampled block luminance signatures — cheap enough to run on every
 * observation without heavy image processing.
 */
import type { Bounds, CapturedFrame, ScreenSignature, ScreenChangeResult } from './visionTypes';

const DEFAULT_GRID_W = 32;
const DEFAULT_GRID_H = 18;
/** Luminance delta (0-255) per block above which a block counts as changed. */
const CHANGE_THRESHOLD = 6;

export function computeBlockSignature(frame: CapturedFrame, gridW = DEFAULT_GRID_W, gridH = DEFAULT_GRID_H): ScreenSignature {
  const { width, height, data } = frame;
  const blocks: number[] = new Array(gridW * gridH).fill(0);
  const counts: number[] = new Array(gridW * gridH).fill(0);

  // Sample sparsely — at most every 2nd pixel in each axis keeps this O(w*h/4).
  const stepX = Math.max(1, Math.floor(width / (gridW * 4)));
  const stepY = Math.max(1, Math.floor(height / (gridH * 4)));

  for (let y = 0; y < height; y += stepY) {
    const gy = Math.min(gridH - 1, Math.floor((y / height) * gridH));
    for (let x = 0; x < width; x += stepX) {
      const gx = Math.min(gridW - 1, Math.floor((x / width) * gridW));
      const i = (y * width + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      blocks[gy * gridW + gx] += lum;
      counts[gy * gridW + gx] += 1;
    }
  }

  for (let b = 0; b < blocks.length; b++) {
    blocks[b] = counts[b] > 0 ? blocks[b] / counts[b] : 0;
  }

  return { gridW, gridH, blocks: blocks.map((b) => Math.round(b * 10) / 10) };
}

/** Connected-component bounding boxes over the changed cells, normalized 0..1. */
function clusterRegions(changed: boolean[], gridW: number, gridH: number, maxRegions = 5): Bounds[] {
  const visited = new Array(changed.length).fill(false);
  const regions: Bounds[] = [];

  const floodFill = (start: number) => {
    const stack = [start];
    let minX = gridW, minY = gridH, maxX = -1, maxY = -1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      if (visited[idx] || !changed[idx]) continue;
      visited[idx] = true;
      const x = idx % gridW;
      const y = Math.floor(idx / gridW);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) stack.push(idx - 1);
      if (x < gridW - 1) stack.push(idx + 1);
      if (y > 0) stack.push(idx - gridW);
      if (y < gridH - 1) stack.push(idx + gridW);
    }
    if (maxX === -1) return;
    regions.push({
      x: minX / gridW,
      y: minY / gridH,
      width: (maxX - minX + 1) / gridW,
      height: (maxY - minY + 1) / gridH,
    });
  };

  for (let i = 0; i < changed.length; i++) {
    if (changed[i] && !visited[i]) floodFill(i);
  }
  return regions.slice(0, maxRegions);
}

export function compareSignatures(previous: ScreenSignature, current: ScreenSignature): ScreenChangeResult {
  const sameGrid = previous.gridW === current.gridW && previous.gridH === current.gridH;
  if (!sameGrid) {
    return {
      changed: true,
      changedFraction: 1,
      changedBlocks: current.blocks.length,
      totalBlocks: current.blocks.length,
      regions: [{ x: 0, y: 0, width: 1, height: 1 }],
      currentTimestamp: Date.now(),
    };
  }

  let changedBlocks = 0;
  const changed: boolean[] = new Array(previous.blocks.length).fill(false);
  for (let i = 0; i < previous.blocks.length; i++) {
    if (Math.abs(previous.blocks[i] - current.blocks[i]) > CHANGE_THRESHOLD) {
      changed[i] = true;
      changedBlocks++;
    }
  }

  const totalBlocks = previous.blocks.length;
  const changedFraction = changedBlocks / totalBlocks;
  return {
    changed: changedBlocks > 0,
    changedFraction: Math.round(changedFraction * 1000) / 1000,
    changedBlocks,
    totalBlocks,
    regions: changedBlocks > 0 ? clusterRegions(changed, current.gridW, current.gridH) : [],
    currentTimestamp: Date.now(),
  };
}
