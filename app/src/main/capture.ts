import { desktopCapturer, screen } from 'electron';

// Screenshot capture: grabs the display under the cursor (multi-monitor aware),
// downscales to a max width of 1568px to bound token cost, returns base64 PNG.
// The overlay itself is excluded by setContentProtection, so it never appears
// in its own captures.

const MAX_WIDTH = 1568;

export interface CaptureResult {
  base64: string;
  width: number;
  height: number;
}

export async function captureScreen(): Promise<CaptureResult> {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  // display.size is in DIP — multiply by scaleFactor for native resolution
  // (most Windows laptops run at 125%/150% scaling; DIP-sized captures are blurry).
  const targetWidth = Math.round(display.size.width * display.scaleFactor);
  const targetHeight = Math.round(display.size.height * display.scaleFactor);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetWidth, height: targetHeight },
  });
  if (sources.length === 0) throw new Error('No screen source available for capture');

  // Match the source to the display under the cursor. display_id doesn't line
  // up on every Windows/Electron combo, so fall back through name → size.
  const byId = sources.find((s) => s.display_id === String(display.id));
  const byName = byId ?? sources.find((s) => display.label && s.name.includes(display.label));
  const bySize =
    byName ??
    sources.find(
      (s) =>
        Math.abs(s.thumbnail.getSize().width - targetWidth) < 4 &&
        Math.abs(s.thumbnail.getSize().height - targetHeight) < 4,
    );
  const source = bySize ?? sources[0];

  const image = source.thumbnail;
  const scale = Math.min(1, MAX_WIDTH / image.getSize().width);
  const resized =
    scale < 1
      ? image.resize({
          width: Math.floor(image.getSize().width * scale),
          height: Math.floor(image.getSize().height * scale),
        })
      : image;

  return {
    base64: resized.toPNG().toString('base64'),
    width: resized.getSize().width,
    height: resized.getSize().height,
  };
}
