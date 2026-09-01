// Automatic client-side canvas alpha matting to make character backgrounds 100% transparent

const cache = new Map<string, string>();

export async function createTransparentCharacterDataUrl(
  imgSrc: string,
  options?: {
    threshold?: number;
    feather?: number;
  }
): Promise<string> {
  if (cache.has(imgSrc)) {
    return cache.get(imgSrc)!;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const w = img.naturalWidth || img.width || 400;
        const h = img.naturalHeight || img.height || 640;
        canvas.width = w;
        canvas.height = h;

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(imgSrc);
          return;
        }

        ctx.drawImage(img, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        // Sample boundary pixels (corners & top edge) to identify background signature
        const samplePoints = [
          { x: 0, y: 0 },
          { x: w - 1, y: 0 },
          { x: Math.floor(w / 2), y: 0 },
          { x: 0, y: Math.floor(h / 4) },
          { x: w - 1, y: Math.floor(h / 4) },
          { x: 0, y: h - 1 },
          { x: w - 1, y: h - 1 },
        ];

        let bgR = 0, bgG = 0, bgB = 0, count = 0;
        for (const pt of samplePoints) {
          const idx = (pt.y * w + pt.x) * 4;
          bgR += data[idx];
          bgG += data[idx + 1];
          bgB += data[idx + 2];
          count++;
        }
        bgR = Math.round(bgR / count);
        bgG = Math.round(bgG / count);
        bgB = Math.round(bgB / count);

        // BFS Flood fill from edges to remove only the outer connected background
        const visited = new Uint8Array(w * h);
        const queue: number[] = [];

        // Push all border pixels to queue
        for (let x = 0; x < w; x++) {
          queue.push(x, 0);
          queue.push(x, h - 1);
          visited[x] = 1;
          visited[(h - 1) * w + x] = 1;
        }
        for (let y = 1; y < h - 1; y++) {
          queue.push(0, y);
          queue.push(w - 1, y);
          visited[y * w] = 1;
          visited[y * w + (w - 1)] = 1;
        }

        const threshold = options?.threshold ?? 68;
        const feather = options?.feather ?? 24;

        let qIdx = 0;
        while (qIdx < queue.length) {
          const x = queue[qIdx++];
          const y = queue[qIdx++];
          const idx = (y * w + x) * 4;

          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];

          // Euclidean distance from background color
          const dist = Math.sqrt(
            Math.pow(r - bgR, 2) + Math.pow(g - bgG, 2) + Math.pow(b - bgB, 2)
          );

          if (dist < threshold) {
            // Compute smooth alpha feathering
            if (dist < threshold - feather) {
              data[idx + 3] = 0; // Fully transparent
            } else {
              const alphaRatio = (dist - (threshold - feather)) / feather;
              data[idx + 3] = Math.min(data[idx + 3], Math.round(alphaRatio * 255));
            }

            // Check 4-connected neighbors
            const neighbors = [
              { nx: x + 1, ny: y },
              { nx: x - 1, ny: y },
              { nx: x, ny: y + 1 },
              { nx: x, ny: y - 1 },
            ];

            for (const { nx, ny } of neighbors) {
              if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                const nIdx = ny * w + nx;
                if (!visited[nIdx]) {
                  visited[nIdx] = 1;
                  queue.push(nx, ny);
                }
              }
            }
          }
        }

        ctx.putImageData(imgData, 0, 0);
        const transparentDataUrl = canvas.toDataURL('image/png');
        cache.set(imgSrc, transparentDataUrl);
        resolve(transparentDataUrl);
      } catch (err) {
        console.warn('Transparent alpha matting fallback:', err);
        resolve(imgSrc);
      }
    };

    img.onerror = () => {
      resolve(imgSrc);
    };

    img.src = imgSrc;
  });
}
