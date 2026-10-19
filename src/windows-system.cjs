'use strict';
const path = require('node:path');

function powershellExecutable(env = process.env) {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'systemroot')
    || Object.keys(env).find(name => name.toLowerCase() === 'windir');
  const root = key && env[key];
  // Do not depend on a terminal/Explorer PATH, nor assume Windows is on C:.
  if (typeof root === 'string' && /^[a-z]:[\\/]/i.test(root) && !/[\0\r\n]/.test(root))
    return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return 'powershell.exe';
}

module.exports = { powershellExecutable };
