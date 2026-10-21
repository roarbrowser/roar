; Roar's Windows installer: Program Files, Start menu, and an uninstaller in Settings > Apps that asks
; whether to keep the data in %APPDATA%\Roar (logins, tabs) and takes Roar out of agent configs.
; CI: iscc /DVersion=0.29.1 /DArch=x64 /DSource=<build dir> scripts\roar.iss (Arch x64 or arm64)
#if Arch == "x64"
  #define Allowed "x64compatible"
#else
  #define Allowed "arm64"
#endif

[Setup]
AppId={{53681F80-B069-4BA3-8CC2-AB85DEDC2A57}
AppName=Roar
AppVersion={#Version}
AppPublisher=Roar
AppPublisherURL=https://github.com/roarbrowser/roar
DefaultDirName={autopf}\Roar
DefaultGroupName=Roar
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed={#Allowed}
ArchitecturesInstallIn64BitMode={#Allowed}
OutputBaseFilename=Roar-windows-{#Arch}-setup
OutputDir=.
Compression=lzma2/max
SolidCompression=yes
UninstallDisplayIcon={app}\Roar.exe
SetupIconFile=..\resources\roar.ico
CloseApplications=yes
WizardStyle=modern

[Files]
Source: "{#Source}\*"; DestDir: "{app}"; Excludes: "\THIRD_PARTY_NOTICES.txt,\CREDITS.html"; Flags: recursesubdirs ignoreversion
; Open-source license notices (scripts/build.ps1), opened from Settings.
Source: "{#Source}\THIRD_PARTY_NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Source}\CREDITS.html"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Roar"; Filename: "{app}\Roar.exe"; AppUserModelID: "Roar.Browser"
Name: "{autodesktop}\Roar"; Filename: "{app}\Roar.exe"; AppUserModelID: "Roar.Browser"; Tasks: desktopicon

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\Roar.exe"; Description: "Open Roar"; Flags: nowait postinstall skipifsilent
; WinSparkle runs this installer with /SILENT, which skips the line above: reopen Roar after an in-app update.
Filename: "{app}\Roar.exe"; Flags: nowait skipifnotsilent runasoriginaluser

[UninstallRun]
; Takes Roar's MCP server and session hooks out of agent configs, with a backup beside each file (mcp/uninstall.mjs).
Filename: "{app}\roar-mcp.exe"; Parameters: "uninstall-agents"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "RoarAgents"

[Code]
var
  DeleteData: Boolean;

function InitializeUninstall(): Boolean;
begin
  // Keeping the data is the default, and the only choice in a silent uninstall.
  DeleteData := (not UninstallSilent) and (MsgBox('Keep your Roar data (logins, tabs)?' + #13#13 +
    'Choose No to also delete your profiles, cookies, tabs, spaces, settings and the API keys saved for model chat.',
    mbConfirmation, MB_YESNO) = IDNO);
  Result := True;
end;

procedure DelDirs(const Dir, Pattern: String);
var
  F: TFindRec;
begin
  if FindFirst(Dir + '\' + Pattern, F) then
    try
      repeat
        if (F.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then DelTree(Dir + '\' + F.Name, True, True, True);
      until not FindNext(F);
    finally
      FindClose(F);
    end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Roar');  // WinSparkle's update settings.
  if not DeleteData then Exit;
  DelDirs(ExpandConstant('{userappdata}'), 'Roar');    // Profiles, state.json, cdp-port, instance.lock.
  DelDirs(ExpandConstant('{userappdata}'), 'Roar-*');  // Other instances.
  DelDirs(ExpandConstant('{%USERPROFILE}'), '.roar-headless');
  // Model chat API keys: one generic credential per provider, "Roar model chat/<id>".
  Exec('powershell.exe', '-NoProfile -NonInteractive -Command "cmdkey /list | Select-String ''target=(Roar model chat/.+)$'' | ' +
    'ForEach-Object { cmdkey (''/delete:'' + $_.Matches[0].Groups[1].Value.Trim()) }"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;
