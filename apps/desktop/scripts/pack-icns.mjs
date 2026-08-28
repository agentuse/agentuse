import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [iconsetDirectory, outputPath] = process.argv.slice(2);

if (!iconsetDirectory || !outputPath) {
  throw new Error("Usage: node pack-icns.mjs <iconset-directory> <output.icns>");
}

// Modern ICNS entries contain PNG payloads directly. Packing only the
// standard representations avoids the broken synthesized 48 px legacy icon
// produced by Electron Builder's converter on current macOS releases.
const entries = [
  ["ic04", "icon_16x16.png"],
  ["ic11", "icon_16x16@2x.png"],
  ["ic05", "icon_32x32.png"],
  ["ic12", "icon_32x32@2x.png"],
  ["ic07", "icon_128x128.png"],
  ["ic13", "icon_128x128@2x.png"],
  ["ic08", "icon_256x256.png"],
  ["ic14", "icon_256x256@2x.png"],
  ["ic09", "icon_512x512.png"],
  ["ic10", "icon_512x512@2x.png"],
];

const chunks = entries.map(([type, filename]) => {
  const png = readFileSync(join(iconsetDirectory, filename));
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(header.length + png.length, 4);
  return Buffer.concat([header, png]);
});

const header = Buffer.alloc(8);
header.write("icns", 0, 4, "ascii");
header.writeUInt32BE(header.length + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
writeFileSync(outputPath, Buffer.concat([header, ...chunks]));
