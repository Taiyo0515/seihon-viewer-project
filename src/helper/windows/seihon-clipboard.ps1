# Seihon Viewer - clipboard helper for Windows (Chrome native messaging host)
#
# The Seihon Viewer extension sends the data of a PDF or images. This script saves them in the
# "Downloads" folder (sub folder given by the extension) and puts the files on the clipboard
# (like "Copy" in Explorer), so they can be pasted as files. Existing files are never overwritten.
# Saving does not go through Chrome downloads, so Chrome's "Ask where to save" setting does not apply.
# It does not use the network.
#
# Messages (UTF-8 JSON with a 4-byte length):
#   {"type":"ping"}
#   {"type":"begin","root":"...","folder":"","files":[{"name":"a.pdf","size":123}]}
#   {"type":"begin","place":"temp",...}            (version 3: save in a hidden temp folder, not in Downloads.
#                                                    The files of the previous copy are deleted: each copy is single-use)
#   {"type":"chunk","index":0,"data":"<base64>"}   (file contents, in order; each message is small)
#   {"type":"finish"}                               (close the files and put them on the clipboard)
#   {"type":"copy-files","paths":["C:\\...\\a.pdf"]}
#   {"type":"reveal","path":"C:\\...\\a.pdf"}       (open the folder in Explorer)

$ErrorActionPreference = 'Stop'
$Version = 3
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Exact([int]$count) {
  $buffer = New-Object byte[] $count
  $offset = 0
  while ($offset -lt $count) {
    $n = $stdin.Read($buffer, $offset, $count - $offset)
    if ($n -le 0) { return $null }
    $offset += $n
  }
  return ,$buffer
}

function Read-Message {
  $header = Read-Exact 4
  if ($null -eq $header) { return $null }
  $length = [BitConverter]::ToInt32($header, 0)
  if ($length -le 0 -or $length -gt 67108864) { throw 'bad-length' }
  $body = Read-Exact $length
  if ($null -eq $body) { return $null }
  # Messages are kept under 2 MB by the extension (ConvertFrom-Json limit of Windows PowerShell 5.1)
  return [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
}

function Write-Message($obj) {
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 4
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $length = [BitConverter]::GetBytes([int32]$bytes.Length)
  $stdout.Write($length, 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Get-DownloadsDir {
  try {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    $value = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'{374DE290-123F-4565-9164-39C4925E467B}'
    if ($value) {
      $path = [Environment]::ExpandEnvironmentVariables($value)
      if (Test-Path -LiteralPath $path -PathType Container) { return $path }
    }
  } catch {}
  $userHome = [Environment]::GetFolderPath('UserProfile')
  if ($userHome) {
    $path = Join-Path $userHome 'Downloads'
    if (Test-Path -LiteralPath $path -PathType Container) { return $path }
    return $userHome
  }
  return [IO.Path]::GetTempPath()
}

function Get-SafeName([string]$name) {
  # No path separators or reserved characters: files always stay in the folder
  $n = ($name -replace '[\\/:*?"<>|\x00-\x1f]', '_').Trim().TrimEnd('.').TrimStart('.')
  if ($n.Length -gt 150) { $n = $n.Substring(0, 150) }
  if (-not $n) { $n = 'file' }
  return $n
}

function Get-UniquePath([string]$dir, [string]$name) {
  $path = Join-Path $dir $name
  if (-not (Test-Path -LiteralPath $path)) { return $path }
  $stem = [IO.Path]::GetFileNameWithoutExtension($name)
  $ext = [IO.Path]::GetExtension($name)
  $n = 1
  while ($true) {
    $path = Join-Path $dir ('{0} ({1}){2}' -f $stem, $n, $ext)
    if (-not (Test-Path -LiteralPath $path)) { return $path }
    $n++
  }
}

function Set-ClipboardFiles([string[]]$paths) {
  Add-Type -AssemblyName System.Windows.Forms
  $list = New-Object System.Collections.Specialized.StringCollection
  foreach ($p in $paths) { [void]$list.Add($p) }
  $data = New-Object System.Windows.Forms.DataObject
  $data.SetFileDropList($list)
  # Paste in Explorer = copy (not move)
  $effect = New-Object System.IO.MemoryStream (, [byte[]](5, 0, 0, 0))
  $data.SetData('Preferred DropEffect', $effect)
  # true: keep the data on the clipboard after this script exits (retry if another app holds the clipboard)
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
}

function Copy-Files($paths) {
  $found = @()
  foreach ($p in @($paths)) {
    if (($p -is [string]) -and [System.IO.File]::Exists($p)) { $found += [System.IO.Path]::GetFullPath($p) }
  }
  if ($found.Count -eq 0) { return @{ ok = $false; error = 'not-found' } }
  if ($env:SEIHON_HELPER_TEST) { return @{ ok = $true; count = $found.Count; test = $true; paths = $found } }
  Set-ClipboardFiles $found
  return @{ ok = $true; count = $found.Count; paths = $found }
}

$session = @{ paths = @(); sizes = @() }

# The hidden folder for copies (only this folder is ever cleaned up)
function Get-TempCopyDir {
  return (Join-Path ([IO.Path]::GetTempPath()) 'seihon-viewer-copy')
}

function New-TempCopyDir {
  $base = Get-TempCopyDir
  [void][IO.Directory]::CreateDirectory($base)
  # Delete the previous copies (a file still open in another app is left; it is tried again next time)
  foreach ($item in @(Get-ChildItem -LiteralPath $base -Force -ErrorAction SilentlyContinue)) {
    try { Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop } catch {}
  }
  $dir = Join-Path $base ('copy-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff'))
  [void][IO.Directory]::CreateDirectory($dir)
  return $dir
}

function Start-Session($message) {
  $files = @($message.files)
  if ($files.Count -eq 0) { return @{ ok = $false; error = 'no-files' } }
  if ([string]$message.place -eq 'temp') {
    $dir = New-TempCopyDir
  } else {
    $root = Get-SafeName ([string]$message.root)
    $dir = Join-Path (Get-DownloadsDir) $root
    [void][IO.Directory]::CreateDirectory($dir)
  }
  if ($message.folder) {
    $dir = Get-UniquePath $dir (Get-SafeName ([string]$message.folder))
    [void][IO.Directory]::CreateDirectory($dir)
  }
  $session.paths = @()
  $session.sizes = @()
  foreach ($f in $files) {
    $path = Get-UniquePath $dir (Get-SafeName ([string]$f.name))
    [IO.File]::WriteAllBytes($path, [byte[]]@())
    $session.paths += $path
    $session.sizes += [int64]$f.size
  }
  return @{ ok = $true; paths = $session.paths; dir = $dir }
}

function Add-Chunk($message) {
  $index = [int]$message.index
  if ($index -lt 0 -or $index -ge $session.paths.Count) { return @{ ok = $false; error = 'bad-index' } }
  $bytes = [Convert]::FromBase64String([string]$message.data)
  $stream = [IO.File]::Open($session.paths[$index], [IO.FileMode]::Append, [IO.FileAccess]::Write)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Close() }
  return @{ ok = $true }
}

function Complete-Session {
  for ($i = 0; $i -lt $session.paths.Count; $i++) {
    if ((Get-Item -LiteralPath $session.paths[$i]).Length -ne $session.sizes[$i]) { return @{ ok = $false; error = 'size-mismatch' } }
  }
  return Copy-Files $session.paths
}

function Show-InFolder($path) {
  if (-not (($path -is [string]) -and (Test-Path -LiteralPath $path))) { return @{ ok = $false; error = 'not-found' } }
  if ($env:SEIHON_HELPER_TEST) { return @{ ok = $true; test = $true } }
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"{0}"' -f $path)
  return @{ ok = $true }
}

try {
  while ($true) {
    $message = Read-Message
    if ($null -eq $message) { break }
    try {
      switch ($message.type) {
        'ping' { Write-Message @{ ok = $true; version = $Version; os = 'windows'; dir = (Get-DownloadsDir) } }
        'begin' { Write-Message (Start-Session $message) }
        'chunk' { Write-Message (Add-Chunk $message) }
        'finish' { Write-Message (Complete-Session) }
        'copy-files' { Write-Message (Copy-Files $message.paths) }
        'reveal' { Write-Message (Show-InFolder $message.path) }
        default { Write-Message @{ ok = $false; error = 'unknown-type' } }
      }
    } catch {
      Write-Message @{ ok = $false; error = [string]$_.Exception.Message }
    }
  }
} catch {
  try { Write-Message @{ ok = $false; error = [string]$_.Exception.Message } } catch {}
  exit 1
}
