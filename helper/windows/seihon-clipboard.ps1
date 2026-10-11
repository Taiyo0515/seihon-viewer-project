# Seihon Viewer - clipboard helper for Windows (Chrome native messaging host)
#
# The Seihon Viewer extension saves a PDF or images in the Downloads folder and sends their paths here.
# This script puts those files on the clipboard (like "Copy" in Explorer), so they can be pasted as files.
# It only reads one message from Chrome, sets the clipboard and exits. It does not use the network.
#
# Message (UTF-8 JSON with a 4-byte length):  {"type":"ping"}  or  {"type":"copy-files","paths":["C:\\...\\a.pdf"]}

$ErrorActionPreference = 'Stop'
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

function Write-Message($obj) {
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 4
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $length = [BitConverter]::GetBytes([int32]$bytes.Length)
  $stdout.Write($length, 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
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
  # true: keep the data on the clipboard after this script exits (retry 10 times if another app holds the clipboard)
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
}

try {
  $header = Read-Exact 4
  if ($null -eq $header) { exit 0 }
  $length = [BitConverter]::ToInt32($header, 0)
  if ($length -le 0 -or $length -gt 1048576) {
    Write-Message @{ ok = $false; error = 'bad-length' }
    exit 1
  }
  $body = Read-Exact $length
  if ($null -eq $body) { exit 1 }
  $message = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
  switch ($message.type) {
    'ping' {
      Write-Message @{ ok = $true; version = 1; os = 'windows' }
    }
    'copy-files' {
      $paths = @()
      foreach ($p in @($message.paths)) {
        if (($p -is [string]) -and [System.IO.File]::Exists($p)) {
          $paths += [System.IO.Path]::GetFullPath($p)
        }
      }
      if ($paths.Count -eq 0) {
        Write-Message @{ ok = $false; error = 'not-found' }
      } elseif ($env:SEIHON_HELPER_TEST) {
        # Test mode (does not touch the clipboard)
        Write-Message @{ ok = $true; count = $paths.Count; test = $true; paths = $paths }
      } else {
        Set-ClipboardFiles $paths
        Write-Message @{ ok = $true; count = $paths.Count }
      }
    }
    default {
      Write-Message @{ ok = $false; error = 'unknown-type' }
    }
  }
} catch {
  try { Write-Message @{ ok = $false; error = [string]$_.Exception.Message } } catch {}
  exit 1
}
