# In-game mod-button icon: captures/icon_transparent.png -> importcity/mod/content/gui/icons/realmap.tga
# (40 x 40) and realmap@2x.tga (80 x 80, picked on high-DPI screens), like HQminiMap's: uncompressed
# 32-bit TGA (type 2, 8 alpha bits, rows bottom-up), resized in high quality.
#   powershell -File tools/make_icons.ps1
param(
  [string]$Source = "$PSScriptRoot\..\captures\icon_transparent.png",
  [string]$OutDir = "$PSScriptRoot\..\importcity\mod\content\gui\icons"
)
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
try {
  foreach ($size in 40, 80) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    $data = New-Object byte[] (18 + $size * $size * 4)
    $data[2] = 2                                  # uncompressed true colour
    $data[12] = $size -band 0xff; $data[13] = $size -shr 8
    $data[14] = $size -band 0xff; $data[15] = $size -shr 8
    $data[16] = 32                                # bits per pixel
    $data[17] = 8                                 # 8 alpha bits, origin bottom-left
    $i = 18
    for ($y = $size - 1; $y -ge 0; $y--) {
      for ($x = 0; $x -lt $size; $x++) {
        $c = $bmp.GetPixel($x, $y)
        $data[$i] = $c.B; $data[$i + 1] = $c.G; $data[$i + 2] = $c.R; $data[$i + 3] = $c.A
        $i += 4
      }
    }
    $bmp.Dispose()
    $name = if ($size -eq 40) { "realmap.tga" } else { "realmap@2x.tga" }
    [System.IO.File]::WriteAllBytes((Join-Path $OutDir $name), $data)
    Write-Output "$name $size x $size"
  }
} finally {
  $src.Dispose()
}
