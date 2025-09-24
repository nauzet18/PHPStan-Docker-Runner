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

    // Create diagnostics collection
    diagnosticCollection = vscode.languages.createDiagnosticCollection('phpstan');
    context.subscriptions.push(diagnosticCollection);

    // Create custom OutputChannel
    phpstanOutputChannel = vscode.window.createOutputChannel('PHPStan Docker Runner');
    context.subscriptions.push(phpstanOutputChannel);

    // Command to run PHPStan on the whole project
    const runPhpstanCommand = vscode.commands.registerCommand('phpstan-docker-runner.runPhpstan', async () => {
        await runPhpstan();
    });

    // Command to run PHPStan on the current file
    const runPhpstanFileCommand = vscode.commands.registerCommand('phpstan-docker-runner.runPhpstanFile', async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || !activeEditor.document.fileName.endsWith('.php')) {
            vscode.window.showWarningMessage('Por favor, abre un archivo PHP primero');
            return;
        }
        await runPhpstan(activeEditor.document.fileName);
    });

    // Command to run PHPStan on the current directory
    const runPhpstanDirectoryCommand = vscode.commands.registerCommand('phpstan-docker-runner.runPhpstanDirectory', async (uri: vscode.Uri) => {
        const targetPath = uri ? uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!targetPath) {
            vscode.window.showWarningMessage('No se pudo determinar el directorio de trabajo');
            return;
        }
        await runPhpstan(targetPath);
    });

    // Auto-run PHPStan when saving PHP files (if enabled)
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

        // Clear previous diagnostics
        diagnosticCollection.clear();

        // Show progress indicator
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Ejecutando PHPStan en Docker...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "Preparando comando..." });

            // Build PHPStan command
            let phpstanCommand = `${phpstanPath} analyse --no-progress --level=${level}`;
            
            if (configFile && fs.existsSync(path.join(workspaceRoot, configFile))) {
                phpstanCommand += ` --configuration=${configFile}`;
            }

            if (targetPath) {
                // Convert local path to container path
                const relativePath = path.relative(workspaceRoot, targetPath);
                const containerPath = path.join(workDirectory, relativePath).replace(/\\/g, '/');
                phpstanCommand += ` ${containerPath}`;
            } else {
                phpstanCommand += ` ${workDirectory}`;
            }

            // Docker exec command
            const dockerCommand = `docker exec ${containerName} ${phpstanCommand}`;

            progress.report({ increment: 30, message: "Lanzando ejecución..." });

            // No integrated terminal is created, output goes only to OutputChannel

            progress.report({ increment: 50, message: "Analizando y recopilando diagnósticos..." });

            try {
                // Run another call in parallel with capturable output for diagnostics
                const { stdout, stderr } = await execAsync(dockerCommand, {
                    cwd: workspaceRoot,
                    timeout: 600000 // 10 min timeout
                });

                // Show output in custom OutputChannel
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

                // Process PHPStan output, passing targetPath
                await processPhpstanOutput(stdout, stderr, workspaceRoot, workDirectory, targetPath);

            } catch (error: any) {
                // Show output in custom OutputChannel also in case of error
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
                    // PHPStan found errors (exit code 1)
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

    // Parse PHPStan output
    const lines = stdout.split('\n');
    let currentFile = '';
    // If the analysis was run on a specific file, use it directly
    let knownFilePath: string | undefined;
    if (targetPath && typeof targetPath === 'string' && targetPath.endsWith('.php') && fs.existsSync(targetPath)) {
        knownFilePath = targetPath;
    }

    for (const line of lines) {
        if (line.trim() === '') continue;

        // Detect file separator
        if (line.includes('------') && line.includes('------')) {
            continue;
        }

        // Detect error line
        const errorMatch = line.match(/^\s*(\d+)\s+(.+)$/);
        if (errorMatch) {
            const lineNumber = parseInt(errorMatch[1]) - 1; // Convert to 0-based index
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
            // It's a PHP file - convert container path to local path
            const fileMatch = line.match(/([^\s]+\.php)/);
            if (fileMatch) {
                let containerFilePath = fileMatch[1];
                let resolvedPath = '';

                // If we have the known path (command on current file), use it directly
                if (knownFilePath) {
                    resolvedPath = knownFilePath;
                } else if (path.isAbsolute(containerFilePath) && fs.existsSync(containerFilePath)) {
                    resolvedPath = containerFilePath;
                } else {
                    // If the path starts with workDirectory, build the relative path
                    if (containerFilePath.startsWith(workDirectory)) {
                        const relativePath = containerFilePath.substring(workDirectory.length).replace(/^\//, '');
                        resolvedPath = path.resolve(workspaceRoot, relativePath);
                    } else {
                        // Otherwise, try to resolve relative to workspace
                        resolvedPath = path.resolve(workspaceRoot, containerFilePath);
                    }
                    // If the built path does not exist, search for the file in the workspace
                    if (!fs.existsSync(resolvedPath)) {
                        // Search for the file by name in the workspace
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

    // Helper function to search for the file by name in the workspace or in targetPath if it's a directory
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

    // Apply diagnostics to files
    for (const [filePath, fileDiagnostics] of Object.entries(diagnostics)) {
        const uri = vscode.Uri.file(filePath);
        diagnosticCollection.set(uri, fileDiagnostics);
    }

    // Show summary
    const totalErrors = Object.values(diagnostics).reduce((sum, diags) => sum + diags.length, 0);
    if (totalErrors > 0) {
        vscode.window.showWarningMessage(`PHPStan encontró ${totalErrors} problemas en ${Object.keys(diagnostics).length} archivos`);
    } else {
        vscode.window.showInformationMessage('PHPStan no encontró problemas');
    }

    // Show Docker errors if any
    if (stderr) {
        console.error('Docker stderr:', stderr);
    }
}

export function deactivate() {
    // Clean up resources if needed
}
