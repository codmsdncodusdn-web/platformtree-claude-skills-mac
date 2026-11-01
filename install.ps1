# 플랫폼트리 Claude 스킬 설치 (Windows)
# 사용법: PowerShell에 아래 한 줄 붙여넣기
#   irm https://raw.githubusercontent.com/codmsdncodusdn-web/platformtree-claude-skills-mac/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'
$repo = 'codmsdncodusdn-web/platformtree-claude-skills-mac'
$skills = @('cut-filler')

$tmp = Join-Path $env:TEMP ('platformtree-skills-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host '스킬을 내려받는 중...'
  $zip = Join-Path $tmp 'repo.zip'
  Invoke-WebRequest "https://github.com/$repo/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $root = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1

  $dest = Join-Path $HOME '.claude\skills'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  foreach ($s in $skills) {
    $to = Join-Path $dest $s
    if (Test-Path $to) { Remove-Item -Recurse -Force $to }
    Copy-Item -Recurse -Path (Join-Path $root.FullName "plugins\$s\skills\$s") -Destination $to
    Write-Host "[완료] $s -> $to"
  }
  Write-Host ''
  Write-Host 'Claude 앱을 다시 열고 영상을 넣은 뒤 "군말 잘라줘"라고 말해 보세요.'
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
