'use strict';
const fs = require('node:fs');
const path = require('node:path');

function supportsDesktopFollow({ platform = process.platform, packaged, demo }) {
  return ['win32', 'darwin'].includes(platform) && packaged && !demo;
}

function configureMacApp(app, platform = process.platform) {
  if (platform === 'darwin') app.setActivationPolicy('accessory');
}

function configureWidgetWorkspace(widget, platform = process.platform) {
  if (platform === 'darwin') {
    // The widget is a UIElement app, so switching Spaces need not transform it
    // into a Dock application or briefly hide its transparent window.
    widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
}

function trayImage({ root, nativeImage, platform = process.platform, readFile = fs.readFileSync }) {
  if (platform === 'win32') return path.join(root, 'assets', 'app-icon.ico');
  if (platform !== 'darwin') return path.join(root, 'assets', 'icons', 'tray-32.png');
  // Keep the approved colored avatar. Separate 1x/2x/3x representations retain
  // a 16-point menu-bar size without scaling a low-resolution bitmap on Retina.
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2, 3]) {
    image.addRepresentation({ scaleFactor, buffer: readFile(path.join(root, 'assets', 'icons', `tray-${16 * scaleFactor}.png`)) });
  }
  image.setTemplateImage(false);
  return image;
}

module.exports = { supportsDesktopFollow, configureMacApp, configureWidgetWorkspace, trayImage };
