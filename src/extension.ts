import * as vscode from 'vscode';
import { IpcEditorProvider } from './ipcEditorProvider';

/**
 * Called when the extension is activated.
 */
export function activate(context: vscode.ExtensionContext): void {
    const provider = new IpcEditorProvider(context);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            IpcEditorProvider.viewType,
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true }
            }
        )
    );
}

/**
 * Called when the extension is deactivated.
 */
export function deactivate(): void {
    // Nothing to clean up
}
