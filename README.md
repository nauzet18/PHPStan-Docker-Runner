# PHPStan Docker Runner

Una extensión para Cursor/VS Code que permite ejecutar PHPStan en un contenedor Docker existente. La salida de PHPStan se muestra en un OutputChannel personalizado y los problemas detectados aparecen en la sección de Problemas del editor, siendo totalmente clicables.

## Características

- 🐳 Ejecuta PHPStan en un contenedor Docker existente
- 📁 Análisis de archivos individuales, directorios o todo el proyecto
- ⚙️ Configuración personalizable del contenedor y mapping de carpetas
- 🔍 Integración con el editor para mostrar problemas clicables
- 🚀 Comandos rápidos desde el menú contextual
- 🔄 Auto-ejecución al guardar archivos PHP (opcional)
- 📤 Salida de PHPStan en un OutputChannel personalizado
## Salida y visualización

La salida de PHPStan se muestra en un OutputChannel propio dentro de VS Code, permitiendo revisar el resultado completo del análisis. Además, los problemas detectados por PHPStan se listan en la sección de "Problemas" del editor y puedes hacer clic en ellos para ir directamente al archivo y línea correspondiente.

## Optimización de búsqueda

Cuando ejecutas el análisis sobre un directorio, la extensión optimiza la búsqueda de archivos para mostrar los problemas solo en ese ámbito, mejorando el rendimiento y la precisión.


## Instalación

1. Clona este repositorio en tu directorio de extensiones de Cursor/VS Code
2. Instala las dependencias:
   ```bash
   npm install
   ```
3. Compila la extensión:
   ```bash
   npm run compile
   ```
4. Presiona `F5` para abrir una nueva ventana de Cursor/VS Code con la extensión cargada

## Configuración

La extensión se puede configurar a través de la configuración de Cursor/VS Code:

- `phpstan-docker-runner.containerName`: Nombre del contenedor Docker donde está PHPStan (por defecto: "phpstan")
- `phpstan-docker-runner.workDirectory`: Directorio de trabajo dentro del contenedor (por defecto: "/var/www/html")
- `phpstan-docker-runner.configFile`: Archivo de configuración de PHPStan (por defecto: "phpstan.neon")
- `phpstan-docker-runner.level`: Nivel de análisis de PHPStan 0-9 (por defecto: "5")
- `phpstan-docker-runner.autoRun`: Ejecutar PHPStan automáticamente al guardar archivos PHP (por defecto: false)
- `phpstan-docker-runner.phpstanPath`: Ruta del ejecutable de PHPStan dentro del contenedor (por defecto: "vendor/bin/phpstan")

## Uso

### Comandos disponibles

1. **Ejecutar PHPStan en todo el proyecto** - Analiza todo el proyecto
2. **Ejecutar PHPStan en archivo actual** - Analiza solo el archivo PHP abierto
3. **Ejecutar PHPStan en directorio actual** - Analiza el directorio seleccionado (menú contextual)

### Acceso a los comandos

- **Paleta de comandos**: `Ctrl+Shift+P` y busca "PHPStan"
- **Menú contextual**: Click derecho en archivos/directorios PHP
- **Atajos de teclado**: Puedes configurar atajos personalizados

## Configuración de Docker

La extensión funciona con cualquier contenedor Docker que tenga PHPStan instalado. No necesitas un docker-compose.yml específico, solo asegúrate de que:

1. **El contenedor esté corriendo** y tenga PHPStan instalado
2. **El mapping de carpetas esté configurado** correctamente
3. **El directorio de trabajo** dentro del contenedor esté configurado

### Ejemplo de configuración

Si tu proyecto está mapeado así:
- **Host**: `/home/usuario/mi-proyecto` → **Contenedor**: `/var/www/html`
- **Nombre del contenedor**: `mi-app-php`

Configura la extensión así:
```json
{
    "phpstan-docker-runner.containerName": "mi-app-php",
    "phpstan-docker-runner.workDirectory": "/var/www/html",
    "phpstan-docker-runner.phpstanPath": "vendor/bin/phpstan"
}
```

## Configuración de PHPStan

Incluye un archivo `phpstan.neon` de ejemplo:

```neon
parameters:
    level: 5
    paths:
        - src
        - app
        - lib
    excludePaths:
        - vendor
        - node_modules
        - tests
        - var
        - cache
    ignoreErrors:
        - '#Call to an undefined method.*#'
    checkMissingIterableValueType: false
    checkGenericClassInNonGenericObjectType: false
    reportUnmatchedIgnoredErrors: false
```

## Requisitos

- Docker y Docker Compose instalados
- Cursor o VS Code
- Node.js y npm (para desarrollo)

## Desarrollo

1. Clona el repositorio
2. Instala dependencias: `npm install`
3. Compila: `npm run compile`
4. Abre en Cursor/VS Code y presiona `F5`

## Estructura del proyecto

```
phpstan-docker-runner/
├── src/
│   └── extension.ts          # Código principal de la extensión
├── package.json              # Manifest de la extensión
├── tsconfig.json            # Configuración de TypeScript
├── phpstan.neon            # Configuración de PHPStan (opcional)
├── install.sh              # Script de instalación
└── README.md               # Este archivo
```

## Cómo funciona

1. **Configuración**: La extensión lee la configuración del contenedor y directorio de trabajo
2. **Mapeo de rutas**: Convierte las rutas locales a rutas del contenedor
3. **Ejecución**: Ejecuta `docker exec [contenedor] [ruta-phpstan] analyse [ruta]`
4. **Procesamiento**: Convierte las rutas de salida del contenedor a rutas locales
5. **Visualización**: Muestra los problemas como diagnósticos en el editor

## Contribuir

1. Fork el proyecto
2. Crea una rama para tu feature (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

## Licencia

Este proyecto está bajo la Licencia MIT. Ver el archivo `LICENSE` para más detalles.
