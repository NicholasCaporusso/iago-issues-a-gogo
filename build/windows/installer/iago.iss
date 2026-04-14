[Setup]
AppId=IAGO
AppName=IAGO
AppVersion=1.0.0
AppVerName=IAGO
AppPublisher=IAGO
DefaultDirName={autopf}\IAGO
DefaultGroupName=IAGO
OutputDir=..\..\..\dist\windows\installer
OutputBaseFilename=iago-setup
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
ChangesEnvironment=yes
SetupIconFile=..\..\..\iago-icon.ico
UninstallDisplayIcon={app}\bin\iago-server.exe
DisableProgramGroupPage=yes

[Tasks]
Name: "startup"; Description: "Run IAGO server at startup"; GroupDescription: "Optional tasks:"; Flags: unchecked

[Files]
Source: "..\..\..\dist\rust\cli\iago.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "..\..\..\dist\rust\server\iago-server.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "..\..\..\relay-config.json"; DestDir: "{app}"; Flags: ignoreversion onlyifdoesntexist
Source: "..\..\..\iago-icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\bin"; Check: NeedsPathUpdate
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "IAGO Server"; ValueData: """{app}\bin\iago-server.exe"" serve"; Tasks: startup

[Icons]
Name: "{autoprograms}\IAGO"; Filename: "{app}\bin\iago.exe"
Name: "{autoprograms}\IAGO Server"; Filename: "{app}\bin\iago-server.exe"; Parameters: "repl"

[Code]
function NeedsPathUpdate(): Boolean;
var
  ExistingPath: string;
begin
  if RegQueryStringValue(HKLM, 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment', 'Path', ExistingPath) then
    Result := Pos(ExpandConstant('{app}\bin'), ExistingPath) = 0
  else
    Result := True;
end;
