; Installeur Inno Setup pour GhostTrace (grand public).
; Compiler avec Inno Setup 6 (https://jrsoftware.org/isinfo.php) :
;   iscc installer\appdata-analyzer.iss
; Prérequis : avoir généré dist\ghosttrace.exe (npm run build:exe).
;
; Choix : installation par utilisateur (pas d'admin requis pour installer),
; raccourcis Menu Démarrer + Bureau (optionnel), désinstallation propre.

#define AppName "GhostTrace"
#define AppVersion "2.1.5"
#define AppExe "ghosttrace.exe"

[Setup]
AppId={{B7E31F0C-9A44-4E1B-8E2D-AA57C1D24F91}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Umbra Labs
AppPublisherURL=https://www.academy.umbra-labs.dev/
AppSupportURL=https://github.com/umbralabsaccademy-droid/drive-cleaner
DefaultDirName={userpf}\GhostTrace
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=ghosttrace-setup
Compression=lzma2
SolidCompression=yes
DisableProgramGroupPage=yes
SetupIconFile=..\assets\logo.ico
; SignTool=signtool               ; à configurer une fois le certificat acheté

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Lancer {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Les rapports générés à côté de l'exe sont supprimés à la désinstallation
Type: filesandordirs; Name: "{app}\reports"
