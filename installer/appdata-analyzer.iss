; Installeur Inno Setup pour AppData Analyzer (grand public).
; Compiler avec Inno Setup 6 (https://jrsoftware.org/isinfo.php) :
;   iscc installer\appdata-analyzer.iss
; Prérequis : avoir généré dist\appdata-analyzer.exe (npm run build:exe).
;
; Choix : installation par utilisateur (pas d'admin requis pour installer),
; raccourcis Menu Démarrer + Bureau (optionnel), désinstallation propre.

#define AppName "Nettoyeur d'espace disque"
#define AppVersion "2.0.0"
#define AppExe "appdata-analyzer.exe"

[Setup]
AppId={{B7E31F0C-9A44-4E1B-8E2D-AA57C1D24F91}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Umbra Labs
AppPublisherURL=https://www.academy.umbra-labs.dev/
AppSupportURL=https://github.com/umbra-labs/nettoyeur-espace-disque
DefaultDirName={userpf}\AppDataAnalyzer
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=nettoyeur-espace-disque-setup
Compression=lzma2
SolidCompression=yes
DisableProgramGroupPage=yes
; SetupIconFile=icon.ico          ; à fournir pour une icône personnalisée
; SignTool=signtool               ; à configurer une fois le certificat acheté

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "Créer une icône sur le Bureau"; GroupDescription: "Raccourcis :"

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
