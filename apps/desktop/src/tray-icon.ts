import { nativeImage, type NativeImage } from "electron";
import { TOUCH_ICON_180_PNG_BASE64 } from "../../../src/cli/serve/brand";

export function createAgentUseTrayIcon(): NativeImage {
  // NativeImage's PNG decoder is reliable across packaged Electron versions.
  const dataUrl = `data:image/png;base64,${TOUCH_ICON_180_PNG_BASE64}`;
  const size = 18;
  const source = nativeImage.createFromDataURL(dataUrl).resize({ width: size, height: size });
  const bitmap = source.toBitmap();
  // The canonical touch icon is a white mark on an opaque dark tile. A macOS
  // template image uses alpha as its mask, so translate brightness to alpha
  // and remove the tile while preserving the antialiased A silhouette.
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const coverage = Math.max(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]);
    bitmap[offset] = 0;
    bitmap[offset + 1] = 0;
    bitmap[offset + 2] = 0;
    bitmap[offset + 3] = coverage;
  }
  const icon = nativeImage.createFromBitmap(bitmap, { width: size, height: size, scaleFactor: 1 });
  // Template images let macOS apply the correct menu bar color in both themes.
  icon.setTemplateImage(true);
  return icon;
}
