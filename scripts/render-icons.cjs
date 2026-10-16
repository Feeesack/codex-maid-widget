'use strict';
// Generate all shipped sizes from the approved PNG master. The app loads only
// ready-made icons; this canvas rendering never runs at startup or while polling.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'maid-icon-render-')));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    const master = fs.readFileSync(path.join(root, 'assets/app-icon-master.png')).toString('base64');
    await win.loadURL('about:blank');
    // Decode once and retain the full composition, including both dragon horns.
    // Progressive resizing gives Chromium's high-quality sampler useful source
    // pixels at each step, especially for the small Windows notification icons.
    const masterSize = await win.webContents.executeJavaScript(`(async()=>{
      const image = new Image();
      image.src = 'data:image/png;base64,${master}';
      await image.decode();
      if (image.naturalWidth !== image.naturalHeight || image.naturalWidth < 512) {
        throw new Error('Icon master must be square and at least 512 pixels.');
      }
      window.iconMaster = image;
      return image.naturalWidth;
    })()`);
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
    const entries = [];
    const directory = path.join(root, 'assets/icons');
    fs.mkdirSync(directory, { recursive: true });
    const render = async (size) => {
      const encoded = await win.webContents.executeJavaScript(`(async()=>{
        let source = window.iconMaster;
        let sourceSize = ${masterSize};
        const resize = (targetSize) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = targetSize;
          const context = canvas.getContext('2d');
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          context.drawImage(source, 0, 0, targetSize, targetSize);
          source = canvas;
          sourceSize = targetSize;
        };
        while (sourceSize > ${size} * 2) resize(Math.ceil(sourceSize / 2));
        resize(${size});
        return source.toDataURL('image/png').split(',')[1];
      })()`);
      return Buffer.from(encoded, 'base64');
    };
    for (const size of [...sizes, 512]) {
      const png = await render(size);
      fs.writeFileSync(path.join(directory, `app-${size}.png`), png);
      if (size <= 48) {
        // Keep one visual identity at every entry point. Windows selects its
        // native DPI-sized ICO entry instead of enlarging a single 16px image.
        fs.writeFileSync(path.join(directory, `tray-${size}.png`), png);
      }
      if (size <= 256) entries.push({ size, png });
    }
    // ICO with independently rasterized PNG entries, supported by modern Windows.
    const header = Buffer.alloc(6 + entries.length * 16);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
    let offset = header.length;
    for (const [index, { size, png }] of entries.entries()) {
      const position = 6 + index * 16;
      header[position] = header[position + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, position + 4); header.writeUInt16LE(32, position + 6);
      header.writeUInt32LE(png.length, position + 8); header.writeUInt32LE(offset, position + 12);
      offset += png.length;
    }
    fs.writeFileSync(path.join(root, 'assets/app-icon.ico'), Buffer.concat([header, ...entries.map(entry => entry.png)]));
    console.log('Rendered PNG master into 10 app PNGs, 6 tray PNGs and a 9-size Windows ICO.');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
