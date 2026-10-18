import { desktopCapturer, screen } from 'electron';

// Keep screenshots bounded for predictable latency/token cost on large displays.
const MAX_CAPTURE_SIDE = 1568;
const SIZE_TOLERANCE = 4;

export interface CaptureResult {
  base64: string;
  width: number;
  height: number;
}

function uniqueMatch<T>(label: string, items: T[], predicate: (item: T) => boolean): T | undefined {
  const matches = items.filter(predicate);
  if (matches.length > 1)
    throw new Error(`Ambiguous screen source: ${label} matched ${matches.length} sources`);
  return matches[0];
}

export async function captureScreen(): Promise<CaptureResult> {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  // Display dimensions are DIP; request native pixels so high-DPI displays are not blurry.
  const targetWidth = Math.round(display.size.width * display.scaleFactor);
  const targetHeight = Math.round(display.size.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetWidth, height: targetHeight },
  });
  if (sources.length === 0) throw new Error('No screen source available for capture');

  const byId = uniqueMatch(
    'display id',
    sources,
    (source) => source.display_id === String(display.id),
  );
  const byName = byId
    ? undefined
    : uniqueMatch(
        'display name',
        sources,
        (source) => Boolean(display.label) && source.name === display.label,
      );
  const bySize =
    byId || byName
      ? undefined
      : uniqueMatch('display dimensions', sources, (source) => {
          const size = source.thumbnail.getSize();
          return (
            Math.abs(size.width - targetWidth) < SIZE_TOLERANCE &&
            Math.abs(size.height - targetHeight) < SIZE_TOLERANCE
          );
        });
  const source = byId ?? byName ?? bySize;
  if (!source) throw new Error(`Unable to uniquely identify display ${String(display.id)}`);

  const originalSize = source.thumbnail.getSize();
  if (originalSize.width <= 0 || originalSize.height <= 0) {
    throw new Error('Screen source returned an empty thumbnail');
  }
  const scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(originalSize.width, originalSize.height));
  const resized =
    scale < 1
      ? source.thumbnail.resize({
          width: Math.max(1, Math.floor(originalSize.width * scale)),
          height: Math.max(1, Math.floor(originalSize.height * scale)),
        })
      : source.thumbnail;
  const finalSize = resized.getSize();
  if (finalSize.width <= 0 || finalSize.height <= 0) {
    throw new Error('Screen source returned an empty resized thumbnail');
  }

  return {
    base64: resized.toPNG().toString('base64'),
    width: finalSize.width,
    height: finalSize.height,
  };
}
