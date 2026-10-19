'use strict';
const path = require('node:path');
const displayText = (value, maximum = 160) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, maximum) : '';

function workspaceDisplay(cwd) {
  if (typeof cwd !== 'string' || cwd.includes('\0')) return {};
  const flavor = /^[a-zA-Z]:[\\/]|^\\\\/.test(cwd) ? path.win32 : path.posix;
  if (!flavor.isAbsolute(cwd)) return {};
  const normalized = flavor.normalize(cwd), directory = normalized.replace(/[\\/]+$/, '');
  const name = flavor.basename(directory) || flavor.parse(normalized).root;
  return { label: displayText(name), detail: displayText(normalized, 2048) };
}

module.exports = { displayText, workspaceDisplay };
