param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$name = 'com.seihon_viewer.tex'
$directory = Join-Path $env:LOCALAPPDATA 'SeihonViewer\TexLive'
$manifest = Join-Path $directory "$name.json"
$registry = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$name"
$exe = Join-Path $directory 'TexHost.exe'
$config = Join-Path $directory 'tex-bin.txt'
if ($Uninstall) {
    if ((Test-Path -LiteralPath $registry) -and (Get-Item -LiteralPath $registry).GetValue('') -eq $manifest) {
        Remove-Item -LiteralPath $registry
    }
    foreach ($path in $manifest,$exe,$config) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    }
    if ((Test-Path -LiteralPath $directory) -and !(Get-ChildItem -LiteralPath $directory -Force)) {
        [IO.Directory]::Delete($directory)
    }
    return
}
$bin = Split-Path (Get-Command 'uplatex.exe' -CommandType Application | Select-Object -First 1).Source
if (!(Test-Path -LiteralPath (Join-Path $bin 'dvipdfmx.exe'))) { throw "Install TeX Live with upLaTeX and dvipdfmx, then try again." }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
$null = New-Item -Path $directory -ItemType Directory -Force
& $compiler /nologo /target:exe /codepage:65001 /optimize+ /reference:System.Web.Extensions.dll "/out:$exe" (Join-Path $PSScriptRoot 'TexHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Building the native helper failed.' }
[IO.File]::WriteAllText($config, $bin)
$registration = [ordered]@{
    name = $name
    description = 'Seihon Viewer local TeX Live compiler'
    path = $exe
    type = 'stdio'
    allowed_origins = @('chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/')
}
[IO.File]::WriteAllText($manifest, ($registration | ConvertTo-Json))
$null = New-Item -Path $registry -Force
Set-Item -LiteralPath $registry -Value $manifest
