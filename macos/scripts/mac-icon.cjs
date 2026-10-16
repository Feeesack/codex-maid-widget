'use strict';
// ICNS is a binary container. Reuse the approved transparent PNGs byte for byte.
const fs = require('node:fs');
const path = require('node:path');
const ICON_TYPES = new Map([[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09']]);
function pngSize(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid PNG icon');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
function createIcns(entries) {
  const chunks = entries.map(({ size, png }) => {
    const { width, height } = pngSize(png);
    if (!ICON_TYPES.has(size) || width !== size || height !== size) throw new Error(`Invalid ICNS PNG size ${size}: ${width}x${height}`);
    const header = Buffer.alloc(8); header.write(ICON_TYPES.get(size), 0, 4, 'ascii'); header.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8); header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}
function writeMacIcon(root = path.resolve(__dirname, '..')) {
  const entries = [...ICON_TYPES.keys()].map(size => ({ size, png: fs.readFileSync(path.join(root, 'assets', 'icons', `app-${size}.png`)) }));
  const output = path.join(root, 'assets', 'app-icon.icns'); const icon = createIcns(entries);
  if (!fs.existsSync(output) || !fs.readFileSync(output).equals(icon)) fs.writeFileSync(output, icon);
  return output;
}
if (require.main === module) console.log('Wrote macOS icon: ' + writeMacIcon());
module.exports = { ICON_TYPES, pngSize, createIcns, writeMacIcon };
