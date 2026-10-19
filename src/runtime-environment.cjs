'use strict';
const path = require('node:path');
const { environmentValue } = require('./codex-cli.cjs');

// Explorer and launchd do not inherit the requesting process's environment.
// Carry only these explicit, non-secret path overrides. Never serialize PATH,
// credentials, authentication data or the rest of the parent's environment.
const OVERRIDES = Object.freeze([
  ['CODEX_HOME', '--codex-home='],
  ['CODEX_MAID_CODEX_PATH', '--codex-cli='],
]);
function checked(value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new TypeError('Invalid runtime path override');
  return value;
}
function runtimeEnvironmentArguments(args = [], env = process.env, platform = process.platform) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new TypeError('Invalid runtime arguments');
  const result = [...args];
  for (const [key, flag] of OVERRIDES) {
    const override = environmentValue(env, key, platform);
    if (result.some(value => value.startsWith(flag)) || override === undefined || override === '') continue;
    let value = checked(override);
    // Resolve relative directories before the launcher changes cwd. A bare CLI
    // command retains PATH semantics; explicit relative CLI paths are anchored.
    if (key === 'CODEX_HOME' || /[\\/]/.test(value)) value = path.resolve(value);
    result.push(flag + value);
  }
  return result;
}
function applyRuntimeEnvironmentArguments(args = [], env = process.env) {
  for (const [key, flag] of OVERRIDES) {
    const argument = args.find(value => typeof value === 'string' && value.startsWith(flag));
    if (argument !== undefined) env[key] = checked(argument.slice(flag.length));
  }
  return env;
}

module.exports = { runtimeEnvironmentArguments, applyRuntimeEnvironmentArguments };
