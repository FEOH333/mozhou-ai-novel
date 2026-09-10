param(
  [Parameter(Mandatory = $true)]
  [int]$Port
)

$testDataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("novel-e2e-v077-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDataDir | Out-Null
$env:NOVEL_DATA_DIR = $testDataDir
$env:NOVEL_PORT = [string]$Port
$env:NOVEL_NO_OPEN = '1'
$env:NOVEL_MOCK_LLM = '1'
$env:NOVEL_FAULT = ''
node server/index.js
