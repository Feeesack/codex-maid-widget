'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RULES, classifyCodexDesktop } = require('../src/codex-identity.cjs');
const { INVENTORY_WORKER_SCRIPT } = require('../src/windows-inventory.cjs');

const family = RULES.packageFamily;
const localA = 'C:\\Users\\Fixture-A\\AppData\\Local';
const localB = 'E:\\测试用户\\Local Data';
const packageDirectory = 'OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0';
const vectors = [
  ['system package volume', `C:\\Program Files\\WindowsApps\\${packageDirectory}\\app\\ChatGPT.exe`, family, localA, true],
  ['reported non-system package volume', `D:\\WindowsApps\\${packageDirectory}\\app\\ChatGPT.exe`, family, localB, true],
  ['independent mount location', 'F:\\MountedPackages\\Codex\\app\\Codex.exe', family, localA, true],
  ['extended drive path and case', `\\\\?\\d:\\WINDOWSAPPS\\${packageDirectory}\\APP\\CHATGPT.EXE`, family.toUpperCase(), localA, true],
  ['volume GUID alias', `\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\WindowsApps\\${packageDirectory}\\app\\ChatGPT.exe`, family, localA, true],
  ['UNC volume alias', '\\\\fixture-server\\package-volume\\app\\ChatGPT.exe', family, localB, true],
  ['wrong publisher', `D:\\WindowsApps\\${packageDirectory}\\app\\ChatGPT.exe`, 'OpenAI.Codex_otherpublisher', localA, false],
  ['different OpenAI package', `D:\\WindowsApps\\${packageDirectory}\\app\\ChatGPT.exe`, 'OpenAI.ChatGPT_2p2nqsd0c76g0', localA, false],
  ['package-looking directory has no identity', `D:\\WindowsApps\\${packageDirectory}\\app\\ChatGPT.exe`, null, localA, false],
  ['a same-named EXE is not sufficient', 'D:\\tools\\app\\ChatGPT.exe', null, localA, false],
  ['embedded packaged CLI', `D:\\WindowsApps\\${packageDirectory}\\app\\resources\\codex.exe`, family, localA, false],
  ['bin CLI', `D:\\WindowsApps\\${packageDirectory}\\bin\\codex.exe`, family, localA, false],
  ['executable suffix spoof', 'E:\\package\\app\\ChatGPT.exe.bak', family, localA, false],
  ['relative path is invalid', 'app\\ChatGPT.exe', family, localA, false],
  ['dot traversal is invalid', 'E:\\untrusted\\..\\app\\ChatGPT.exe', family, localA, false],
  ['NUL path is invalid', 'E:\\package\0\\app\\ChatGPT.exe', family, localA, false],
  ['first unpackaged user', `${localA}\\Programs\\OpenAI\\Codex\\ChatGPT.exe`, null, localA, true],
  ['second user with relocated profile', `${localB}\\Programs\\OpenAI Codex\\app\\Codex.exe`, null, localB, true],
  ['extended unpackaged user path', `\\\\?\\${localB}\\Programs\\Codex\\ChatGPT.exe`, null, localB, true],
  ['other user cannot provide a fallback', `${localA}\\Programs\\OpenAI\\Codex\\ChatGPT.exe`, null, localB, false],
  ['user-installed CLI is not the desktop', `${localA}\\Programs\\OpenAI\\Codex\\bin\\codex.exe`, null, localA, false],
  ['package mismatch cannot fall back to a user directory', `${localA}\\Programs\\Codex\\Codex.exe`, 'Other.Package_publisher', localA, false],
  ['missing user root cannot use the host profile', `${localA}\\Programs\\Codex\\Codex.exe`, null, '', false],
];

test('verified process identity supports multiple users and package volumes without trusting path-shaped identities', () => {
  for (const [name, file, packageFamilyName, localAppData, expected] of vectors)
    assert.equal(classifyCodexDesktop({ path: file, packageFamilyName }, { localAppData }), expected, name);
  for (const packageFamilyName of [undefined, '', 42])
    assert.equal(classifyCodexDesktop({ path: `${localA}\\Programs\\Codex\\Codex.exe`, packageFamilyName }, { localAppData: localA }), null,
      'unknown package identity must not fall back or become a confirmed absence');
});

test('the actual native inventory compiles and uses the same identity vectors as JavaScript without enumerating host processes', { skip: process.platform !== 'win32' }, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-identity-native-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const data = Buffer.from(JSON.stringify(vectors.map(([, file, packageFamilyName, localAppData]) => ({ file, packageFamilyName, packaged: packageFamilyName !== null, localAppData })))).toString('base64');
  // Only compile the production types and invoke their pure classifier. Do not
  // call MaidWindowsInventory.Query or inspect any actual user/installation.
  const prefix = INVENTORY_WORKER_SCRIPT.slice(0, INVENTORY_WORKER_SCRIPT.indexOf('while ($null -ne ($request')).replace(/'@\r?\n$/, `
public static class IsolatedIdentityFixture {
    public static bool Classify(string file, string family, bool packaged, string local) {
        // PowerShell converts a null string argument to an empty string. Keep
        // the production API's C# null (confirmed NO_PACKAGE) in this adapter.
        return MaidCodexIdentity.IsOfficialDesktop(file, packaged ? family : null, local);
    }
}
'@\n`);
  const script = prefix.replace('Add-Type -TypeDefinition', "[Console]::Error.WriteLine('MAID_IDENTITY_PHASE compiling ' + $fixtureClock.ElapsedMilliseconds)\nAdd-Type -TypeDefinition") + `
[Console]::Error.WriteLine('MAID_IDENTITY_PHASE compiled ' + $fixtureClock.ElapsedMilliseconds)
$vectors = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')))
$results = @()
foreach ($vector in $vectors) { $results += [IsolatedIdentityFixture]::Classify($vector.file, $vector.packageFamilyName, $vector.packaged, $vector.localAppData) }
ConvertTo-Json -InputObject @($results) -Compress
[Console]::Error.WriteLine('MAID_IDENTITY_PHASE classified ' + $fixtureClock.ElapsedMilliseconds)
`;
  // CreateProcess's command-line limit also applies to the persistent host.
  assert.ok(Buffer.from(INVENTORY_WORKER_SCRIPT, 'utf16le').toString('base64').length + 512 < 32767);
  // The vector payload is larger than a normal query; pass it on stdin to keep
  // this independent from the command-line size of the test fixture itself.
  const bootstrap = "$fixtureClock = [Diagnostics.Stopwatch]::StartNew(); [Console]::Error.WriteLine('MAID_IDENTITY_PHASE bootstrap 0'); $ProgressPreference = 'SilentlyContinue'; [Console]::InputEncoding = New-Object Text.UTF8Encoding($false); Invoke-Expression ([Console]::In.ReadToEnd())";
  let output;
  try {
    output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], {
      input: script, cwd: temporary, windowsHide: true, timeout: 20000, encoding: 'utf8',
      env: { ...process.env, TEMP: temporary, TMP: temporary, CODEX_MAID_DATA_DIR: temporary }, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const phases = String(error.stderr || '').match(/MAID_IDENTITY_PHASE (?:bootstrap|compiling|compiled|classified) \d+/g) || [];
    // Keep diagnostics restricted to fixture phases; never echo native paths,
    // environment values or arbitrary PowerShell output on a failure.
    assert.fail(`isolated native identity fixture failed (${error.code || 'process-exit'}); phases: ${phases.join(', ') || 'none'}`);
  }
  assert.deepEqual(JSON.parse(output.trim()), vectors.map(([, , , , expected]) => expected));
});

test('shared identity policy and native inventory are mirrored for the other platform', () => {
  const root = path.resolve(__dirname, '..');
  const peer = path.basename(root) === 'macos' ? path.dirname(root) : path.join(root, 'macos');
  if (!fs.existsSync(path.join(peer, 'src', 'codex-identity.cjs'))) return; // standalone source archive
  for (const file of ['codex-identity.cjs', 'windows-inventory.cjs'])
    assert.deepEqual(fs.readFileSync(path.join(root, 'src', file)), fs.readFileSync(path.join(peer, 'src', file)), file);
});
