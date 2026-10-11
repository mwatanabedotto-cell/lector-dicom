param([int]$Port = 8731, [string]$Root = "D:\lector tomo")

$types = @{
  ".html" = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".png"  = "image/png"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Output "serving $Root on http://127.0.0.1:$Port/"

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 5000
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)

    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { $client.Close(); continue }
    while ($true) { $h = $reader.ReadLine(); if ($null -eq $h -or $h -eq "") { break } }

    $parts = $requestLine.Split(" ")
    $rawPath = $parts[1]
    if ($rawPath.Contains("?")) { $rawPath = $rawPath.Split("?")[0] }
    $path = [System.Uri]::UnescapeDataString($rawPath)
    if ($path -eq "/") { $path = "/index.html" }

    $relative = $path.TrimStart("/").Replace("/", "\")
    $full = Join-Path $Root $relative
    $fullResolved = [System.IO.Path]::GetFullPath($full)
    $rootResolved = [System.IO.Path]::GetFullPath($Root)

    $status = "200 OK"
    $body = $null
    $contentType = "application/octet-stream"

    if (-not $fullResolved.StartsWith($rootResolved)) {
      $status = "403 Forbidden"
      $body = [System.Text.Encoding]::UTF8.GetBytes("forbidden")
      $contentType = "text/plain"
    } elseif (Test-Path -LiteralPath $fullResolved -PathType Leaf) {
      $body = [System.IO.File]::ReadAllBytes($fullResolved)
      $ext = [System.IO.Path]::GetExtension($fullResolved).ToLower()
      if ($types.ContainsKey($ext)) { $contentType = $types[$ext] }
    } else {
      $status = "404 Not Found"
      $body = [System.Text.Encoding]::UTF8.GetBytes("not found: $path")
      $contentType = "text/plain; charset=utf-8"
    }

    $header = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    $stream.Write($body, 0, $body.Length)
    $stream.Flush()
    Write-Output "$status $path"
  } catch {
    Write-Output "error: $($_.Exception.Message)"
  } finally {
    $client.Close()
  }
}
