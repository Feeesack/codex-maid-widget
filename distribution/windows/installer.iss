#ifndef PayloadDir
  #error PayloadDir must point to an independently staged portable application.
#endif
#ifndef OutputDir
  #error OutputDir is required.
#endif
#ifndef AppVersion
  #error AppVersion must match the shared package version.
#endif

[Setup]
AppId={code:GetApplicationId}
AppName=Codex Maid Widget
AppVersion={#AppVersion}
AppVerName=Codex Maid Widget {#AppVersion}
AppPublisher=Codex Maid Widget contributors
DefaultDirName={localappdata}\Programs\CodexMaidWidget
DefaultGroupName=Codex Maid Widget
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
UninstallDisplayIcon={app}\Codex-Maid-Widget.exe
CreateUninstallRegKey=not IsTestMode
SetupIconFile={#PayloadDir}\resources\installer\app-icon.ico
OutputDir={#OutputDir}
OutputBaseFilename=Codex-Maid-Widget-{#AppVersion}-windows-x64-setup
Compression=lzma2/fast
SolidCompression=yes
CloseApplications=no
RestartApplications=no
WizardStyle=modern
DisableWelcomePage=no
UsePreviousLanguage=no
LicenseFile={#PayloadDir}\resources\installer\LICENSE
InfoAfterFile={#PayloadDir}\resources\installer\INSTALLATION.txt
VersionInfoVersion={#AppVersion}.0
VersionInfoDescription=Codex Maid Widget per-user installer
VersionInfoProductName=Codex Maid Widget
UninstallFilesDir={app}\uninstall

[Languages]
Name: english; MessagesFile: compiler:Default.isl

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut / 创建桌面快捷方式"; Check: not IsTestMode

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "lifecycle.ps1"; Flags: dontcopy

[Icons]
Name: "{group}\Codex Maid Widget"; Filename: "{app}\Codex-Maid-Widget.exe"; WorkingDir: "{app}"; Check: not IsTestMode
Name: "{group}\Connect Codex plugin"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\resources\integration\connect.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\Codex-Maid-Widget.exe"; Check: not IsTestMode
Name: "{group}\Disconnect Codex plugin"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\resources\integration\connect.vbs"" --remove"; WorkingDir: "{app}"; IconFilename: "{app}\Codex-Maid-Widget.exe"; Check: not IsTestMode
Name: "{group}\Installation help"; Filename: "{app}\resources\installer\INSTALLATION.txt"; Check: not IsTestMode
Name: "{group}\Uninstall Codex Maid Widget"; Filename: "{uninstallexe}"; Check: not IsTestMode
Name: "{userdesktop}\Codex Maid Widget"; Filename: "{app}\Codex-Maid-Widget.exe"; WorkingDir: "{app}"; Tasks: desktopicon; Check: not IsTestMode

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\resources\integration\connect.ps1"" -Quiet"; Description: "Connect Codex plugin / 连接 Codex 插件"; Flags: postinstall skipifsilent runhidden; Check: not IsTestMode
Filename: "{app}\Codex-Maid-Widget.exe"; Description: "Launch Codex Maid Widget / 启动挂件"; WorkingDir: "{app}"; Flags: postinstall skipifsilent nowait; Check: not IsTestMode

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\resources\installer\lifecycle.ps1"" -InstallDir ""{app}"" -Uninstall"; Flags: runhidden waituntilterminated; RunOnceId: StopInstalledWidget

[Code]
function IsTestMode: Boolean;
begin
  Result := ExpandConstant('{param:TESTMODE|0}') = '1';
end;

function GetApplicationId(Param: String): String;
begin
  if IsTestMode then
    Result := 'CodexMaidWidget.InstallerTest'
  else
    Result := 'CodexMaidWidget.Windows';
end;

function InitializeUninstall: Boolean;
var
  Answer, ResultCode: Integer;
begin
  Result := True;
  { Silent/test uninstall must never silently alter the user's Codex profile. }
  if IsTestMode or UninstallSilent then
    Exit;
  Answer := MsgBox('If you connected the optional Codex plugin, disconnect it before removing the widget to avoid missing-runtime errors.' + #13#10 +
    'Disconnect now? Other plugins and your widget settings will be kept.' + #13#10 +
    'Yes = disconnect first; No = leave Codex configuration unchanged; Cancel = keep the widget.' + #13#10#13#10 +
    '如果连接过本地 Codex 插件，请先断开，避免卸载后启动报错。现在断开吗？其他插件、挂件设置与形象均保留。' + #13#10 +
    '是：先断开；否：保留 Codex 配置继续卸载；取消：保留挂件。', mbConfirmation, MB_YESNOCANCEL);
  if Answer = IDCANCEL then begin
    Result := False;
    Exit;
  end;
  if Answer = IDYES then begin
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\resources\integration\connect.ps1') + '" -Remove -Quiet',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then begin
      MsgBox('The plugin could not be disconnected. The widget has not been uninstalled. Update Codex and retry, or remove codex-maid-widget@codex-maid-installed in Codex first.' + #13#10 +
        '插件未能断开，挂件尚未卸载。请更新 Codex 后重试，或先在 Codex 中手动卸载本项目插件。', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if IsTestMode and (CurPageID = wpSelectDir) then begin
    if (ExpandConstant('{param:DIR|}') = '') or
       (Pos('codex-maid-installer-test-', Lowercase(ExpandConstant('{app}'))) = 0) then begin
      Log('Test mode requires /DIR in an explicitly named codex-maid-installer-test-* directory.');
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\Codex-Maid-Widget.exe')) then begin
    ExtractTemporaryFile('lifecycle.ps1');
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{tmp}\lifecycle.ps1') + '" -InstallDir "' +
      ExpandConstant('{app}') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    begin
      Log('Installed widget shutdown failed; PowerShell exit code: ' + IntToStr(ResultCode));
      Result := 'Please close the installed widget and retry. / 请关闭已安装挂件后重试。';
    end;
  end;
end;
