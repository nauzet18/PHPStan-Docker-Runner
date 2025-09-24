import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let diagnosticCollection: vscode.DiagnosticCollection;
let phpstanOutputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    console.log('PHPStan Docker Runner está activo');

    // Crear colección de diagnósticos
    diagnosticCollection = vscode.languages.createDiagnosticCollection('phpstan');
    context.subscriptions.push(diagnosticCollection);

    // Crear OutputChannel personalizado
    phpstanOutputChannel = vscode.window.createOutputChannel('PHPStan Docker Runner');
    context.subscriptions.push(phpstanOutputChannel);

    // Comando para ejecutar PHPStan en todo el proyecto
    const runPhpstanCommand = vscode.commands.registerCommand('phpstan-docker-runner.runPhpstan', async () => {
        await runPhpstan();
    });

    // Comando para ejecutar PHPStan en el archivo actual
    const runPhpstanFileCommand = vscode.commands.registerCommand('phpstan-docker-runner.runPhpstanFile', async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || !activeEditor.document.fileName.endsWith('.php')) {
            vscode.window.showWarningMessage('Por favor, abre un archivo PHP primero');
            return;
        }
        await runPhpstan(activeEditor.document.fileName);
    });

    // Comando para ejecutar PHPStan en el directorio actual
    const runPhpstanDirectoryCommand = vscode.commands.registerCommand('phpstan-docker-runner.runPhpstanDirectory', async (uri: vscode.Uri) => {
        const targetPath = uri ? uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!targetPath) {
            vscode.window.showWarningMessage('No se pudo determinar el directorio de trabajo');
            return;
        }
        await runPhpstan(targetPath);
    });

    // Auto-ejecutar PHPStan al guardar archivos PHP (si está habilitado)
    const autoRunConfig = vscode.workspace.getConfiguration('phpstan-docker-runner').get<boolean>('autoRun', false);
    if (autoRunConfig) {
        const onSaveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
            if (document.fileName.endsWith('.php')) {
                await runPhpstan(document.fileName);
            }
        });
        context.subscriptions.push(onSaveListener);
    }

    context.subscriptions.push(runPhpstanCommand, runPhpstanFileCommand, runPhpstanDirectoryCommand);
}

async function runPhpstan(targetPath?: string): Promise<void> {
    try {
        const config = vscode.workspace.getConfiguration('phpstan-docker-runner');
        const containerName = config.get<string>('containerName', 'phpstan');
        const workDirectory = config.get<string>('workDirectory', '/var/www/html');
        const configFile = config.get<string>('configFile', 'phpstan.neon');
        const level = config.get<string>('level', '5');
        const phpstanPath = config.get<string>('phpstanPath', 'vendor/bin/phpstan');

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No se encontró un workspace abierto');
            return;
        }

        // Limpiar diagnósticos anteriores
        diagnosticCollection.clear();

        // Mostrar indicador de progreso
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Ejecutando PHPStan en Docker...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "Preparando comando..." });

            // Construir comando PHPStan
            let phpstanCommand = `${phpstanPath} analyse --level=${level}`;
            
            if (configFile && fs.existsSync(path.join(workspaceRoot, configFile))) {
                phpstanCommand += ` --configuration=${configFile}`;
            }

            if (targetPath) {
                // Convertir ruta local a ruta del contenedor
                const relativePath = path.relative(workspaceRoot, targetPath);
                const containerPath = path.join(workDirectory, relativePath).replace(/\\/g, '/');
                phpstanCommand += ` ${containerPath}`;
            } else {
                phpstanCommand += ` ${workDirectory}`;
            }

            // Comando Docker exec
            const dockerCommand = `docker exec ${containerName} ${phpstanCommand}`;

            progress.report({ increment: 30, message: "Lanzando ejecución..." });

            // Ya no se crea una terminal integrada, la salida va solo al OutputChannel

            progress.report({ increment: 50, message: "Analizando y recopilando diagnósticos..." });

            try {
                // Ejecutamos en paralelo otra llamada con salida capturable para diagnósticos
                const { stdout, stderr } = await execAsync(dockerCommand, {
                    cwd: workspaceRoot,
                    timeout: 300000 // 5 minutos timeout
                });

                // Mostrar la salida en el OutputChannel personalizado
                phpstanOutputChannel.clear();
                phpstanOutputChannel.appendLine('Comando ejecutado: ' + dockerCommand);
                phpstanOutputChannel.appendLine('--- STDOUT ---');
                phpstanOutputChannel.append(stdout);
                if (stderr) {
                    phpstanOutputChannel.appendLine('\n--- STDERR ---');
                    phpstanOutputChannel.append(stderr);
                }
                phpstanOutputChannel.show(true);

                progress.report({ increment: 100, message: "Procesando resultados..." });

                // Procesar la salida de PHPStan, pasando targetPath
                await processPhpstanOutput(stdout, stderr, workspaceRoot, workDirectory, targetPath);

            } catch (error: any) {
                // Mostrar la salida en el OutputChannel personalizado también en caso de error
                phpstanOutputChannel.clear();
                phpstanOutputChannel.appendLine('Comando ejecutado: ' + dockerCommand);
                phpstanOutputChannel.appendLine('--- STDOUT ---');
                phpstanOutputChannel.append(error.stdout || '');
                if (error.stderr) {
                    phpstanOutputChannel.appendLine('\n--- STDERR ---');
                    phpstanOutputChannel.append(error.stderr);
                }
                phpstanOutputChannel.show(true);

                if (error.code === 1) {
                    // PHPStan encontró errores (código de salida 1)
                    await processPhpstanOutput(error.stdout || '', error.stderr || '', workspaceRoot, workDirectory, targetPath);
                } else {
                    throw error;
                }
            }
        });

    } catch (error: any) {
        console.error('Error ejecutando PHPStan:', error);
        vscode.window.showErrorMessage(`Error ejecutando PHPStan: ${error.message}`);
    }
}

async function processPhpstanOutput(stdout: string, stderr: string, workspaceRoot: string, workDirectory: string, targetPath?: string): Promise<void> {
    const diagnostics: { [file: string]: vscode.Diagnostic[] } = {};

    // Parsear la salida de PHPStan
    const lines = stdout.split('\n');
    let currentFile = '';
    // Si el análisis se ha lanzado sobre un archivo concreto, usarlo directamente
    let knownFilePath: string | undefined;
    if (targetPath && typeof targetPath === 'string' && targetPath.endsWith('.php') && fs.existsSync(targetPath)) {
        knownFilePath = targetPath;
    }

    for (const line of lines) {
        if (line.trim() === '') continue;

        // Detectar separador de archivo
        if (line.includes('------') && line.includes('------')) {
            continue;
        }

        // Detectar línea de error
        const errorMatch = line.match(/^\s*(\d+)\s+(.+)$/);
        if (errorMatch) {
            const lineNumber = parseInt(errorMatch[1]) - 1; // Convertir a índice 0-based
            const message = errorMatch[2].trim();

            if (currentFile && lineNumber >= 0) {
                if (!diagnostics[currentFile]) {
                    diagnostics[currentFile] = [];
                }

                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(lineNumber, 0, lineNumber, 1000),
                    message,
                    vscode.DiagnosticSeverity.Warning
                );

                diagnostic.source = 'PHPStan';
                diagnostics[currentFile].push(diagnostic);
            }
        } else if (line.includes('.php')) {
            // Es un archivo PHP - convertir ruta del contenedor a ruta local
            const fileMatch = line.match(/([^\s]+\.php)/);
            if (fileMatch) {
                let containerFilePath = fileMatch[1];
                let resolvedPath = '';

                // Si tenemos la ruta conocida (comando sobre archivo actual), usarla directamente
                if (knownFilePath) {
                    resolvedPath = knownFilePath;
                } else if (path.isAbsolute(containerFilePath) && fs.existsSync(containerFilePath)) {
                    resolvedPath = containerFilePath;
                } else {
                    // Si la ruta empieza por el workDirectory, construir la ruta relativa
                    if (containerFilePath.startsWith(workDirectory)) {
                        const relativePath = containerFilePath.substring(workDirectory.length).replace(/^\//, '');
                        resolvedPath = path.resolve(workspaceRoot, relativePath);
                    } else {
                        // Si no, intentar resolver respecto al workspace
                        resolvedPath = path.resolve(workspaceRoot, containerFilePath);
                    }
                    // Si la ruta construida no existe, buscar el archivo en el workspace
                    if (!fs.existsSync(resolvedPath)) {
                        // Buscar el archivo por nombre en el workspace
                        const fileName = path.basename(containerFilePath);
                        const found = findFileInWorkspace(workspaceRoot, fileName, targetPath);
                        if (found) {
                            resolvedPath = found;
                        }
                    }
                }
                currentFile = resolvedPath;
            }
        }
    }

    // Función auxiliar para buscar el archivo por nombre en el workspace o en el targetPath si es directorio
    function findFileInWorkspace(root: string, fileName: string, searchDir?: string): string | undefined {
        let searchRoot = root;
        if (searchDir && fs.existsSync(searchDir) && fs.statSync(searchDir).isDirectory()) {
            searchRoot = searchDir;
        }
        const stack = [searchRoot];
        while (stack.length) {
            const dir = stack.pop();
            if (!dir) continue;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    stack.push(fullPath);
                } else if (file === fileName) {
                    return fullPath;
                }
            }
        }
        return undefined;
    }

    // Aplicar diagnósticos a los archivos
    for (const [filePath, fileDiagnostics] of Object.entries(diagnostics)) {
        const uri = vscode.Uri.file(filePath);
        diagnosticCollection.set(uri, fileDiagnostics);
    }

    // Mostrar resumen
    const totalErrors = Object.values(diagnostics).reduce((sum, diags) => sum + diags.length, 0);
    if (totalErrors > 0) {
        vscode.window.showWarningMessage(`PHPStan encontró ${totalErrors} problemas en ${Object.keys(diagnostics).length} archivos`);
    } else {
        vscode.window.showInformationMessage('PHPStan no encontró problemas');
    }

    // Mostrar errores de Docker si los hay
    if (stderr) {
        console.error('Docker stderr:', stderr);
    }
}

export function deactivate() {
    // Limpiar recursos si es necesario
}
