param(
    [Parameter(Mandatory = $true)]
    [string]$Destino
)
$ErrorActionPreference = "Stop"
$origenHallado = $PSScriptRoot
$destinoHallado = (Resolve-Path -LiteralPath $Destino).Path
if ($origenHallado -eq $destinoHallado) {
    throw "Extrae el ZIP en otra carpeta y ejecuta el script desde esa copia."
}
if (!(Test-Path -LiteralPath (Join-Path $destinoHallado 'package.json')) -or
    !(Test-Path -LiteralPath (Join-Path $destinoHallado 'src\auth.ts'))) {
    throw "El destino no parece ser tu backend. Revisa la ruta."
}
$paqueteHallado = Get-Content -Raw -LiteralPath (Join-Path $destinoHallado 'package.json') | ConvertFrom-Json
if (!$paqueteHallado.dependencies.elysia -or !$paqueteHallado.dependencies.'drizzle-orm') {
    throw "El proyecto no usa Elysia y Drizzle. No se reemplazo ningun archivo."
}
$archivosHallado = @('src', 'tests', 'scripts', 'docs', 'drizzle', 'package.json', 'bun.lock', 'tsconfig.json', 'drizzle.config.ts', 'api-endpoints.json', 'README.md', '.env.example', '.gitignore')
$copiaHallado = Join-Path (Split-Path -Parent $destinoHallado) ((Split-Path -Leaf $destinoHallado) + '-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $copiaHallado | Out-Null
foreach ($nombreHallado in $archivosHallado) {
    $existenteHallado = Join-Path $destinoHallado $nombreHallado
    if (Test-Path -LiteralPath $existenteHallado) {
        Copy-Item -LiteralPath $existenteHallado -Destination $copiaHallado -Recurse -Force
    }
}
foreach ($nombreHallado in @('src', 'tests', 'scripts', 'docs')) {
    $viejoHallado = Join-Path $destinoHallado $nombreHallado
    if (Test-Path -LiteralPath $viejoHallado) { Remove-Item -LiteralPath $viejoHallado -Recurse -Force }
}
foreach ($nombreHallado in $archivosHallado) {
    $nuevoHallado = Join-Path $origenHallado $nombreHallado
    if ($nombreHallado -eq 'drizzle') {
        $migracionesHallado = Join-Path $destinoHallado 'drizzle'
        New-Item -ItemType Directory -Path $migracionesHallado -Force | Out-Null
        foreach ($migracionHallado in Get-ChildItem -LiteralPath $nuevoHallado) {
            $rutaHallado = Join-Path $migracionesHallado $migracionHallado.Name
            if (!(Test-Path -LiteralPath $rutaHallado)) {
                Copy-Item -LiteralPath $migracionHallado.FullName -Destination $rutaHallado -Recurse -Force
            }
        }
    } else {
        Copy-Item -LiteralPath $nuevoHallado -Destination $destinoHallado -Recurse -Force
    }
}
Write-Host "Backend actualizado. Copia de los archivos anteriores: $copiaHallado"
Write-Host 'Se conservaron Git, .env, data, uploads y node_modules.'
Write-Host 'Dentro del repositorio ejecuta: bun install --frozen-lockfile; bun run typecheck; bun test; bun run db:seed; bun run dev'
