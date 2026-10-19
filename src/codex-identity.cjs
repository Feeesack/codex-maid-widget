'use strict';

// Both JavaScript and the native inventory host consume this one policy. A
// package's identity comes from Windows, never from a WindowsApps-looking path.
const RULES = Object.freeze({
  packageFamily: 'OpenAI.Codex_2p2nqsd0c76g0',
  packagedExecutable: String.raw`\\app\\(?:chatgpt|codex)\.exe$`,
  unpackagedExecutable: String.raw`^(?:openai\\codex|openai codex|codex)\\(?:app\\)?(?:chatgpt|codex)\.exe$`,
  absolutePath: String.raw`^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)`,
  traversal: String.raw`(?:^|\\)\.{1,2}(?:\\|$)`,
});

function canonicalWindowsPath(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) return '';
  let file = value.replaceAll('/', '\\');
  if (file.toLowerCase().startsWith('\\\\?\\unc\\')) file = '\\\\' + file.slice(8);
  else if (/^\\\\\?\\[a-z]:\\/i.test(file)) file = file.slice(4);
  if (!new RegExp(RULES.absolutePath, 'i').test(file) || new RegExp(RULES.traversal).test(file)) return '';
  return file.toLowerCase();
}

// null means Windows confirmed that the process has no package; undefined is
// unverified and must never become a successful empty desktop observation.
function classifyCodexDesktop({ path: value, packageFamilyName } = {}, { localAppData = process.env.LOCALAPPDATA } = {}) {
  if (packageFamilyName !== null && (typeof packageFamilyName !== 'string' || !packageFamilyName)) return null;
  const file = canonicalWindowsPath(value);
  if (!file) return false;
  if (packageFamilyName !== null) return packageFamilyName.toLowerCase() === RULES.packageFamily.toLowerCase()
    && new RegExp(RULES.packagedExecutable, 'i').test(file);
  const local = canonicalWindowsPath(localAppData);
  if (!local) return false;
  const programs = local.replace(/\\+$/, '') + '\\programs\\';
  return file.startsWith(programs) && new RegExp(RULES.unpackagedExecutable, 'i').test(file.slice(programs.length));
}

const csharpString = value => '@"' + value.replaceAll('"', '""') + '"';
const IDENTITY_CSHARP = `
public static class MaidCodexIdentity {
    static string Canonical(string value) {
        if (string.IsNullOrEmpty(value) || value.IndexOf('\\0') >= 0 || value.IndexOf('\\r') >= 0 || value.IndexOf('\\n') >= 0) return "";
        var file = value.Replace('/', '\\\\');
        if (file.StartsWith(@"\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) file = @"\\\\" + file.Substring(8);
        else if (System.Text.RegularExpressions.Regex.IsMatch(file, @"^\\\\\\\\\\?\\\\[a-z]:\\\\", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) file = file.Substring(4);
        if (!System.Text.RegularExpressions.Regex.IsMatch(file, ${csharpString(RULES.absolutePath)}, System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            || System.Text.RegularExpressions.Regex.IsMatch(file, ${csharpString(RULES.traversal)})) return "";
        return file;
    }
    public static bool IsOfficialDesktop(string value, string packageFamilyName, string localAppData) {
        var file = Canonical(value);
        if (file.Length == 0) return false;
        if (packageFamilyName != null) return string.Equals(packageFamilyName, ${csharpString(RULES.packageFamily)}, StringComparison.OrdinalIgnoreCase)
            && System.Text.RegularExpressions.Regex.IsMatch(file, ${csharpString(RULES.packagedExecutable)}, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var local = Canonical(localAppData);
        if (local.Length == 0) return false;
        var programs = local.TrimEnd('\\\\') + @"\\Programs\\";
        return file.StartsWith(programs, StringComparison.OrdinalIgnoreCase)
            && System.Text.RegularExpressions.Regex.IsMatch(file.Substring(programs.Length), ${csharpString(RULES.unpackagedExecutable)}, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }
}
`;

module.exports = { RULES, canonicalWindowsPath, classifyCodexDesktop, IDENTITY_CSHARP };
