<#
.SYNOPSIS
Rename this plugin's package name inside a DSH profile.

.DESCRIPTION
Keep the profile's idea of this plugin's name and the checkout's own name in
agreement.

A profile records a plugin's package name in five places, and a rename that
changes four of them leaves a row the Loader cannot resolve — so this script
changes all five together, keeps the plugin's own configuration intact, verifies
the result, and can put everything back.

  1. cordis.patch.yml          the row's `name:`
  2. package.json              dsh.profile.bundles[]
  3. package.json              dependencies key
  4. pnpm-lock.yaml            the importer key
  5. node_modules\<name>       the junction to the checkout

**The checkout's manifest decides the name.** The target is read from
`package.json` in the checkout this script lives in, and the name the profile
currently installs is discovered by finding the junction in `node_modules` that
points at that same checkout. Nothing is assumed about either, so the script
migrates in whichever direction is needed — including back, which is how a
profile that drifted away from its checkout is repaired. Running it when the two
already agree reports that and stops.

**An uncommitted rename is refused.** This is the failure the guard exists for: a
profile that asks for `dsh-llm-opencode-go` while the checkout's manifest still
says `dsh-opencode-go` — because the rename only ever lived in the working tree
and a later `git stash`, `checkout`, or `rebase` took it away — resolves to a
package whose name no longer matches the row. The client bundle is then not found
(the plugin's configuration page disappears) and the row's identity is wrong
(models stop resolving). Commit the rename first, then run this; `-AllowUncommitted`
proceeds anyway and warns that the next git operation will break the pairing.

What it deliberately does NOT touch: the provider route (`opencode-go`), the
`userAgentProduct` default, the `/opencode-go/*` HTTP prefix, and the cache file
names. Those identify this client to the gateway and to sessions that have
already been created rather than to the Loader; renaming them would change what
the service sees, invalidate every conversation that has selected a model, and
orphan recorded usage.

Run it with -DryRun first: that prints the whole plan, changes nothing, and is
safe to run while DSH is open. The real run refuses while DSH is running, because
a profile patch is a live file — it is re-read on reload, and a reload landing
between the junction rename and the patch rewrite would fail to resolve the row.

.PARAMETER Profile
The profile to migrate. Default: desktop.

.PARAMETER OldName
The name the profile currently installs. Discovered from `node_modules` when
omitted, which is the normal case; pass it only to override the search.

.PARAMETER NewName
The name to migrate to. Defaults to the `name` in this checkout's package.json,
which is the authoritative answer and the reason the default is not spelled out
here.

.PARAMETER AllowUncommitted
Proceed even though the checkout's name is not committed. The pairing will break
again at the next git operation that touches the checkout.

.PARAMETER DshHome
The DSH home directory holding `profiles\`. Default: $env:USERPROFILE\.dsh.

.PARAMETER DryRun
Print every planned change and make none. Safe while DSH is running.

.PARAMETER Force
Proceed even though DSH appears to be running. The profile patch is live, so this
can leave the running instance with an unresolvable row until it is restarted.

.PARAMETER Reconcile
After the rename, run pnpm so it normalizes the lockfile and node_modules itself.
The deterministic edits are complete without it; this is for anyone who would
rather pnpm owned the result.

.PARAMETER Rollback
Restore a previous run from its backup directory, then exit. Pass the directory
the earlier run printed.

.EXAMPLE
# Look before touching anything (fine to run with DSH open)
.\scripts\migrate-package-name.ps1 -DryRun

.EXAMPLE
# Close DSH first, then run it for real
.\scripts\migrate-package-name.ps1

.EXAMPLE
# Put it back
.\scripts\migrate-package-name.ps1 -Rollback "$env:USERPROFILE\.dsh\backups\rename-20261003-170000"
#>

[CmdletBinding()]
param(
  [string] $Profile = 'desktop',
  [string] $OldName = '',
  [string] $NewName = '',
  [string] $DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [switch] $DryRun,
  [switch] $Force,
  [switch] $AllowUncommitted,
  [switch] $Reconcile,
  [string] $Rollback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The three files this migration edits, plus the junction. Named once, so the
# backup, the edit, the verify step, and the rollback all speak about one set.
$PATCH_FILE = 'cordis.patch.yml'
$MANIFEST_FILE = 'package.json'
$LOCK_FILE = 'pnpm-lock.yaml'

# Written without a BOM: these are files DSH and pnpm read, and a BOM added here
# would be a change nobody asked for. Line endings are preserved by never
# splitting the text — every edit below is a regex over the whole file.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Head([string] $text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Write-Item([string] $text) { Write-Host "   $text" }
function Write-Ok([string] $text) { Write-Host "   [ok] $text" -ForegroundColor Green }
function Write-Plan([string] $text) { Write-Host "   [plan] $text" -ForegroundColor Yellow }
function Write-Warn([string] $text) { Write-Host "   [warn] $text" -ForegroundColor Yellow }

function Stop-With([string] $text) {
  Write-Host ''
  Write-Host "refusing to continue: $text" -ForegroundColor Red
  exit 1
}

function Read-Text([string] $path) { [System.IO.File]::ReadAllText($path) }

function Write-Text([string] $path, [string] $text) {
  if ($DryRun) { return }
  [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}

# A PSCustomObject property read throws under StrictMode when the key is absent,
# and "the dependency is not there" is an ordinary answer here rather than a
# fault, so every manifest lookup goes through this.
function Get-Property($object, [string] $name) {
  if ($null -eq $object) { return $null }
  $property = $object.PSObject.Properties[$name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

# The plugin row's own block in a patch, so its config can be compared across the
# edit. A patch is a top-level array of `- ` entries; the row is the one whose
# `name:` is the package name being migrated. Matching on the name rather than on
# the id is deliberate: the id stays `opencode-go` — it is what the profile's
# `agent-default-model.provider` points at — so only the name identifies the row
# this script owns.
function Get-RowBlock([string] $patchText, [string] $name) {
  $pattern = '(?m)^(?=- )'
  foreach ($block in [regex]::Split($patchText, $pattern)) {
    if ($block -match ('(?m)^\s*name:\s*["'']?' + [regex]::Escape($name) + '["'']?\s*$')) { return $block }
  }
  return $null
}

# Everything from `config:` to the end of a row block — the part that must not
# change, and the thing a careless rename would quietly rewrite.
function Get-RowConfig([string] $block) {
  if ($null -eq $block) { return $null }
  $match = [regex]::Match($block, '(?ms)^\s*config:.*$')
  if (-not $match.Success) { return '' }
  return $match.Value
}

# Whether any process that looks like DSH is running.
#
# The returned array is wrapped in a unary comma, and that comma is load-bearing
# under `Set-StrictMode -Version Latest` on Windows PowerShell 5.1: a function's
# output is unrolled onto the pipeline, so a bare `@(...)` comes back as `$null`
# when it held nothing and as a bare object when it held one — and `.Count` on
# either of those throws "The property 'Count' cannot be found on this object"
# rather than answering 0 or 1. That is not a hypothetical: it is how this script
# failed the first time it was run with DSH already closed, which is the normal
# case for using it.
function Get-RunningDsh() {
  $result = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DeepSeek|^dsh' })
  return ,$result
}

# A count that is safe whatever the caller's helper handed back, for the same
# StrictMode reason: `@($null)` would count one, so the null case is answered
# before the array is built rather than by wrapping.
function Get-Count($value) {
  if ($null -eq $value) { return 0 }
  return @($value).Count
}

# A junction's `Target` is whatever the reparse point stores, and the shell
# decorates it by how the link was made: `New-Item -ItemType Junction` reads back
# with a `Global\` prefix while a link pnpm created reads back as a bare path, and
# the raw form is `\??\`. Comparing unnormalized paths would report a mismatch for
# a junction this script had just made itself.
function Get-JunctionTarget([string] $path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  if ($item.LinkType -ne 'Junction' -and $item.LinkType -ne 'SymbolicLink') { return $null }
  $target = $item.Target | Select-Object -First 1
  if ($null -eq $target) { return $null }
  foreach ($prefix in @('Global\', '\??\')) {
    if ($target.StartsWith($prefix)) { return $target.Substring($prefix.Length) }
  }
  return $target
}

# ---------------------------------------------------------------- rollback only

if ($Rollback) {
  Write-Head "Rollback from $Rollback"
  if (-not (Test-Path -LiteralPath $Rollback)) { Stop-With "no such backup directory: $Rollback" }
  $manifestPath = Join-Path $Rollback 'migration.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { Stop-With "the backup has no migration.json: $Rollback" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

  # Read every field through one gate: a backup this script wrote always has them,
  # but a hand-edited or truncated one should be refused in words rather than
  # tripping StrictMode on a missing property three steps later.
  $backupProfileDir = Get-Property $manifest 'profileDir'
  $backupRepoPath = Get-Property $manifest 'repoPath'
  $backupOldName = Get-Property $manifest 'oldName'
  $backupNewName = Get-Property $manifest 'newName'
  foreach ($pair in @(
      @{ name = 'profileDir'; value = $backupProfileDir },
      @{ name = 'repoPath'; value = $backupRepoPath },
      @{ name = 'oldName'; value = $backupOldName },
      @{ name = 'newName'; value = $backupNewName })) {
    if ([string]::IsNullOrEmpty([string] $pair.value)) {
      Stop-With "the backup's migration.json has no '$($pair.name)'; it cannot be rolled back automatically"
    }
  }
  if (-not (Test-Path -LiteralPath $backupProfileDir)) { Stop-With "the backup names a profile that is not there: $backupProfileDir" }

  $running = Get-RunningDsh
  $runningCount = Get-Count $running
  if ($runningCount -gt 0 -and -not $Force) {
    $names = ($running | ForEach-Object { $_.ProcessName }) -join ', '
    Stop-With "DSH is running ($runningCount`: $names). Quit it, then run again."
  }

  $profileDir = $backupProfileDir
  foreach ($file in @($PATCH_FILE, $MANIFEST_FILE, $LOCK_FILE)) {
    $from = Join-Path $Rollback $file
    if (-not (Test-Path -LiteralPath $from)) {
      Write-Warn "the backup has no $file; leaving the profile's copy alone"
      continue
    }
    Copy-Item -LiteralPath $from -Destination (Join-Path $profileDir $file) -Force
    Write-Ok "restored $file"
  }

  # The junction is rebuilt rather than restored: a backup holds a copy of what
  # the link pointed at, never the link itself.
  $repoPath = $backupRepoPath
  $oldLink = Join-Path (Join-Path $profileDir 'node_modules') $backupOldName
  $newLink = Join-Path (Join-Path $profileDir 'node_modules') $backupNewName
  if (Test-Path -LiteralPath $newLink) {
    $target = Get-JunctionTarget $newLink
    if ($null -eq $target) { Stop-With "$newLink exists and is not a junction; remove it by hand first" }
    & cmd.exe /c "rmdir `"$newLink`"" | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $target 'package.json'))) {
      Stop-With "removing the junction also removed its target $target — recover that before anything else"
    }
    Write-Ok "removed the junction $backupNewName; its target is intact"
  }
  if (-not (Test-Path -LiteralPath $oldLink)) {
    New-Item -ItemType Junction -Path $oldLink -Target $repoPath | Out-Null
    Write-Ok "recreated $backupOldName -> $repoPath"
  }

  Write-Head 'Rolled back'
  Write-Item 'Start DSH and confirm the plugin row loads again.'
  exit 0
}

# -------------------------------------------------------------------- preflight

$suffix = if ($DryRun) { '  (dry run)' } else { '' }
Write-Head "Reconciling the profile's package name with this checkout$suffix"

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
if (-not (Test-Path -LiteralPath $profileDir)) { Stop-With "no such profile directory: $profileDir" }
Write-Ok "profile  $profileDir"

$patchPath = Join-Path $profileDir $PATCH_FILE
$manifestPath = Join-Path $profileDir $MANIFEST_FILE
$lockPath = Join-Path $profileDir $LOCK_FILE
foreach ($path in @($patchPath, $manifestPath)) {
  if (-not (Test-Path -LiteralPath $path)) { Stop-With "missing $path" }
}

# The checkout is wherever this script lives, and its manifest is the authority on
# the name: nothing here is spelled out, so the same script migrates forward to a
# new name and back again when a profile has drifted away from its checkout.
$repoPath = Split-Path $PSScriptRoot -Parent
$repoManifestPath = Join-Path $repoPath $MANIFEST_FILE
if (-not (Test-Path -LiteralPath $repoManifestPath)) { Stop-With "this script is not inside a package: no $repoManifestPath" }
$repoManifest = Get-Content -LiteralPath $repoManifestPath -Raw | ConvertFrom-Json
$targetName = if ($NewName -ne '') { $NewName } else { Get-Property $repoManifest 'name' }
if ([string]::IsNullOrEmpty([string] $targetName)) { Stop-With "$repoManifestPath declares no name" }
Write-Ok "checkout $repoPath"
Write-Ok "it declares  $targetName"

# The name the profile installs is discovered, not assumed: the junction whose
# target is this checkout is the one this script owns, and its directory name is
# the name in use however the profile got there.
$modulesDir = Join-Path $profileDir 'node_modules'
if (-not (Test-Path -LiteralPath $modulesDir)) { Stop-With "no node_modules in $profileDir" }
$installedName = if ($OldName -ne '') { $OldName } else {
  $found = $null
  foreach ($candidate in (Get-ChildItem -LiteralPath $modulesDir -Force -Directory -ErrorAction SilentlyContinue)) {
    $target = Get-JunctionTarget $candidate.FullName
    if ($null -eq $target) { continue }
    if ($target.TrimEnd('\', '/') -ieq $repoPath.TrimEnd('\', '/')) { $found = $candidate.Name; break }
  }
  $found
}
if ([string]::IsNullOrEmpty([string] $installedName)) {
  Stop-With "no junction in $modulesDir points at $repoPath — is this checkout installed in the '$Profile' profile at all?"
}
Write-Ok "the profile installs it as  $installedName"

# The repair case, and the one that must not be silent: the two sides agree, so
# there is nothing to do. This is the path a profile that drifted and was fixed
# again takes, so it is reported as success rather than as an error.
if ($installedName -eq $targetName) {
  Write-Head 'Already consistent'
  Write-Item "the profile installs '$installedName' and the checkout declares the same name"
  Write-Item 'nothing was changed.'
  exit 0
}

# The guard this script exists for. A rename that lives only in the working tree
# cannot stay paired with the profile: the next git operation reverts the
# checkout's manifest, and the profile is left asking for a name whose package
# declares a different one — which is exactly how the client bundle stops being
# found and the configuration page disappears.
$headName = $null
try {
  $headJson = & git -C $repoPath show "HEAD:package.json" 2>$null
  if ($LASTEXITCODE -eq 0 -and $headJson) { $headName = (($headJson -join "`n") | ConvertFrom-Json).name }
} catch { $headName = $null }
if ($null -eq $headName) {
  Write-Warn "could not read package.json at HEAD (no git, or a path outside a repository); skipping the commit check"
} elseif ($headName -ne $targetName) {
  if (-not $AllowUncommitted) {
    Stop-With @"
the checkout declares '$targetName' but HEAD still says '$headName' — the rename is
not committed.

Commit the rename first (package.json, lib/index.js `export const name`, and
lib/client.js PACKAGE_NAME, ROW_KEY and the factory id), then run this script.
Until it is committed the pairing is one 'git stash', 'git checkout', or
'rebase' away from breaking: the profile would keep asking for '$targetName'
while the checkout's manifest went back to '$headName', and a row whose package
declares a different name loses its client bundle — the configuration page
disappears and the route stops resolving.

Pass -AllowUncommitted to migrate anyway, knowing the next git operation that
touches this checkout will break it again.
"@
  }
  Write-Warn "the rename is not committed (HEAD says '$headName'); -AllowUncommitted was given"
  Write-Item "the pairing breaks at the next git operation that touches $repoPath"
} else {
  Write-Ok "the rename is committed (HEAD agrees: $headName)"
}

# DSH must not be running for the real run: the profile patch is live, so a reload
# landing between the junction rename and the patch rewrite asks the Loader for a
# name that no longer resolves. A dry run touches nothing and is always allowed.
$running = Get-RunningDsh
$runningCount = Get-Count $running
if ($DryRun) {
  if ($runningCount -gt 0) {
    Write-Warn "DSH is running ($runningCount process(es)); a dry run changes nothing"
    Write-Item 'the real run will refuse until DSH is closed'
  }
} elseif ($runningCount -gt 0 -and -not $Force) {
  $names = ($running | ForEach-Object { $_.ProcessName }) -join ', '
  Stop-With @"
DSH is running ($runningCount`: $names).

Exit DSH completely — all windows and the tray icon — then run this again. The
profile patch is re-read on reload, so changing it under a running instance can
leave the plugin row unresolved until a restart.

Use -DryRun if you only want to see the plan.
"@
} elseif ($runningCount -gt 0) {
  Write-Warn "DSH is running and -Force was given; a restart will be required"
} else {
  Write-Ok 'DSH is not running'
}

$OldName = $installedName
$NewName = $targetName
$oldLink = Join-Path $modulesDir $OldName
$newLink = Join-Path $modulesDir $NewName
if (Test-Path -LiteralPath $newLink) { Stop-With "$newLink already exists; resolve that by hand first" }
Write-Ok "the checkout is reachable as a package"

if ($repoPath -match [regex]::Escape($OldName)) {
  Stop-With "the checkout path itself contains '$OldName' ($repoPath); a text rename would rewrite the link target, so this needs a manual migration"
}

# --------------------------------------------------------- what will be edited

$patchText = Read-Text $patchPath
$rowBlock = Get-RowBlock $patchText $OldName
if ($null -eq $rowBlock) { Stop-With "$PATCH_FILE has no row whose name is '$OldName'" }
$rowConfigBefore = Get-RowConfig $rowBlock
$listEntries = ([regex]::Matches($rowConfigBefore, '(?m)^\s*-\s')).Count
Write-Ok "$PATCH_FILE row found; its config has $listEntries list entries (these are preserved)"

$manifestText = Read-Text $manifestPath
$quotedOld = '"' + $OldName + '"'
$quotedNew = '"' + $NewName + '"'
if ($manifestText -notmatch [regex]::Escape($quotedOld)) { Stop-With "$MANIFEST_FILE does not mention `"$OldName`"" }
$manifestParsed = $manifestText | ConvertFrom-Json
$linkSpec = Get-Property (Get-Property $manifestParsed 'dependencies') $OldName
if (-not $linkSpec) { Stop-With "$MANIFEST_FILE has no dependencies entry for '$OldName'" }
Write-Ok "$MANIFEST_FILE lists it as a bundle and as a dependency ($linkSpec)"

$lockText = ''
$lockHasEntry = $false
if (Test-Path -LiteralPath $lockPath) {
  $lockText = Read-Text $lockPath
  $lockHasEntry = $lockText -match ('(?m)^\s*' + [regex]::Escape($OldName) + ':')
  if ($lockHasEntry) { Write-Ok "$LOCK_FILE has an importer entry" }
  else { Write-Warn "$LOCK_FILE has no importer entry for '$OldName'; it will be left alone" }
} else {
  Write-Warn "no $LOCK_FILE; it will be skipped"
}

Write-Head 'Planned changes'
Write-Plan "$PATCH_FILE  — the row's name: (its config is left byte-for-byte alone)"
Write-Plan "$MANIFEST_FILE  — the bundles[] element and the dependencies key"
Write-Plan "$LOCK_FILE  — the importer key"
Write-Plan "node_modules\$OldName -> node_modules\$NewName  (the junction; its target is untouched)"
Write-Host ''
# The wire identity is a constant in the code, not a function of the package name,
# so it is read from there rather than inferred: after a repair migration the two
# are different strings and a message that guessed would be misleading. The read is
# best-effort — it only decorates the report, and a checkout that cannot answer
# should still migrate.
$configPath = Join-Path $repoPath 'lib\config.js'
$uaDefault = '(lib/config.js not found)'
$routeDefault = '(lib/config.js not found)'
if (Test-Path -LiteralPath $configPath) {
  $configText = Read-Text $configPath
  $uaMatch = [regex]::Match($configText, "DEFAULT_USER_AGENT_PRODUCT\s*=\s*'([^']+)'")
  $routeMatch = [regex]::Match($configText, "DEFAULT_PROVIDER\s*=\s*'([^']+)'")
  if ($uaMatch.Success) { $uaDefault = $uaMatch.Groups[1].Value }
  if ($routeMatch.Success) { $routeDefault = $routeMatch.Groups[1].Value }
}
Write-Item "unchanged on purpose: the provider route '$routeDefault', the User-Agent and"
Write-Item "x-opencode-client identity '$uaDefault', the /$routeDefault/* HTTP prefix, and the"
Write-Item 'usage and model cache file names'

if ($DryRun) {
  Write-Head 'Dry run: nothing was written'
  Write-Item 'Close DSH, then run this script again without -DryRun.'
  exit 0
}

# ----------------------------------------------------------------------- backup

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path (Join-Path $DshHome 'backups') "rename-$stamp"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item -LiteralPath $patchPath -Destination (Join-Path $backupDir $PATCH_FILE) -Force
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $backupDir $MANIFEST_FILE) -Force
if (Test-Path -LiteralPath $lockPath) { Copy-Item -LiteralPath $lockPath -Destination (Join-Path $backupDir $LOCK_FILE) -Force }
[ordered]@{
  profile    = $Profile
  profileDir = $profileDir
  oldName    = $OldName
  newName    = $NewName
  repoPath   = $repoPath
  linkSpec   = $linkSpec
  when       = (Get-Date).ToString('o')
} | ConvertTo-Json -Depth 6 | ForEach-Object { [System.IO.File]::WriteAllText((Join-Path $backupDir 'migration.json'), $_, $Utf8NoBom) }

Write-Head 'Backed up'
Write-Ok $backupDir
Write-Item "rollback: .\scripts\migrate-package-name.ps1 -Rollback `"$backupDir`""

# ------------------------------------------------------------------------ edits

try {
  Write-Head 'Renaming'

  # 1. The patch row's name, scoped to a `name:` line so the
  #    `provider: opencode-go` living inside another row's config cannot be caught.
  #    The class is `[ \t]` rather than `\s`: `\s` matches the newline, so a greedy
  #    match could reach past the end of the line it is supposed to own.
  $nameLine = '(?m)^([ \t]*name:[ \t]*["'']?)' + [regex]::Escape($OldName) + '(["'']?[ \t]*)$'
  $nextPatch = $patchText -replace $nameLine, ('${1}' + $NewName + '${2}')
  if ($nextPatch -eq $patchText) { Stop-With "the patch's name line did not match; nothing was written" }
  Write-Text $patchPath $nextPatch
  Write-Ok $PATCH_FILE

  # 2 and 3. The manifest's two quoted identifiers. Matching the quoted form is
  #    exactly the bundle element and the dependency key; the link value is a
  #    different string and stays as it is.
  $nextManifest = $manifestText -replace [regex]::Escape($quotedOld), $quotedNew
  $null = $nextManifest | ConvertFrom-Json   # refuse to write a manifest that will not parse
  Write-Text $manifestPath $nextManifest
  Write-Ok $MANIFEST_FILE

  # 4. The lockfile's importer key, which is unquoted.
  if ($lockHasEntry) {
    $keyLine = '(?m)^(\s*)' + [regex]::Escape($OldName) + ':'
    Write-Text $lockPath ($lockText -replace $keyLine, ('${1}' + $NewName + ':'))
    Write-Ok $LOCK_FILE
  }

  # 5. The junction, last: the files above must already agree before the name
  #    resolves, and the target must be proven intact right after the unlink —
  #    a junction removal that followed the link would take the checkout with it.
  $target = Get-JunctionTarget $oldLink
  if ($target -ne $repoPath) { Stop-With "the junction moved under us ($target); nothing further was changed" }
  & cmd.exe /c "rmdir `"$oldLink`"" | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-With "could not remove the junction $oldLink" }
  if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'package.json'))) {
    Stop-With "removing the junction also removed its target $repoPath — recover that before anything else"
  }
  New-Item -ItemType Junction -Path $newLink -Target $repoPath | Out-Null
  Write-Ok "node_modules\$OldName -> node_modules\$NewName"
} catch {
  Write-Host ''
  Write-Host "failed part-way through: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "restore with: .\scripts\migrate-package-name.ps1 -Rollback `"$backupDir`"" -ForegroundColor Yellow
  exit 1
}

# ---------------------------------------------------------------------- verify

Write-Head 'Verifying'
$problems = @()

# The invariant the whole migration exists to keep: the profile names a package,
# and that package's own manifest agrees.
$linkTarget = Get-JunctionTarget $newLink
if ($null -eq $linkTarget) { $problems += "node_modules\$NewName is not a junction" }
elseif ($linkTarget -ne $repoPath) { $problems += "the junction points at $linkTarget, not $repoPath" }
else { Write-Ok 'the junction resolves to the checkout' }

$patchAfter = Read-Text $patchPath
$rowAfter = Get-RowBlock $patchAfter $NewName
if ($null -eq $rowAfter) { $problems += "$PATCH_FILE has no row named '$NewName'" }
else {
  $rowConfigAfter = Get-RowConfig $rowAfter
  if ($rowConfigAfter -ne $rowConfigBefore) {
    $problems += "the plugin row's config changed; restore from $backupDir and report this"
  } else {
    Write-Ok "the row's config is byte-for-byte unchanged ($listEntries list entries)"
  }
}

$manifestAfter = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$dependenciesAfter = Get-Property $manifestAfter 'dependencies'
if ((Get-Property $dependenciesAfter $NewName) -ne $linkSpec) {
  $problems += 'the dependency entry is not the same link specifier it was'
} elseif (Get-Property $dependenciesAfter $OldName) {
  $problems += "the manifest still has a '$OldName' dependency"
} else {
  Write-Ok 'the manifest lists the new name as a bundle and as a dependency'
}

if ($lockHasEntry) {
  if ((Read-Text $lockPath) -match ('(?m)^\s*' + [regex]::Escape($OldName) + ':')) {
    $problems += "$LOCK_FILE still has the old importer key"
  } else {
    Write-Ok "$LOCK_FILE importer key renamed"
  }
}

# Anything left is either the wire identity this migration must not touch or a
# place that was missed. Report both, named, rather than letting a stale
# reference surface later as a Loader failure.
$leftovers = @()
Get-ChildItem -LiteralPath $profileDir -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object {
    $_.FullName -notlike '*\node_modules\*' -and
    $_.FullName -notlike '*\.plugin-manager\*' -and
    $_.Length -lt 2MB
  } |
  ForEach-Object {
    $file = $_
    foreach ($hit in (Select-String -LiteralPath $file.FullName -Pattern ([regex]::Escape($OldName)) -ErrorAction SilentlyContinue)) {
      $leftovers += "$($file.FullName.Replace($profileDir, '.')):$($hit.LineNumber)"
    }
  }
if ($leftovers.Count -eq 0) { Write-Ok "no stale references left in the profile" }
else {
  Write-Warn "these still contain '$OldName' — check each is intentional:"
  foreach ($line in $leftovers) { Write-Item $line }
}

if ($Reconcile) {
  Write-Head 'Reconciling with pnpm'
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpm) {
    Write-Warn 'pnpm is not on PATH; run it in the profile yourself if you want pnpm to own the result'
  } else {
    Push-Location $profileDir
    try {
      & $pnpm.Source install --prefer-offline 2>&1 | ForEach-Object { Write-Item $_ }
      if ($LASTEXITCODE -eq 0) { Write-Ok 'pnpm finished' } else { Write-Warn "pnpm exited with $LASTEXITCODE" }
    } finally { Pop-Location }
  }
}

Write-Host ''
if ($problems.Count -gt 0) {
  Write-Host 'the rename is incomplete:' -ForegroundColor Red
  foreach ($problem in $problems) { Write-Host "  - $problem" -ForegroundColor Red }
  Write-Host ''
  Write-Host "restore with: .\scripts\migrate-package-name.ps1 -Rollback `"$backupDir`"" -ForegroundColor Yellow
  exit 1
}

Write-Head 'Done'
Write-Item "backup:   $backupDir"
Write-Item "rollback: .\scripts\migrate-package-name.ps1 -Rollback `"$backupDir`""
Write-Host ''
Write-Item 'Next:'
Write-Item "  1. Start DSH."
Write-Item "  2. Its log should show:  $NewName`: provider `"opencode-go`" ready at https://opencode.ai/zen/go/v1"
Write-Item '  3. The sidebar foot should show the three quota rings, and Ctrl/Cmd+U the usage panel.'
Write-Item '  4. Plugins should list the bundle under its new name, with Configure on the opencode-go row.'
Write-Host ''
Write-Item 'hiddenModels and modelVariants were not touched: the row config is verified byte-identical.'
