$ErrorActionPreference = 'Stop'

$repoUrl = 'https://github.com/shahvrushabh646-wq/mitra-ai-tutor-v2.zip.git'
$here = (Get-Location).Path
$preferredZip = Join-Path $here 'mitra-ai-tutor-source.zip'

if (Test-Path $preferredZip) {
  $zip = $preferredZip
} else {
  $candidates = @(Get-ChildItem -Path $here -Filter 'mitra-ai-tutor-source*.zip' -File)
  if ($candidates.Count -eq 0) {
    $candidates = @(Get-ChildItem -Path $here -Filter '*.zip' -File |
      Where-Object { $_.Name -notmatch 'restore|backup' })
  }
  if ($candidates.Count -eq 0) {
    throw "No source ZIP found in $here. Put the original Mitra project ZIP in this folder."
  }
  if ($candidates.Count -gt 1) {
    Write-Host 'More than one ZIP found. Choose the original Mitra source ZIP:' -ForegroundColor Yellow
    $candidates | ForEach-Object { Write-Host " - $($_.Name)" }
    throw "Rename the correct source archive to mitra-ai-tutor-source.zip, then rerun."
  }
  $zip = $candidates[0].FullName
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Git is required. Install Git for Windows, then reopen PowerShell.'
}

$work = Join-Path $env:TEMP 'mitra-ai-tutor-restore'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null

Write-Host "Using source archive: $zip"
Expand-Archive -Path $zip -DestinationPath $work -Force
$source = Join-Path $work 'mitra-ai-tutor'
if (-not (Test-Path (Join-Path $source 'src/main.tsx'))) {
  throw 'ZIP validation failed: src/main.tsx is missing.'
}
if (-not (Test-Path (Join-Path $source 'server/vercelEntry.ts'))) {
  throw 'ZIP validation failed: server/vercelEntry.ts is missing.'
}
if (-not (Test-Path (Join-Path $source 'api/index.js'))) {
  throw 'ZIP validation failed: api/index.js is missing.'
}

$repo = Join-Path $work 'repo'
git clone $repoUrl $repo
if ($LASTEXITCODE -ne 0) {
  throw 'Git clone failed. Check your network and try again.'
}

# Replace the repository's project files with the complete validated archive,
# while preserving the cloned .git directory.
Get-ChildItem -Force $source | ForEach-Object {
  $dest = Join-Path $repo $_.Name
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Copy-Item $_.FullName $dest -Recurse -Force
}

Set-Location $repo
git add -A
if ($LASTEXITCODE -ne 0) { throw 'git add failed.' }

Write-Host ''
Write-Host 'Files staged for restoration:' -ForegroundColor Cyan
git status --short
Write-Host ''
Write-Host 'This will push the complete source tree to main and may trigger Vercel deployment.' -ForegroundColor Yellow
$answer = Read-Host 'Type PUSH to continue'
if ($answer -cne 'PUSH') { throw 'Cancelled; no commit or push was performed.' }

git config user.name
if ($LASTEXITCODE -ne 0) {
  $name = Read-Host 'Git commit author name'
  git config user.name $name
}
git config user.email
if ($LASTEXITCODE -ne 0) {
  $email = Read-Host 'Git commit author email'
  git config user.email $email
}

git commit -m 'Restore complete Mitra AI Tutor source from project archive'
if ($LASTEXITCODE -ne 0) { throw 'Commit failed. Review the Git output and retry.' }

git push origin HEAD:main
if ($LASTEXITCODE -ne 0) {
  throw 'Push failed. Sign in to GitHub in Git Credential Manager, then rerun the script.'
}

Write-Host ''
Write-Host 'Source restoration pushed to main.' -ForegroundColor Green
Write-Host 'Now check Vercel > Deployments and inspect the latest build logs. Build success is not yet verified.' -ForegroundColor Yellow
