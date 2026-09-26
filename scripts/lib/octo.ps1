# scripts/lib/octo.ps1
#
# Shared implementation of the OctoSuite maintenance scripts (scripts\*.bat).
# Target: Windows PowerShell 5.1 (built into Windows 10/11) - no PS7 syntax.
# This file is saved as UTF-8 WITH BOM so Polish text is read correctly by PS 5.1.
#
# Commands:
#   open [args]            start OctoBrowser.su            (open.bat)
#   open-detect [args]     start OctoDetect.su             (open-detect.bat)
#   install [-Source dir]  verify + run the suite installer, or set up everything
#                          a development checkout needs (install.bat)
#   setup                  install prerequisites (Node.js/git via winget) + npm ci + build
#   run [-Update]          start both apps with no console window          (run.bat)
#   update [-CheckOnly]    download, verify, back up, install (update.bat)
#   github-update [-CheckOnly] update straight from GitHub Releases;   (github-update.bat)
#                          in a development checkout: git pull + npm ci + npm run build
#   start-all [-NoUpdate]  update from GitHub, then start both apps    (start-all.bat)
#   repair                 check installation + configuration (repair.bat)
#   uninstall [-DeleteData] run the uninstaller, optionally delete data (uninstall.bat)
#   reset-profile   [-Profile name|id]                     (reset-profile.bat)
#   backup-profile  [-Profile name|id] [-Destination dir]  (backup-profile.bat)
#   restore-profile [-Profile name|id] [-Archive file.zip] (restore-profile.bat)
# Common switches: -Yes (do not ask for confirmation), -Lang en|pl
#
# Security rules implemented here:
#   * paths are always quoted / passed as objects (spaces, Polish characters, '&', '!')
#   * downloads only from the official GitHub Releases URL over HTTPS (TLS 1.2+)
#   * installers are checked with SHA-256 (signed manifest / SHA256SUMS.txt),
#     Authenticode (when signed) and the Ed25519 manifest signature (via the installed
#     app's --verify-manifest mode or Node.js with scripts\lib\update-public-key.pem)
#   * logs contain no passwords, keys or tokens; the user profile path is shortened
#   * nothing is changed while an app is running (profile files are locked)
#   * archives are checked against path traversal ("zip slip") before extraction

[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)][string]$Command,
  [Alias('Profile')][string]$ProfileName,
  [string]$Source,
  [string]$Archive,
  [string]$Destination,
  [ValidateSet('en', 'pl')][string]$Lang,
  [switch]$Yes,
  [switch]$CheckOnly,
  [switch]$NoBackup,
  [switch]$DeleteData,
  [switch]$NoUpdate,
  [switch]$Update,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

# ------------------------------------------------------------------ constants
# Keep in sync with packages/core/src/appinfo.ts (OFFICIAL_REPO) - checked by tests.
$OfficialRepo = 'chargehuobey/lvocto'
$OfficialBase = "https://github.com/$OfficialRepo/releases"
$Apps = @{
  octobrowser = @{ Product = 'OctoBrowser.su'; Folder = 'OctoBrowser'; Exe = 'OctoBrowser.su.exe'; Process = 'OctoBrowser.su'; DevDir = 'apps\octobrowser' }
  octodetect  = @{ Product = 'OctoDetect.su';  Folder = 'OctoDetect';  Exe = 'OctoDetect.su.exe';  Process = 'OctoDetect.su';  DevDir = 'apps\octodetect' }
}
$ScriptsDir = Split-Path -Parent $PSScriptRoot
$InstallRoot = Split-Path -Parent $ScriptsDir

# ------------------------------------------------------------------ messages
$Messages = @{
  en = @{
    notInstalled      = '{0} is not installed next to these scripts ({1}).'
    devMode           = 'Development checkout detected - starting with Electron from node_modules.'
    notBuilt          = 'The app has not been built yet. Run "npm run build" first.'
    starting          = 'Starting {0}...'
    running           = '{0} is running. Close it (including all profile windows) and try again.'
    confirm           = 'Continue? [y/N]'
    cancelled         = 'Cancelled.'
    done              = 'Done.'
    noBootstrap       = '{0} has not been set up yet (first run not completed).'
    noInstaller       = 'No OctoSuite-Setup-*.exe found in: {0}'
    usingInstaller    = 'Installer: {0}'
    shaOk             = 'SHA-256 OK ({0})'
    shaBad            = 'SHA-256 MISMATCH - the file is damaged or was modified. Aborting.'
    shaMissing        = 'No SHA256SUMS.txt next to the installer - hash will be checked against the signed manifest only.'
    authOk            = 'Authenticode signature valid: {0}'
    authNone          = 'The installer is not code-signed (Authenticode). Relying on SHA-256 + Ed25519 manifest signature.'
    authBad           = 'Authenticode signature INVALID ({0}). Aborting.'
    sigOk             = 'Update manifest signature (Ed25519) valid - version {0}.'
    sigBad            = 'Update manifest verification FAILED (code {0}): {1}'
    sigNotConfigured  = 'This build has no update signing key - signed updates are not available.'
    sigUnavailable    = 'The Ed25519 manifest signature cannot be verified here (no installed app and no Node.js).'
    sigUnavailableAsk = 'Only SHA-256 and Authenticode were checked. Type YES to install anyway'
    noManifest        = 'latest.json / latest.json.sig not found next to the installer.'
    runInstaller      = 'Running the installer...'
    installerFailed   = 'The installer ended with code {0}.'
    sigRequired       = 'Stopped: the update signature could not be verified, so nothing was installed.'
    checking          = 'Checking for updates (official source: {0})...'
    upToDate          = 'Installed version {0} is up to date (latest: {1}).'
    updateAvailable   = 'Update available: {0} -> {1} ({2}).'
    downloading       = 'Downloading {0}...'
    urlNotOfficial    = 'Refusing a download URL outside the official releases: {0}'
    backupConfig      = 'Backing up configuration to {0}'
    keptForRollback   = 'Installer kept for rollback in {0}'
    repairStart       = 'Checking OctoSuite installation and configuration...'
    fileMissing       = 'Missing: {0}'
    filesOk           = '{0}: program files present.'
    reinstallOffer    = 'Program files are damaged. Reinstall from the newest verified installer? [y/N]'
    bootstrapBroken   = '{0}: bootstrap.json is damaged - it was renamed; the first-run wizard will reuse your data folder.'
    bootstrapOk       = '{0}: bootstrap.json OK (data: {1})'
    dataDirMissing    = '{0}: data folder does not exist: {1}'
    configOk          = '{0}: {1} OK'
    configBroken      = '{0}: {1} is damaged.'
    configRestored    = '{0}: {1} restored from backup {2}'
    configNoBackup    = '{0}: {1} - no valid backup found; the app will start with defaults.'
    tempCleared       = '{0}: temporary files removed ({1}).'
    repairSummary     = 'Repair finished: {0} problem(s) fixed, {1} remaining.'
    uninstallerMissing = 'Uninstaller not found ({0}). If you used the portable version, delete its folder manually.'
    deleteDataAsk     = 'Also DELETE all profiles, settings, reports and logs in {0}? This cannot be undone. Type DELETE to confirm'
    dataDeleted       = 'Data folder deleted: {0}'
    dataKept          = 'Your data was kept in: {0}'
    profiles          = 'Profiles:'
    profileNotFound   = 'Profile not found: {0}'
    chooseProfile     = 'Enter the profile name or number'
    resetAsk          = 'Reset profile "{0}"? Cookies, site data, history and the session are removed; settings and bookmarks are kept.'
    resetDone         = 'Profile "{0}" was reset.'
    backupUnencrypted = 'Warning: profile "{0}" is NOT encrypted - the backup contains readable cookies/logins. Store it safely.'
    backupDone        = 'Backup created: {0}'
    noArchives        = 'No backups found for profile "{0}" in {1}'
    restoreAsk        = 'Restore "{0}" from {1}? The current data is backed up first.'
    restoreDone       = 'Profile "{0}" restored.'
    zipSlip           = 'The archive contains an unsafe path ({0}). Aborting.'
    archiveHashBad    = 'The archive checksum does not match ({0}). Aborting.'
    archiveNoHash     = 'No checksum file for this archive - integrity cannot be confirmed.'
    restoreNoEntry    = 'Profile "{0}" was missing from the profile list. It will be added back automatically the next time OctoBrowser.su starts.'
    unknownCommand    = 'Unknown command: {0}'
    error             = 'Error: {0}'
    ghChecking        = 'Checking GitHub releases ({0})...'
    ghNoRelease       = 'No published release found in the official repository yet.'
    ghLatest          = 'Latest release on GitHub: {0} (published {1}).'
    ghNoAsset         = 'The release has no OctoSuite-Setup-*.exe asset for Windows x64.'
    ghUnverifiedAsk   = 'This release has no signed manifest (latest.json + latest.json.sig). Type YES to install anyway'
    ghDevDetected     = 'Development checkout detected ({0}) - updating sources from GitHub instead of installing a release.'
    ghGitMissing      = 'git was not found in PATH - a development checkout cannot be updated.'
    ghGitDirty        = 'The checkout has local changes. Commit or stash them first.'
    ghGitUpToDate     = 'Sources are already up to date ({0}).'
    ghGitPulled       = 'Sources updated: {0} -> {1}'
    ghDeps            = 'Installing dependencies (npm ci)...'
    ghBuilding        = 'Building both apps (npm run build)...'
    ghDevDone         = 'Development checkout updated and rebuilt.'
    ghNpmMissing      = 'npm was not found in PATH (Node.js >= 22.12 is required).'
    ghNpmFailed       = 'npm {0} ended with code {1}.'
    startAll          = 'Starting both applications...'
    updateSkipped     = 'Update check skipped (-NoUpdate).'
    updateFailed      = 'Update check failed ({0}) - starting the installed version.'
    prereqCheck       = 'Checking what is needed to run OctoSuite...'
    prereqOk          = '{0} found: {1}'
    prereqMissing     = '{0} is missing or too old (required: {1}).'
    prereqInstall     = 'Installing {0} with winget...'
    prereqNoWinget    = 'winget (App Installer) is not available. Install {0} {1} manually from {2} and run this script again.'
    prereqFailed      = 'Automatic installation of {0} failed (code {1}). Install it manually from {2}.'
    prereqAsk         = 'Install the missing components automatically with winget?'
    prereqRestart     = '{0} was installed but is not visible in this console yet. Close this window, open a new one and run the script again.'
    setupDone         = 'Everything is ready. Start the apps with run.bat (or start-all.bat).'
    setupBuilt        = 'Applications built: apps\octobrowser\dist, apps\octodetect\dist'
    runHidden         = 'Starting without a console window...'
    noSources         = 'No installer and no OctoSuite sources here ({0}). Unpack the whole repository (with package.json, apps\ and tools\) or put OctoSuite-Setup-*.exe next to the scripts.'
    installFromSources = 'No release installer found - setting up the source copy in {0}.'
    ghNoGitDir        = 'These sources are not a git clone (no .git folder), so they cannot be fast-forwarded. Only the build is refreshed. Use "git clone" to get updates from GitHub.'
    runSetupVisible   = 'Something is still missing - the setup will run in a visible window first.'
    prereqOpenSite    = 'Open the official download page ({0}) in your browser now?'
    prereqManual      = 'Install {0} and run this script again.'
    prereqTooOld      = '{0} {1} is installed but version {2} or newer is required ({3}).'
    logAt             = 'Log: {0}'
  }
  pl = @{
    notInstalled      = '{0} nie jest zainstalowany obok tych skryptów ({1}).'
    devMode           = 'Wykryto kopię deweloperską – uruchamianie przez Electron z node_modules.'
    notBuilt          = 'Aplikacja nie została jeszcze zbudowana. Najpierw uruchom "npm run build".'
    starting          = 'Uruchamianie {0}...'
    running           = '{0} jest uruchomiony. Zamknij go (łącznie z oknami profili) i spróbuj ponownie.'
    confirm           = 'Kontynuować? [t/N]'
    cancelled         = 'Anulowano.'
    done              = 'Gotowe.'
    noBootstrap       = '{0} nie został jeszcze skonfigurowany (nie ukończono pierwszego uruchomienia).'
    noInstaller       = 'Nie znaleziono pliku OctoSuite-Setup-*.exe w: {0}'
    usingInstaller    = 'Instalator: {0}'
    shaOk             = 'SHA-256 poprawne ({0})'
    shaBad            = 'NIEZGODNOŚĆ SHA-256 – plik jest uszkodzony lub zmieniony. Przerwano.'
    shaMissing        = 'Brak SHA256SUMS.txt obok instalatora – skrót zostanie sprawdzony tylko z podpisanym manifestem.'
    authOk            = 'Podpis Authenticode poprawny: {0}'
    authNone          = 'Instalator nie ma podpisu Authenticode. Weryfikacja opiera się na SHA-256 i podpisie Ed25519 manifestu.'
    authBad           = 'Podpis Authenticode NIEPRAWIDŁOWY ({0}). Przerwano.'
    sigOk             = 'Podpis manifestu aktualizacji (Ed25519) poprawny – wersja {0}.'
    sigBad            = 'Weryfikacja manifestu aktualizacji NIEUDANA (kod {0}): {1}'
    sigNotConfigured  = 'Ta kompilacja nie ma klucza podpisu aktualizacji – podpisane aktualizacje są niedostępne.'
    sigUnavailable    = 'Nie można tu zweryfikować podpisu Ed25519 manifestu (brak zainstalowanej aplikacji i Node.js).'
    sigUnavailableAsk = 'Sprawdzono tylko SHA-256 i Authenticode. Wpisz TAK, aby mimo to zainstalować'
    noManifest        = 'Nie znaleziono latest.json / latest.json.sig obok instalatora.'
    runInstaller      = 'Uruchamianie instalatora...'
    installerFailed   = 'Instalator zakończył się kodem {0}.'
    sigRequired       = 'Przerwano: nie można zweryfikować podpisu aktualizacji, więc niczego nie zainstalowano.'
    checking          = 'Sprawdzanie aktualizacji (oficjalne źródło: {0})...'
    upToDate          = 'Zainstalowana wersja {0} jest aktualna (najnowsza: {1}).'
    updateAvailable   = 'Dostępna aktualizacja: {0} -> {1} ({2}).'
    downloading       = 'Pobieranie {0}...'
    urlNotOfficial    = 'Odrzucono adres pobierania spoza oficjalnych wydań: {0}'
    backupConfig      = 'Kopia konfiguracji: {0}'
    keptForRollback   = 'Instalator zachowany do przywracania w {0}'
    repairStart       = 'Sprawdzanie instalacji i konfiguracji OctoSuite...'
    fileMissing       = 'Brak: {0}'
    filesOk           = '{0}: pliki programu są na miejscu.'
    reinstallOffer    = 'Pliki programu są uszkodzone. Zainstalować ponownie z najnowszego zweryfikowanego instalatora? [t/N]'
    bootstrapBroken   = '{0}: bootstrap.json jest uszkodzony – zmieniono jego nazwę; kreator pierwszego uruchomienia użyje ponownie Twojego folderu danych.'
    bootstrapOk       = '{0}: bootstrap.json poprawny (dane: {1})'
    dataDirMissing    = '{0}: folder danych nie istnieje: {1}'
    configOk          = '{0}: {1} poprawny'
    configBroken      = '{0}: {1} jest uszkodzony.'
    configRestored    = '{0}: {1} przywrócono z kopii {2}'
    configNoBackup    = '{0}: {1} – brak poprawnej kopii; aplikacja uruchomi się z ustawieniami domyślnymi.'
    tempCleared       = '{0}: usunięto pliki tymczasowe ({1}).'
    repairSummary     = 'Naprawa zakończona: naprawiono {0}, pozostało {1}.'
    uninstallerMissing = 'Nie znaleziono deinstalatora ({0}). Jeśli używasz wersji przenośnej, usuń jej folder ręcznie.'
    deleteDataAsk     = 'USUNĄĆ również wszystkie profile, ustawienia, raporty i logi w {0}? Tej operacji nie można cofnąć. Wpisz USUŃ, aby potwierdzić'
    dataDeleted       = 'Usunięto folder danych: {0}'
    dataKept          = 'Twoje dane pozostały w: {0}'
    profiles          = 'Profile:'
    profileNotFound   = 'Nie znaleziono profilu: {0}'
    chooseProfile     = 'Podaj nazwę lub numer profilu'
    resetAsk          = 'Zresetować profil „{0}”? Ciasteczka, dane witryn, historia i sesja zostaną usunięte; ustawienia i zakładki pozostaną.'
    resetDone         = 'Profil „{0}” został zresetowany.'
    backupUnencrypted = 'Uwaga: profil „{0}” NIE jest zaszyfrowany – kopia zawiera czytelne ciasteczka/logowania. Przechowuj ją bezpiecznie.'
    backupDone        = 'Utworzono kopię: {0}'
    noArchives        = 'Brak kopii profilu „{0}” w {1}'
    restoreAsk        = 'Przywrócić „{0}” z {1}? Najpierw zostanie utworzona kopia bieżących danych.'
    restoreDone       = 'Profil „{0}” przywrócony.'
    zipSlip           = 'Archiwum zawiera niebezpieczną ścieżkę ({0}). Przerwano.'
    archiveHashBad    = 'Suma kontrolna archiwum się nie zgadza ({0}). Przerwano.'
    archiveNoHash     = 'Brak pliku sumy kontrolnej dla tego archiwum – nie można potwierdzić integralności.'
    restoreNoEntry    = 'Profilu „{0}” nie było na liście profili. Zostanie dodany automatycznie przy następnym uruchomieniu OctoBrowser.su.'
    unknownCommand    = 'Nieznane polecenie: {0}'
    error             = 'Błąd: {0}'
    ghChecking        = 'Sprawdzanie wydań na GitHub ({0})...'
    ghNoRelease       = 'W oficjalnym repozytorium nie ma jeszcze żadnego opublikowanego wydania.'
    ghLatest          = 'Najnowsze wydanie na GitHub: {0} (opublikowane {1}).'
    ghNoAsset         = 'To wydanie nie zawiera pliku OctoSuite-Setup-*.exe dla Windows x64.'
    ghUnverifiedAsk   = 'To wydanie nie ma podpisanego manifestu (latest.json + latest.json.sig). Wpisz TAK, aby mimo to zainstalować'
    ghDevDetected     = 'Wykryto kopię deweloperską ({0}) – aktualizacja źródeł z GitHub zamiast instalacji wydania.'
    ghGitMissing      = 'Nie znaleziono git w PATH – nie można zaktualizować kopii deweloperskiej.'
    ghGitDirty        = 'Kopia robocza ma lokalne zmiany. Najpierw je zatwierdź lub odłóż (git stash).'
    ghGitUpToDate     = 'Źródła są już aktualne ({0}).'
    ghGitPulled       = 'Zaktualizowano źródła: {0} -> {1}'
    ghDeps            = 'Instalowanie zależności (npm ci)...'
    ghBuilding        = 'Budowanie obu aplikacji (npm run build)...'
    ghDevDone         = 'Kopia deweloperska zaktualizowana i zbudowana.'
    ghNpmMissing      = 'Nie znaleziono npm w PATH (wymagany Node.js >= 22.12).'
    ghNpmFailed       = 'npm {0} zakończyło się kodem {1}.'
    startAll          = 'Uruchamianie obu aplikacji...'
    updateSkipped     = 'Pominięto sprawdzanie aktualizacji (-NoUpdate).'
    updateFailed      = 'Sprawdzanie aktualizacji nie powiodło się ({0}) – uruchamianie zainstalowanej wersji.'
    prereqCheck       = 'Sprawdzanie, co jest potrzebne do uruchomienia OctoSuite...'
    prereqOk          = 'Znaleziono {0}: {1}'
    prereqMissing     = 'Brakuje {0} albo wersja jest za stara (wymagane: {1}).'
    prereqInstall     = 'Instalowanie {0} przez winget...'
    prereqNoWinget    = 'winget (Instalator aplikacji) jest niedostępny. Zainstaluj {0} {1} ręcznie z {2} i uruchom skrypt ponownie.'
    prereqFailed      = 'Automatyczna instalacja {0} nie powiodła się (kod {1}). Zainstaluj ręcznie z {2}.'
    prereqAsk         = 'Zainstalować brakujące składniki automatycznie przez winget?'
    prereqRestart     = 'Zainstalowano {0}, ale nie jest jeszcze widoczny w tej konsoli. Zamknij to okno, otwórz nowe i uruchom skrypt ponownie.'
    setupDone         = 'Wszystko gotowe. Uruchom aplikacje plikiem run.bat (albo start-all.bat).'
    setupBuilt        = 'Zbudowano aplikacje: apps\octobrowser\dist, apps\octodetect\dist'
    runHidden         = 'Uruchamianie bez okna konsoli...'
    noSources         = 'Nie ma tu ani instalatora, ani źródeł OctoSuite ({0}). Rozpakuj całe repozytorium (z plikami package.json, apps\ i tools\) albo połóż obok skryptów plik OctoSuite-Setup-*.exe.'
    installFromSources = 'Nie znaleziono instalatora wydania – konfigurowanie kopii źródłowej w {0}.'
    ghNoGitDir        = 'Te źródła nie są klonem git (brak folderu .git), więc nie można pobrać zmian. Odbudowana zostanie tylko aplikacja. Aby dostawać aktualizacje, użyj „git clone”.'
    runSetupVisible   = 'Czegoś jeszcze brakuje – najpierw w widocznym oknie uruchomi się instalacja wymagań.'
    prereqOpenSite    = 'Otworzyć teraz w przeglądarce oficjalną stronę pobierania ({0})?'
    prereqManual      = 'Zainstaluj {0} i uruchom ten skrypt ponownie.'
    prereqTooOld      = 'Zainstalowany {0} {1}, a wymagana jest wersja {2} lub nowsza ({3}).'
    logAt             = 'Log: {0}'
  }
}

# ------------------------------------------------------------------ helpers
function Get-BootstrapPath([string]$appId) {
  $a = $Apps[$appId]
  # Portable mode: portable.flag next to the executable => "<app id>.bootstrap.json" next to it
  # (same name as bootstrapFileFor() in packages/shell/src/prepare.ts - checked by tests).
  $exeDir = Join-Path $InstallRoot $a.Folder
  if (Test-Path -LiteralPath (Join-Path $exeDir 'portable.flag')) { return (Join-Path $exeDir ('{0}.bootstrap.json' -f $appId)) }
  return (Join-Path (Join-Path $env:APPDATA $a.Product) 'bootstrap.json')
}

function Read-Bootstrap([string]$appId) {
  $p = Get-BootstrapPath $appId
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  try {
    $b = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($b.schema -eq 1 -and $b.dataDir -and [System.IO.Path]::IsPathRooted([string]$b.dataDir)) { return $b }
  } catch { }
  return $null
}

if (-not $Lang) {
  $bs = Read-Bootstrap 'octobrowser'
  if (-not $bs) { $bs = Read-Bootstrap 'octodetect' }
  if ($bs -and ($bs.language -eq 'pl' -or $bs.language -eq 'en')) { $Lang = [string]$bs.language }
  elseif ((Get-UICulture).TwoLetterISOLanguageName -eq 'pl') { $Lang = 'pl' }
  else { $Lang = 'en' }
}

function T([string]$key) {
  $s = $Messages[$Lang][$key]
  if (-not $s) { $s = $Messages['en'][$key] }
  if (-not $s) { $s = $key }
  if ($args.Count -gt 0) { return ($s -f $args) }
  return $s
}

# Log file: <data>\logs\scripts-YYYYMMDD.log when configured, otherwise %TEMP%.
$LogFile = $null
function Initialize-Log {
  $bs = Read-Bootstrap 'octobrowser'
  if (-not $bs) { $bs = Read-Bootstrap 'octodetect' }
  $dir = $env:TEMP
  if ($bs -and (Test-Path -LiteralPath ([string]$bs.dataDir))) { $dir = Join-Path ([string]$bs.dataDir) 'logs' }
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $script:LogFile = Join-Path $dir ('scripts-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
}

function Protect-LogText([string]$text) {
  # Never log secrets: mask anything that looks like a credential or token, shorten user paths.
  $t = $text
  if ($env:USERPROFILE) { $t = $t.Replace($env:USERPROFILE, '%USERPROFILE%') }
  $t = [regex]::Replace($t, '(?i)(password|passwd|pwd|token|secret|key|authorization)\s*[=:]\s*\S+', '$1=[redacted]')
  $t = [regex]::Replace($t, '(?i)://[^/\s:@]+:[^/\s@]+@', '://[redacted]@')
  return $t
}

function Write-Log([string]$level, [string]$text) {
  if (-not $script:LogFile) { return }
  try {
    $line = '{0} {1} [{2}] {3}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $level, $Command, (Protect-LogText $text)
    [System.IO.File]::AppendAllText($script:LogFile, $line + [Environment]::NewLine, [System.Text.Encoding]::UTF8)
  } catch { }
}

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color; Write-Log 'info' $text }
function Warn([string]$text) { Write-Host $text -ForegroundColor Yellow; Write-Log 'warn' $text }
# Fail = error (exit code 1). The message is shown here, so the top-level handler does not repeat it.
function Fail([string]$text) { Write-Host $text -ForegroundColor Red; Write-Log 'error' $text; $script:FailShown = $true; throw [System.Exception]::new($text) }
# Stop-Cancelled = the user declined a confirmation (exit code 2).
function Stop-Cancelled { Say (T 'cancelled') 'Yellow'; throw [System.OperationCanceledException]::new('cancelled') }

function Confirm-Action([string]$question) {
  if ($Yes) { return $true }
  Write-Host $question -ForegroundColor Cyan
  $a = Read-Host (T 'confirm')
  return ($a -match '^(y|yes|t|tak)$')
}

function Confirm-Word([string]$question, [string[]]$words) {
  if ($Yes) { return $true }
  $a = Read-Host $question
  return ($words -contains $a.Trim())
}

function Get-AppExe([string]$appId) { return (Join-Path (Join-Path $InstallRoot $Apps[$appId].Folder) $Apps[$appId].Exe) }

function Test-AppRunning([string]$appId) {
  return [bool](Get-Process -Name $Apps[$appId].Process -ErrorAction SilentlyContinue)
}

function Assert-NotRunning([string[]]$appIds) {
  foreach ($id in $appIds) { if (Test-AppRunning $id) { Fail (T 'running' $Apps[$id].Product) } }
}

function Get-FileSha256([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Test-Authenticode([string]$path) {
  $sig = Get-AuthenticodeSignature -LiteralPath $path
  switch ([string]$sig.Status) {
    'Valid' { Say (T 'authOk' $sig.SignerCertificate.Subject) 'Green'; return }
    'NotSigned' { Warn (T 'authNone'); return }
    default { Fail (T 'authBad' $sig.Status) }
  }
}

function Set-Tls { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 }

function Invoke-Download([string]$url, [string]$dest) {
  if (-not $url.StartsWith("$OfficialBase/")) { Fail (T 'urlNotOfficial' $url) }
  Set-Tls
  Say (T 'downloading' $url)
  $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -MaximumRedirection 5 -Headers @{ 'User-Agent' = 'OctoSuite-scripts' } }
  finally { $ProgressPreference = $old }
}

# Ed25519 manifest verification. Returns the parsed result object (ok, code, version, error).
function Invoke-ManifestVerify([string]$manifest, [string]$installer) {
  $resultFile = Join-Path $env:TEMP ('octo-verify-{0}.json' -f [guid]::NewGuid().ToString('N'))
  try {
    foreach ($id in @('octobrowser', 'octodetect')) {
      $exe = Get-AppExe $id
      if (-not (Test-Path -LiteralPath $exe)) { continue }
      $argList = @("--verify-manifest=`"$manifest`"", "--verify-result=`"$resultFile`"")
      if ($installer) { $argList += "--verify-installer=`"$installer`"" }
      $p = Start-Process -FilePath $exe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden
      if (Test-Path -LiteralPath $resultFile) {
        return ([System.IO.File]::ReadAllText($resultFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
      }
      return [pscustomobject]@{ ok = $false; code = $p.ExitCode; error = 'no result written' }
    }
    # Fresh install: fall back to Node.js + the public key shipped with the scripts.
    $node = Get-Command node -ErrorAction SilentlyContinue
    $pem = Join-Path $PSScriptRoot 'update-public-key.pem'
    if ($node -and (Test-Path -LiteralPath $pem)) {
      $js = @'
const fs=require('fs'),c=require('crypto');
const [m,pem,instArg,out]=process.argv.slice(1);const inst=instArg==='-'?'':instArg;
let r;
try{const b=fs.readFileSync(m),s=Buffer.from(fs.readFileSync(m+'.sig','utf8').trim(),'base64');
 const k=c.createPublicKey(fs.readFileSync(pem,'utf8'));
 if(k.asymmetricKeyType!=='ed25519'||s.length!==64||!c.verify(null,b,k,s)) r={ok:false,code:11,error:'bad signature'};
 else{const j=JSON.parse(b.toString('utf8'));const rel=j.apps&&j.apps.octobrowser;r={ok:!!rel,code:rel?0:14,version:rel&&rel.version};
  if(rel&&inst){const h=c.createHash('sha256').update(fs.readFileSync(inst)).digest('hex');const n=require('path').basename(inst).toLowerCase();
   const f=rel.files.find(x=>x.name.toLowerCase()===n);const ok=!!f&&f.sha256===h;r.ok=ok;r.code=ok?0:(f?12:14);r.installer={name:n,sha256:h,expected:f&&f.sha256,match:ok};}}}
catch(e){r={ok:false,code:13,error:String(e.message||e)}}
fs.writeFileSync(out,JSON.stringify(r));process.exit(r.code);
'@
      # PS 5.1 drops empty native arguments, so "-" stands for "no installer".
      $instArg = '-'
      if ($installer) { $instArg = $installer }
      # Through Invoke-Native: node may print to stderr, which would otherwise become a
      # terminating error under $ErrorActionPreference = 'Stop'. Only the result file counts.
      [void](Invoke-Native $node.Source @('-e', $js, $manifest, $pem, $instArg, $resultFile) $null -Quiet)
      if (Test-Path -LiteralPath $resultFile) {
        return ([System.IO.File]::ReadAllText($resultFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
      }
    }
    return $null
  } finally {
    Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue
  }
}

function Assert-ManifestResult($r, [switch]$AllowUnavailable) {
  if ($null -eq $r) {
    Warn (T 'sigUnavailable')
    if (-not $AllowUnavailable) { Fail (T 'sigRequired') }
    if (-not (Confirm-Word (T 'sigUnavailableAsk') @('YES', 'TAK'))) { Stop-Cancelled }
    return
  }
  if ($r.code -eq 10) { Fail (T 'sigNotConfigured') }
  if (-not $r.ok) { Fail (T 'sigBad' $r.code $r.error) }
  Say (T 'sigOk' $r.version) 'Green'
}

function Get-ProfilesDoc([string]$dataDir) {
  $file = Join-Path (Join-Path $dataDir 'config') 'profiles.json'
  $envelope = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($envelope.encrypted) { throw 'profiles.json is encrypted and cannot be read by scripts' }
  return ($envelope.payload | ConvertFrom-Json)
}

function Select-Profile([string]$dataDir, [string]$query) {
  $doc = Get-ProfilesDoc $dataDir
  $list = @($doc.profiles)
  if (-not $query) {
    Say (T 'profiles') 'Cyan'
    for ($i = 0; $i -lt $list.Count; $i++) {
      Write-Host ('  {0,2}. {1}  [{2}]{3}' -f ($i + 1), $list[$i].name, $list[$i].kind, $(if ($list[$i].encrypted) { '  (enc)' } else { '' }))
    }
    $query = Read-Host (T 'chooseProfile')
  }
  $n = 0
  if ([int]::TryParse($query, [ref]$n) -and $n -ge 1 -and $n -le $list.Count) { return $list[$n - 1] }
  foreach ($p in $list) { if ($p.id -eq $query -or $p.name -eq $query) { return $p } }
  Fail (T 'profileNotFound' $query)
}

function Get-OBDataDir {
  $bs = Read-Bootstrap 'octobrowser'
  if (-not $bs) { Fail (T 'noBootstrap' 'OctoBrowser.su') }
  return [string]$bs.dataDir
}

function Assert-SafeProfileId([string]$id) {
  if ($id -notmatch '^[a-z0-9-]{3,64}$') { Fail "invalid profile id: $id" }
}

# ------------------------------------------------------------------ commands
function Invoke-Open([string]$appId) {
  $exe = Get-AppExe $appId
  $a = $Apps[$appId]
  if (Test-Path -LiteralPath $exe) {
    Say (T 'starting' $a.Product)
    if ($Rest -and $Rest.Count -gt 0) { Start-Process -FilePath $exe -ArgumentList $Rest -WorkingDirectory (Split-Path -Parent $exe) }
    else { Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) }
    return
  }
  # Development checkout: scripts\ lives in the repository root.
  $electron = Join-Path $InstallRoot 'node_modules\.bin\electron.cmd'
  $appDir = Join-Path $InstallRoot $a.DevDir
  if (Test-Path -LiteralPath $electron) {
    if (-not (Test-Path -LiteralPath (Join-Path $appDir 'dist\main.js'))) { Fail (T 'notBuilt') }
    Say (T 'devMode')
    Start-Process -FilePath $electron -ArgumentList (@("`"$appDir`"") + @($Rest | Where-Object { $_ })) -WorkingDirectory $InstallRoot
    return
  }
  Fail (T 'notInstalled' $a.Product $InstallRoot)
}

function Find-Installer([string[]]$dirs) {
  foreach ($d in $dirs) {
    if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
    # "OctoSuite-Setup-<version>.exe" (release download) or "<version>.exe" (kept by the updater).
    $cands = @(Get-ChildItem -LiteralPath $d -Filter '*.exe' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.BaseName -match '^(OctoSuite-Setup-)?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$' })
    if ($cands.Count -gt 0) {
      return ($cands | Sort-Object -Property @{ Expression = { try { [version]($_.BaseName -replace '^OctoSuite-Setup-', '' -replace '-.*$', '') } catch { [version]'0.0.0' } } } -Descending | Select-Object -First 1)
    }
  }
  return $null
}

function Test-Sha256Sums([string]$file) {
  $sums = Join-Path (Split-Path -Parent $file) 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $sums)) { Warn (T 'shaMissing'); return }
  $name = Split-Path -Leaf $file
  $expected = $null
  foreach ($line in [System.IO.File]::ReadAllLines($sums)) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$' -and $Matches[2].Trim() -eq $name) { $expected = $Matches[1].ToLowerInvariant() }
  }
  $actual = Get-FileSha256 $file
  if (-not $expected -or $expected -ne $actual) { Fail (T 'shaBad') }
  Say (T 'shaOk' $actual) 'Green'
}

# -Silent (used by update): progress window only, no wizard pages - the user has already
# confirmed the update here. Same switches as the in-app updater (core installerArgs()).
function Invoke-Installer([string]$file, [switch]$Silent) {
  Say (T 'runInstaller')
  $log = Join-Path $env:TEMP 'OctoSuite-setup.log'
  $installerArgs = @("/LOG=`"$log`"")
  if ($Silent) { $installerArgs += @('/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', "/LANG=$Lang") }
  $p = Start-Process -FilePath $file -ArgumentList $installerArgs -Wait -PassThru
  if ($p.ExitCode -ne 0) { Fail (T 'installerFailed' $p.ExitCode) }
}

function Invoke-Install {
  # Inside the source tree "install" means "make this copy runnable". An unrelated
  # OctoSuite-Setup-*.exe sitting in Downloads must never be picked up instead;
  # pass -Source <folder> explicitly when you really want to run an installer.
  if ((Test-DevCheckout) -and -not $Source) { Say (T 'installFromSources' $InstallRoot) 'Cyan'; [void](Invoke-Setup); return }
  $dirs = @($Source, $ScriptsDir, $InstallRoot, (Join-Path $env:USERPROFILE 'Downloads'))
  $inst = Find-Installer $dirs
  if (-not $inst) {
    # No release installer next to the scripts: this is a source checkout, so install
    # everything needed to run it from sources instead of failing.
    if (Test-DevCheckout) { Say (T 'installFromSources' $InstallRoot) 'Cyan'; [void](Invoke-Setup); return }
    Warn (T 'noInstaller' (($dirs | Where-Object { $_ }) -join '; '))
    Fail (T 'noSources' $InstallRoot)
  }
  $file = $inst.FullName
  Say (T 'usingInstaller' $file) 'Cyan'
  Test-Sha256Sums $file
  Test-Authenticode $file
  $manifest = Join-Path $inst.DirectoryName 'latest.json'
  if ((Test-Path -LiteralPath $manifest) -and (Test-Path -LiteralPath "$manifest.sig")) {
    Assert-ManifestResult (Invoke-ManifestVerify $manifest $file) -AllowUnavailable
  } else {
    Warn (T 'noManifest')
    if (-not (Confirm-Word (T 'sigUnavailableAsk') @('YES', 'TAK'))) { Stop-Cancelled }
  }
  Assert-NotRunning @('octobrowser', 'octodetect')
  Invoke-Installer $file
  Say (T 'done') 'Green'
}

function Backup-Configs([string]$stamp) {
  foreach ($id in @('octobrowser', 'octodetect')) {
    $bs = Read-Bootstrap $id
    if (-not $bs) { continue }
    $cfg = Join-Path ([string]$bs.dataDir) 'config'
    if (-not (Test-Path -LiteralPath $cfg)) { continue }
    $dest = Join-Path (Join-Path ([string]$bs.dataDir) 'backups') "pre-update-$stamp"
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item -LiteralPath $cfg -Destination $dest -Recurse -Force
    Say (T 'backupConfig' $dest)
  }
}

function Invoke-Update {
  $exe = Get-AppExe 'octobrowser'
  if (-not (Test-Path -LiteralPath $exe)) { Fail (T 'notInstalled' 'OctoBrowser.su' $InstallRoot) }
  $installed = [string](Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  Say (T 'checking' $OfficialBase) 'Cyan'
  $work = Join-Path $env:TEMP ('OctoSuite-update-{0}' -f [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    $manifest = Join-Path $work 'latest.json'
    Invoke-Download "$OfficialBase/latest/download/latest.json" $manifest
    Invoke-Download "$OfficialBase/latest/download/latest.json.sig" "$manifest.sig"
    $r = Invoke-ManifestVerify $manifest $null
    Assert-ManifestResult $r
    $m = [System.IO.File]::ReadAllText($manifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $rel = $m.apps.octobrowser
    $newer = $false
    try { $newer = ([version]($rel.version -replace '-.*$', '')) -gt ([version]($installed -replace '-.*$', '')) } catch { $newer = $rel.version -ne $installed }
    if (-not $newer) { Say (T 'upToDate' $installed $rel.version) 'Green'; return }
    Say (T 'updateAvailable' $installed $rel.version $rel.severity) 'Cyan'
    if ($Lang -eq 'pl') { Write-Host $rel.changelog.pl } else { Write-Host $rel.changelog.en }
    if ($CheckOnly) { return }
    if (-not (Confirm-Action '')) { Stop-Cancelled }
    $f = @($rel.files | Where-Object { $_.platform -eq 'win32' -and $_.arch -eq 'x64' })[0]
    if ($f.name -notmatch '^[\w.-]+$') { Fail 'invalid file name in manifest' }
    $installer = Join-Path $work $f.name
    Invoke-Download ([string]$f.url) $installer
    Assert-ManifestResult (Invoke-ManifestVerify $manifest $installer)
    Test-Authenticode $installer
    Assert-NotRunning @('octobrowser', 'octodetect')
    Backup-Configs (Get-Date -Format 'yyyyMMdd-HHmmss')
    # Keep the verified installer for rollback (same folder the in-app updater uses; newest 3 kept).
    $bs = Read-Bootstrap 'octobrowser'
    if ($bs) {
      $keep = Join-Path ([string]$bs.dataDir) 'updater\installed'
      New-Item -ItemType Directory -Path $keep -Force | Out-Null
      # Same naming as the in-app updater ("<version>.exe") so the app offers it for rollback.
      if ([string]$rel.version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { Fail 'invalid version in manifest' }
      Copy-Item -LiteralPath $installer -Destination (Join-Path $keep ('{0}.exe' -f $rel.version)) -Force
      Get-ChildItem -LiteralPath $keep -Filter '*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
      Say (T 'keptForRollback' $keep)
    }
    Invoke-Installer $installer -Silent
    Say (T 'done') 'Green'
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# VersionedStore envelope check: { schema:1, sha256:<hex of payload>, encrypted, payload }
function Test-Envelope([string]$file) {
  try {
    $e = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($e.schema -ne 1 -or -not ($e.payload -is [string]) -or -not ($e.sha256 -is [string])) { return $false }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($e.payload)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
    return ($h -eq $e.sha256)
  } catch { return $false }
}

function Invoke-Repair {
  Say (T 'repairStart') 'Cyan'
  Assert-NotRunning @('octobrowser', 'octodetect')
  $fixed = 0; $remaining = 0
  $filesBroken = $false
  foreach ($id in @('octobrowser', 'octodetect')) {
    $a = $Apps[$id]
    $dir = Join-Path $InstallRoot $a.Folder
    $need = @((Join-Path $dir $a.Exe), (Join-Path $dir 'resources\app.asar'))
    $missing = @($need | Where-Object { -not (Test-Path -LiteralPath $_) })
    if ($missing.Count -gt 0) { foreach ($m in $missing) { Warn (T 'fileMissing' $m) }; $filesBroken = $true }
    else { Say (T 'filesOk' $a.Product) 'Green' }
  }
  foreach ($id in @('octobrowser', 'octodetect')) {
    $a = $Apps[$id]
    $bp = Get-BootstrapPath $id
    if (-not (Test-Path -LiteralPath $bp)) { Say (T 'noBootstrap' $a.Product); continue }
    $bs = Read-Bootstrap $id
    if (-not $bs) {
      Move-Item -LiteralPath $bp -Destination ('{0}.broken-{1}' -f $bp, (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
      Warn (T 'bootstrapBroken' $a.Product); $fixed++; continue
    }
    $data = [string]$bs.dataDir
    if (-not (Test-Path -LiteralPath $data)) { Warn (T 'dataDirMissing' $a.Product $data); $remaining++; continue }
    Say (T 'bootstrapOk' $a.Product $data) 'Green'
    $names = @('settings.json')
    if ($id -eq 'octobrowser') { $names += 'profiles.json' }
    foreach ($n in $names) {
      $f = Join-Path (Join-Path $data 'config') $n
      if (-not (Test-Path -LiteralPath $f)) { continue }
      if (Test-Envelope $f) { Say (T 'configOk' $a.Product $n) 'Green'; continue }
      Warn (T 'configBroken' $a.Product $n)
      $bdir = Join-Path $data 'backups\config'
      $restored = $false
      if (Test-Path -LiteralPath $bdir) {
        foreach ($b in (Get-ChildItem -LiteralPath $bdir -Filter "$n.*.bak" -File | Sort-Object LastWriteTime -Descending)) {
          if (Test-Envelope $b.FullName) {
            Copy-Item -LiteralPath $f -Destination ('{0}.corrupt-{1}' -f $f, (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
            Copy-Item -LiteralPath $b.FullName -Destination $f -Force
            Say (T 'configRestored' $a.Product $n $b.Name) 'Green'; $restored = $true; $fixed++; break
          }
        }
      }
      if (-not $restored) { Warn (T 'configNoBackup' $a.Product $n); $remaining++ }
    }
    $tmp = Join-Path $data 'temp'
    if (Test-Path -LiteralPath $tmp) {
      $items = @(Get-ChildItem -LiteralPath $tmp -Force -ErrorAction SilentlyContinue)
      $items | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      Say (T 'tempCleared' $a.Product $items.Count)
    }
  }
  if ($filesBroken) {
    $bs = Read-Bootstrap 'octobrowser'
    $inst = $null
    if ($bs) { $inst = Find-Installer @((Join-Path ([string]$bs.dataDir) 'updater\installed')) }
    if ($inst -and (Confirm-Action (T 'reinstallOffer'))) {
      Test-Authenticode $inst.FullName
      Invoke-Installer $inst.FullName; $fixed++
    } else { $remaining++ }
  }
  Say (T 'repairSummary' $fixed $remaining) $(if ($remaining -gt 0) { 'Yellow' } else { 'Green' })
}

function Invoke-Uninstall {
  Assert-NotRunning @('octobrowser', 'octodetect')
  $dataDirs = @()
  foreach ($id in @('octobrowser', 'octodetect')) { $bs = Read-Bootstrap $id; if ($bs) { $dataDirs += [string]$bs.dataDir } }
  $unins = Get-ChildItem -LiteralPath $InstallRoot -Filter 'unins*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($DeleteData -and $dataDirs.Count -gt 0) {
    foreach ($d in $dataDirs) {
      if (-not (Test-Path -LiteralPath $d)) { continue }
      # Only delete folders that really are OctoSuite data folders.
      if (-not (Test-Path -LiteralPath (Join-Path $d 'config'))) { continue }
      if (Confirm-Word (T 'deleteDataAsk' $d) @('DELETE', 'USUŃ', 'USUN')) {
        Remove-Item -LiteralPath $d -Recurse -Force
        Say (T 'dataDeleted' $d) 'Yellow'
      } else { Say (T 'dataKept' $d) }
    }
    foreach ($id in @('octobrowser', 'octodetect')) {
      $bp = Get-BootstrapPath $id
      if (Test-Path -LiteralPath $bp) { Remove-Item -LiteralPath (Split-Path -Parent $bp) -Recurse -Force -ErrorAction SilentlyContinue }
    }
  } else {
    foreach ($d in $dataDirs) { Say (T 'dataKept' $d) }
  }
  if (-not $unins) { Warn (T 'uninstallerMissing' $InstallRoot); return }
  # Inno Setup's uninstaller copies itself to %TEMP% and removes the program folder.
  Start-Process -FilePath $unins.FullName -Wait
  Say (T 'done') 'Green'
}

function Get-ArchiveDir([string]$dataDir) { return (Join-Path $dataDir 'backups\profile-archives') }

function New-ProfileArchive([string]$dataDir, $p, [string]$destDir) {
  Assert-SafeProfileId $p.id
  $src = Join-Path (Join-Path $dataDir 'profiles') $p.id
  if (-not (Test-Path -LiteralPath $src)) { Fail (T 'profileNotFound' $p.id) }
  if (-not $p.encrypted) { Warn (T 'backupUnencrypted' $p.name) }
  if (-not $destDir) { $destDir = Get-ArchiveDir $dataDir }
  New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  # Milliseconds + a counter: two backups in the same second must not collide (CreateNew below).
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $zip = Join-Path $destDir ('{0}-{1}.zip' -f $p.id, $stamp)
  for ($n = 2; Test-Path -LiteralPath $zip; $n++) { $zip = Join-Path $destDir ('{0}-{1}-{2}.zip' -f $p.id, $stamp, $n) }
  $fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)
  try {
    $za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      $root = (Resolve-Path -LiteralPath $src).ProviderPath.TrimEnd('\') + '\'
      foreach ($f in (Get-ChildItem -LiteralPath $src -Recurse -File -Force)) {
        $rel = $f.FullName.Substring($root.Length).Replace('\', '/')
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $f.FullName, "profile/$rel", [System.IO.Compression.CompressionLevel]::Optimal)
      }
      # Profile settings entry (from profiles.json, contains no secrets - proxy passwords live in secrets.bin).
      $entry = $za.CreateEntry('profile-entry.json')
      $w = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
      try { $w.Write(($p | ConvertTo-Json -Depth 10)) } finally { $w.Dispose() }
    } finally { $za.Dispose() }
  } finally { $fs.Dispose() }
  $hash = Get-FileSha256 $zip
  [System.IO.File]::WriteAllText("$zip.sha256", ('{0}  {1}' -f $hash, (Split-Path -Leaf $zip)) + "`n", (New-Object System.Text.UTF8Encoding($false)))
  return $zip
}

function Invoke-BackupProfile {
  $data = Get-OBDataDir
  Assert-NotRunning @('octobrowser')
  $p = Select-Profile $data $ProfileName
  $zip = New-ProfileArchive $data $p $Destination
  Say (T 'backupDone' $zip) 'Green'
}

function Invoke-ResetProfile {
  $data = Get-OBDataDir
  Assert-NotRunning @('octobrowser')
  $p = Select-Profile $data $ProfileName
  Assert-SafeProfileId $p.id
  if (-not (Confirm-Action (T 'resetAsk' $p.name))) { Stop-Cancelled }
  if (-not $NoBackup) { $zip = New-ProfileArchive $data $p $null; Say (T 'backupDone' $zip) }
  $dir = Join-Path (Join-Path $data 'profiles') $p.id
  foreach ($x in @('engine', 'engine.vault', 'history.enc', 'session.enc')) {
    $t = Join-Path $dir $x
    if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Recurse -Force }
  }
  New-Item -ItemType Directory -Path (Join-Path $dir 'engine') -Force | Out-Null
  Say (T 'resetDone' $p.name) 'Green'
}

function Invoke-RestoreProfile {
  $data = Get-OBDataDir
  Assert-NotRunning @('octobrowser')
  $zipPath = $Archive
  $p = $null
  if (-not $zipPath) {
    $p = Select-Profile $data $ProfileName
    Assert-SafeProfileId $p.id
    $dir = Get-ArchiveDir $data
    $cand = @(Get-ChildItem -LiteralPath $dir -Filter "$($p.id)-*.zip" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($cand.Count -eq 0) { Fail (T 'noArchives' $p.name $dir) }
    $zipPath = $cand[0].FullName
  }
  $zipPath = (Resolve-Path -LiteralPath $zipPath).ProviderPath
  # Integrity (sidecar checksum written by backup-profile).
  $side = "$zipPath.sha256"
  if (Test-Path -LiteralPath $side) {
    $expected = ([System.IO.File]::ReadAllText($side).Trim() -split '\s+')[0].ToLowerInvariant()
    if ($expected -ne (Get-FileSha256 $zipPath)) { Fail (T 'archiveHashBad' $zipPath) }
  } else { Warn (T 'archiveNoHash') }
  $za = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entryJson = $za.Entries | Where-Object { $_.FullName -eq 'profile-entry.json' } | Select-Object -First 1
    if (-not $entryJson) { Fail 'profile-entry.json missing in archive' }
    $r = New-Object System.IO.StreamReader($entryJson.Open(), [System.Text.Encoding]::UTF8)
    try { $metaJson = $r.ReadToEnd() } finally { $r.Dispose() }
    $meta = $metaJson | ConvertFrom-Json
    Assert-SafeProfileId $meta.id
    if ($p -and $p.id -ne $meta.id) { Fail (T 'profileNotFound' $meta.id) }
    if (-not (Confirm-Action (T 'restoreAsk' $meta.name $zipPath))) { Stop-Cancelled }
    $target = Join-Path (Join-Path $data 'profiles') $meta.id
    $staging = "$target.restore-$([guid]::NewGuid().ToString('N'))"
    $stagingRoot = [System.IO.Path]::GetFullPath($staging).TrimEnd('\') + '\'
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
      foreach ($e in $za.Entries) {
        if (-not $e.FullName.StartsWith('profile/') -or $e.FullName.EndsWith('/')) { continue }
        $rel = $e.FullName.Substring(8)
        $dest = [System.IO.Path]::GetFullPath((Join-Path $staging $rel))
        if (-not $dest.StartsWith($stagingRoot, [System.StringComparison]::OrdinalIgnoreCase)) { Fail (T 'zipSlip' $e.FullName) }
        New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
      }
      # Back up the current state first, then swap folders.
      if (Test-Path -LiteralPath $target) {
        $doc = Get-ProfilesDoc $data
        $cur = @($doc.profiles | Where-Object { $_.id -eq $meta.id })[0]
        if ($cur) { $zip = New-ProfileArchive $data $cur $null; Say (T 'backupDone' $zip) }
        Remove-Item -LiteralPath $target -Recurse -Force
      }
      Move-Item -LiteralPath $staging -Destination $target
    } finally {
      if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    }
    $doc2 = Get-ProfilesDoc $data
    if (-not (@($doc2.profiles | Where-Object { $_.id -eq $meta.id }).Count)) {
      # The entry was deleted from the list. The script never edits profiles.json (the app is its
      # only writer); instead it leaves the archived entry for OctoBrowser, which validates it and
      # adds the profile back at next start (ProfileManager.adoptRestoredEntries).
      $marker = Join-Path $target 'restored-entry.json'
      [System.IO.File]::WriteAllText($marker, $metaJson, (New-Object System.Text.UTF8Encoding($false)))
      Write-Log 'info' "restored-entry marker written for $($meta.id)"
      Say (T 'restoreNoEntry' $meta.name) 'Yellow'
    }
    Say (T 'restoreDone' $meta.name) 'Green'
  } finally { $za.Dispose() }
}

# ------------------------------------------------------ prerequisites (install.bat / run.bat)
# Everything OctoSuite needs to run from sources. Nothing is installed silently behind the
# user's back: winget is used only after a confirmation (or with -Yes), packages come from
# the official winget repository and each step is logged.
$Prereqs = @(
  @{ Id = 'OpenJS.NodeJS.LTS'; Name = 'Node.js'; Cmd = 'node'; Min = '22.12.0'; Site = 'https://nodejs.org/' }
  @{ Id = 'Git.Git';           Name = 'git';     Cmd = 'git';  Min = '2.30.0';  Site = 'https://git-scm.com/' }
)

# Tools are looked up in PATH first, then - because a console started before the installer
# ran keeps an old PATH - in the registry copy of PATH and in the standard install folders.
# Everything resolved here is used by absolute path afterwards.
$ToolHints = @{
  'node' = @('nodejs\node.exe')
  'npm'  = @('nodejs\npm.cmd')
  'git'  = @('Git\cmd\git.exe', 'Git\bin\git.exe')
}
$ToolRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432,
  (Join-Path $env:LOCALAPPDATA 'Programs'), $env:LOCALAPPDATA)
$script:ToolCache = @{}

# winget writes the new PATH to the registry; this console keeps the old copy until refreshed.
function Update-SessionPath {
  $parts = @()
  foreach ($scope in @('Machine', 'User')) {
    $value = [Environment]::GetEnvironmentVariable('Path', $scope)
    if ($value) { $parts += $value.Split(';') }
  }
  if ($env:Path) { $parts += $env:Path.Split(';') }
  $seen = @{}
  $clean = @()
  foreach ($part in $parts) {
    $p = $part.Trim()
    if (-not $p -or $seen.ContainsKey($p.ToLowerInvariant())) { continue }
    $seen[$p.ToLowerInvariant()] = $true
    $clean += $p
  }
  $env:Path = $clean -join ';'
  $script:ToolCache = @{}
}

# Absolute path of a tool, or $null. Finding node.exe outside PATH also fixes PATH for this
# session, so npm.cmd and node_modules\.bin\electron.cmd work afterwards.
function Resolve-Tool([string]$name) {
  if ($script:ToolCache.ContainsKey($name)) { return $script:ToolCache[$name] }
  $found = $null
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Path) { $found = $cmd.Path }
  if (-not $found -and $name -eq 'npm') {
    $cmd = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Path) { $found = $cmd.Path }
  }
  if (-not $found -and $ToolHints.ContainsKey($name)) {
    foreach ($root in $ToolRoots) {
      if (-not $root) { continue }
      foreach ($hint in $ToolHints[$name]) {
        $candidate = Join-Path $root $hint
        if (Test-Path -LiteralPath $candidate) { $found = $candidate; break }
      }
      if ($found) { break }
    }
  }
  if ($found) {
    $dir = Split-Path -Parent $found
    $onPath = $false
    if ($env:Path) { $onPath = [bool](@($env:Path.Split(';') | Where-Object { $_.Trim().TrimEnd('\') -ieq $dir.TrimEnd('\') }).Count) }
    if (-not $onPath) {
      $env:Path = "$dir;$env:Path"
      Write-Log 'info' "added to PATH for this session: $dir"
    }
  }
  $script:ToolCache[$name] = $found
  return $found
}

# Runs an external program and returns its exit code.
#
# Why this wrapper: the script runs with $ErrorActionPreference = 'Stop', and in that mode
# ANY line a native program writes to stderr is turned into a terminating error. npm writes
# its "npm warn deprecated ..." notices to stderr, git writes progress there - none of which
# means failure. Here the preference is relaxed for the duration of the call, every line is
# printed as plain text, and only the exit code decides whether something went wrong.
function Invoke-Native([string]$exe, [string[]]$argList, [string]$workDir, [switch]$Quiet) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $lines = New-Object System.Collections.Generic.List[string]
  if ($workDir) { Push-Location -LiteralPath $workDir }
  try {
    & $exe @argList 2>&1 | ForEach-Object {
      $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { [string]$_.Exception.Message } else { [string]$_ }
      $lines.Add($line)
      if (-not $Quiet) { Write-Host $line }
    }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [pscustomobject]@{ code = $code; text = ($lines -join [Environment]::NewLine) }
  } finally {
    if ($workDir) { Pop-Location }
    $ErrorActionPreference = $previous
  }
}

function Get-ToolVersion([string]$name) {
  $exe = Resolve-Tool $name
  if (-not $exe) { return $null }
  try {
    $raw = (Invoke-Native $exe @('--version') $null -Quiet).text
    $m = [regex]::Match($raw, '\d+\.\d+(\.\d+)?')
    if ($m.Success) { return [version]($m.Value + ('.0' * (2 - ([regex]::Matches($m.Value, '\.')).Count))) }
  } catch { }
  return $null
}

# winget exit codes that mean "nothing to do", not "it failed".
# 0x8A15002B = -1978335189 no applicable update, 0x8A150014 = -1978335212 already installed.
$WingetBenign = @(0, -1978335189, -1978335212)

function Install-Prerequisite($tool) {
  $winget = Get-Command 'winget' -ErrorAction SilentlyContinue
  if (-not $winget) {
    # No App Installer (winget). We never download an installer from a random place -
    # the official download page is opened instead, then the user re-runs this script.
    Warn (T 'prereqNoWinget' $tool.Name $tool.Min $tool.Site)
    if (Confirm-Action (T 'prereqOpenSite' $tool.Site)) { Start-Process $tool.Site }
    Fail (T 'prereqManual' $tool.Name)
  }
  Say (T 'prereqInstall' $tool.Name) 'Cyan'
  # Official winget source only, no interactive prompts; Windows may still show UAC for
  # a machine-wide package (Node.js MSI) - that consent is the user's, not ours to bypass.
  $wingetArgs = @('install', '--id', $tool.Id, '--exact', '--source', 'winget', '--silent',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
  $p = Start-Process -FilePath $winget.Source -ArgumentList $wingetArgs -Wait -PassThru -NoNewWindow
  Update-SessionPath
  if ($WingetBenign -contains $p.ExitCode) {
    # Already installed (possibly only in the registry PATH this console has not seen yet).
    if ($p.ExitCode -ne 0) { Write-Log 'info' "winget: nothing to install for $($tool.Id) (code $($p.ExitCode))" }
    return
  }
  Fail (T 'prereqFailed' $tool.Name $p.ExitCode $tool.Site)
}

# Returns $true when every prerequisite is present (after installing the missing ones).
function Install-Prerequisites([switch]$GitRequired) {
  Say (T 'prereqCheck') 'Cyan'
  # A console opened before the tool was installed still has the old PATH - refresh it first,
  # otherwise a perfectly good Node.js looks "missing".
  Update-SessionPath
  $missing = @()
  foreach ($tool in $Prereqs) {
    if ($tool.Cmd -eq 'git' -and -not $GitRequired) { continue }
    $have = Get-ToolVersion $tool.Cmd
    if ($have -and $have -ge [version]$tool.Min) { Say (T 'prereqOk' $tool.Name $have) 'Green'; continue }
    Warn (T 'prereqMissing' $tool.Name $tool.Min)
    $missing += $tool
  }
  if ($missing.Count -eq 0) { return $true }
  if (-not (Confirm-Action (T 'prereqAsk'))) { Stop-Cancelled }
  foreach ($tool in $missing) {
    Install-Prerequisite $tool
    $have = Get-ToolVersion $tool.Cmd
    if (-not $have) { Warn (T 'prereqRestart' $tool.Name); return $false }
    if ($have -lt [version]$tool.Min) {
      # winget reported success/"already installed" but the version is still too low
      # (an old package, nvm, or a second copy earlier in PATH).
      Warn (T 'prereqTooOld' $tool.Name $have $tool.Min (Resolve-Tool $tool.Cmd))
      if (Confirm-Action (T 'prereqOpenSite' $tool.Site)) { Start-Process $tool.Site }
      Fail (T 'prereqManual' $tool.Name)
    }
    Say (T 'prereqOk' $tool.Name $have) 'Green'
  }
  return $true
}

# Full setup of a development checkout: prerequisites -> npm ci -> npm run build.
function Invoke-Setup([switch]$Quiet) {
  if (-not (Test-DevCheckout)) { Fail (T 'noSources' $InstallRoot) }
  # git is only needed to fast-forward a clone; a downloaded ZIP works fine without it.
  if (Test-GitCheckout) { $ok = Install-Prerequisites -GitRequired } else { $ok = Install-Prerequisites }
  if (-not $ok) { return $false }
  $modules = Join-Path $InstallRoot 'node_modules'
  $stamp = Join-Path $modules '.octo-lock-sha256'
  $lock = Join-Path $InstallRoot 'package-lock.json'
  $lockHash = ''
  if (Test-Path -LiteralPath $lock) { $lockHash = Get-FileSha256 $lock }
  $installed = (Test-Path -LiteralPath $modules) -and (Test-Path -LiteralPath $stamp) -and
               ([System.IO.File]::ReadAllText($stamp).Trim() -eq $lockHash)
  if (-not $installed) {
    Say (T 'ghDeps')
    Invoke-Npm @('ci', '--no-audit', '--no-fund')
    [System.IO.File]::WriteAllText($stamp, $lockHash, (New-Object System.Text.UTF8Encoding($false)))
  }
  $built = (Test-Path -LiteralPath (Join-Path $InstallRoot 'apps\octobrowser\dist\main.js')) -and
           (Test-Path -LiteralPath (Join-Path $InstallRoot 'apps\octodetect\dist\main.js'))
  if (-not $built) {
    Say (T 'ghBuilding')
    Invoke-Npm @('run', 'build')
    Say (T 'setupBuilt') 'Green'
  }
  if (-not $Quiet) { Say (T 'setupDone') 'Green' }
  return $true
}

# Everything that must be true before the apps can start from sources.
function Test-Ready {
  Update-SessionPath
  $node = Get-ToolVersion 'node'
  if (-not $node -or $node -lt [version]'22.12.0') { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'node_modules\.bin\electron.cmd'))) { return $false }
  foreach ($a in @('octobrowser', 'octodetect')) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "apps\$a\dist\main.js"))) { return $false }
  }
  return $true
}

# run.bat has no visible window, so it can neither show progress nor ask anything.
# When something is missing, the setup is started in a normal console the user can see.
function Start-VisibleSetup {
  $bat = Join-Path $ScriptsDir 'setup.bat'
  if (-not (Test-Path -LiteralPath $bat)) { Fail (T 'fileMissing' $bat) }
  Say (T 'runSetupVisible') 'Cyan'
  $noPause = $env:OCTO_NOPAUSE
  $hidden = $env:OCTO_HIDDEN
  [Environment]::SetEnvironmentVariable('OCTO_NOPAUSE', $null)
  [Environment]::SetEnvironmentVariable('OCTO_HIDDEN', $null)
  try {
    $p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', ('"' + $bat + '"')) -Wait -PassThru
    return ($p.ExitCode -eq 0)
  } finally {
    if ($noPause) { $env:OCTO_NOPAUSE = $noPause }
    if ($hidden) { $env:OCTO_HIDDEN = $hidden }
  }
}

# run.bat: make sure the apps can start, then start both of them with no console window.
function Invoke-Run {
  $script:UpdateFirst = [bool]$Update
  if (-not (Test-Path -LiteralPath (Get-AppExe 'octobrowser'))) {
    if (-not (Test-DevCheckout)) { Fail (T 'noSources' $InstallRoot) }
    if (-not (Test-Ready)) {
      if (-not (Start-VisibleSetup)) { return }
      if (-not (Test-Ready)) { Fail (T 'notBuilt') }
    }
    if ($script:UpdateFirst -and (Test-GitCheckout)) {
      try { Update-DevCheckout } catch { Warn (T 'updateFailed' $_.Exception.Message); $script:FailShown = $false }
    }
  }
  # An installed build updates itself from inside the app (it can show a window for that).
  Say (T 'startAll') 'Cyan'
  $script:Rest = @()
  Invoke-Open 'octobrowser'
  Start-Sleep -Milliseconds 800
  Invoke-Open 'octodetect'
}

# ------------------------------------------------------ GitHub update (github-update.bat)
# Two modes:
#   * installed build  -> read the newest GitHub release through the REST API, verify it
#                         (signed manifest when published, otherwise SHA256SUMS.txt +
#                         Authenticode + an explicit typed confirmation) and install it;
#   * development copy -> git pull --ff-only + npm ci (only when the lockfile changed) + npm run build.
# Only the official repository is contacted; any other host is refused.
$OfficialApi = "https://api.github.com/repos/$OfficialRepo"

# True when the scripts sit inside the OctoSuite source tree. A ZIP downloaded from GitHub
# has no .git folder, so git must NOT be part of this test (only github-update needs it).
function Test-DevCheckout {
  foreach ($f in @('package.json', 'tools\build.mjs', 'apps\octobrowser\package.json', 'apps\octodetect\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $f))) { return $false }
  }
  return $true
}

# True only for a real git clone (github-update can fast-forward it).
function Test-GitCheckout {
  return ((Test-DevCheckout) -and (Test-Path -LiteralPath (Join-Path $InstallRoot '.git')))
}

function Get-GithubJson([string]$url) {
  if (-not $url.StartsWith("$OfficialApi/")) { Fail (T 'urlNotOfficial' $url) }
  Set-Tls
  $headers = @{ 'User-Agent' = 'OctoSuite-scripts'; 'Accept' = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
  $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try { return (Invoke-RestMethod -Uri $url -Headers $headers -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 30) }
  finally { $ProgressPreference = $old }
}

# Newest published release (a pre-release is used only when there is no stable one).
function Get-GithubLatestRelease {
  try { return (Get-GithubJson "$OfficialApi/releases/latest") } catch { Write-Log 'warn' "releases/latest: $($_.Exception.Message)" }
  try {
    $all = @(Get-GithubJson "$OfficialApi/releases?per_page=10" | Where-Object { -not $_.draft })
    if ($all.Count -gt 0) { return $all[0] }
  } catch { Write-Log 'warn' "releases: $($_.Exception.Message)" }
  return $null
}

function Get-ReleaseAsset($release, [string]$pattern) {
  foreach ($a in @($release.assets)) {
    if ([string]$a.name -match $pattern) { return $a }
  }
  return $null
}

# Downloads a release asset after checking its name and that the URL is an official release URL.
function Save-ReleaseAsset($asset, [string]$dir) {
  if ([string]$asset.name -notmatch '^[\w.-]+$') { Fail 'invalid asset name in the GitHub release' }
  $dest = Join-Path $dir ([string]$asset.name)
  Invoke-Download ([string]$asset.browser_download_url) $dest
  return $dest
}

function Invoke-Npm([string[]]$npmArgs) {
  $npm = Resolve-Tool 'npm'
  if (-not $npm) { Fail (T 'ghNpmMissing') }
  $r = Invoke-Native $npm $npmArgs $InstallRoot
  if ($r.code -ne 0) {
    # Keep the tail of the output in the log so a failed install can be diagnosed later.
    foreach ($line in @($r.text -split "`r?`n" | Select-Object -Last 20)) { Write-Log 'error' $line }
    Fail (T 'ghNpmFailed' ($npmArgs -join ' ') $r.code)
  }
}

function Invoke-Git([string[]]$gitArgs) {
  $git = Resolve-Tool 'git'
  if (-not $git) { Fail (T 'ghGitMissing') }
  return (Invoke-Native $git (@('-C', $InstallRoot) + $gitArgs) $null -Quiet)
}

function Update-DevCheckout {
  Say (T 'ghDevDetected' $InstallRoot) 'Cyan'
  $status = Invoke-Git @('status', '--porcelain')
  if ($status.code -ne 0) { Fail $status.text }
  if ($status.text) { Fail (T 'ghGitDirty') }
  $before = (Invoke-Git @('rev-parse', '--short', 'HEAD')).text
  $lockBefore = ''
  $lock = Join-Path $InstallRoot 'package-lock.json'
  if (Test-Path -LiteralPath $lock) { $lockBefore = Get-FileSha256 $lock }
  Say (T 'checking' "https://github.com/$OfficialRepo") 'Cyan'
  $pull = Invoke-Git @('pull', '--ff-only')
  if ($pull.code -ne 0) { Fail $pull.text }
  Write-Log 'info' $pull.text
  $after = (Invoke-Git @('rev-parse', '--short', 'HEAD')).text
  $changed = ($after -ne $before)
  if (-not $changed) { Say (T 'ghGitUpToDate' $after) 'Green' } else { Say (T 'ghGitPulled' $before $after) 'Green' }
  if ($CheckOnly) { return }
  $lockAfter = ''
  if (Test-Path -LiteralPath $lock) { $lockAfter = Get-FileSha256 $lock }
  if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'node_modules')) -or ($lockAfter -ne $lockBefore)) {
    Say (T 'ghDeps')
    Invoke-Npm @('ci', '--no-audit', '--no-fund')
  }
  $built = (Test-Path -LiteralPath (Join-Path $InstallRoot 'apps\octobrowser\dist\main.js')) -and
           (Test-Path -LiteralPath (Join-Path $InstallRoot 'apps\octodetect\dist\main.js'))
  if ($changed -or -not $built) {
    Say (T 'ghBuilding')
    Invoke-Npm @('run', 'build')
  }
  Say (T 'ghDevDone') 'Green'
}

function Update-InstalledFromGithub {
  $exe = Get-AppExe 'octobrowser'
  $installed = [string](Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  Say (T 'ghChecking' $OfficialBase) 'Cyan'
  $release = Get-GithubLatestRelease
  if (-not $release) { Say (T 'ghNoRelease') 'Yellow'; return }
  $version = ([string]$release.tag_name) -replace '^v', ''
  if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { Fail "invalid release tag: $($release.tag_name)" }
  Say (T 'ghLatest' $version ([string]$release.published_at))
  $newer = $false
  try { $newer = ([version]($version -replace '-.*$', '')) -gt ([version]($installed -replace '-.*$', '')) } catch { $newer = ($version -ne $installed) }
  if (-not $newer) { Say (T 'upToDate' $installed $version) 'Green'; return }
  $severity = 'recommended'
  if ($release.prerelease) { $severity = 'optional' }
  Say (T 'updateAvailable' $installed $version $severity) 'Cyan'
  if ($release.body) { Write-Host ([string]$release.body) }
  if ($CheckOnly) { return }
  if (-not (Confirm-Action '')) { Stop-Cancelled }

  $setup = Get-ReleaseAsset $release '^OctoSuite-Setup-.+\.exe$'
  if (-not $setup) { Fail (T 'ghNoAsset') }
  $work = Join-Path $env:TEMP ('OctoSuite-gh-{0}' -f [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    $installer = Save-ReleaseAsset $setup $work
    $manifestAsset = Get-ReleaseAsset $release '^latest\.json$'
    $sigAsset = Get-ReleaseAsset $release '^latest\.json\.sig$'
    if ($manifestAsset -and $sigAsset) {
      $manifest = Save-ReleaseAsset $manifestAsset $work
      Save-ReleaseAsset $sigAsset $work | Out-Null
      Assert-ManifestResult (Invoke-ManifestVerify $manifest $installer)
    } else {
      Warn (T 'noManifest')
      $sums = Get-ReleaseAsset $release '^SHA256SUMS\.txt$'
      if ($sums) { Save-ReleaseAsset $sums $work | Out-Null }
      Test-Sha256Sums $installer
      if (-not (Confirm-Word (T 'ghUnverifiedAsk') @('YES', 'TAK'))) { Stop-Cancelled }
    }
    Test-Authenticode $installer
    Assert-NotRunning @('octobrowser', 'octodetect')
    Backup-Configs (Get-Date -Format 'yyyyMMdd-HHmmss')
    $bs = Read-Bootstrap 'octobrowser'
    if ($bs) {
      $keep = Join-Path ([string]$bs.dataDir) 'updater\installed'
      New-Item -ItemType Directory -Path $keep -Force | Out-Null
      Copy-Item -LiteralPath $installer -Destination (Join-Path $keep ('{0}.exe' -f $version)) -Force
      Get-ChildItem -LiteralPath $keep -Filter '*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
      Say (T 'keptForRollback' $keep)
    }
    Invoke-Installer $installer -Silent
    Say (T 'done') 'Green'
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-GithubUpdate {
  if (Test-Path -LiteralPath (Get-AppExe 'octobrowser')) { Update-InstalledFromGithub; return }
  if (Test-GitCheckout) { Update-DevCheckout; return }
  # Sources without .git (ZIP download): there is nothing to pull, but we can still
  # make sure everything is installed and built.
  if (Test-DevCheckout) { Warn (T 'ghNoGitDir'); [void](Invoke-Setup); return }
  Fail (T 'notInstalled' 'OctoBrowser.su' $InstallRoot)
}

# ------------------------------------------------------ start both apps (start-all.bat)
function Invoke-StartAll {
  if ($NoUpdate) {
    Say (T 'updateSkipped')
  } else {
    try {
      Invoke-GithubUpdate
    } catch [System.OperationCanceledException] {
      Say (T 'cancelled') 'Yellow'
    } catch {
      Warn (T 'updateFailed' $_.Exception.Message)
    }
    # An update problem must never stop the apps from starting.
    $script:FailShown = $false
  }
  Say (T 'startAll') 'Cyan'
  $script:Rest = @()
  Invoke-Open 'octobrowser'
  Start-Sleep -Milliseconds 800
  Invoke-Open 'octodetect'
  Say (T 'done') 'Green'
}

# ------------------------------------------------------------------ main
$exitCode = 0
$script:FailShown = $false
try {
  Initialize-Log
  Write-Log 'info' ("start lang={0} ps={1}" -f $Lang, $PSVersionTable.PSVersion)
  switch ($Command.ToLowerInvariant()) {
    'open' { Invoke-Open 'octobrowser' }
    'open-detect' { Invoke-Open 'octodetect' }
    'install' { Invoke-Install }
    'setup' { [void](Invoke-Setup) }
    'run' { Invoke-Run }
    'update' { Invoke-Update }
    'github-update' { Invoke-GithubUpdate }
    'start-all' { Invoke-StartAll }
    'repair' { Invoke-Repair }
    'uninstall' { Invoke-Uninstall }
    'reset-profile' { Invoke-ResetProfile }
    'backup-profile' { Invoke-BackupProfile }
    'restore-profile' { Invoke-RestoreProfile }
    default { Fail (T 'unknownCommand' $Command) }
  }
} catch [System.OperationCanceledException] {
  $exitCode = 2
} catch {
  $exitCode = 1
  if (-not $script:FailShown) {
    Write-Host (T 'error' $_.Exception.Message) -ForegroundColor Red
    Write-Log 'error' $_.Exception.Message
  }
} finally {
  if ($script:LogFile -and $Command -notmatch '^(open|run$)') { Write-Host (T 'logAt' (Protect-LogText $script:LogFile)) -ForegroundColor DarkGray }
  Write-Log 'info' "end code=$exitCode"
}
exit $exitCode
