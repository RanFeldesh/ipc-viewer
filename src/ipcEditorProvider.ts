import * as vscode from 'vscode';
import * as path from 'path';
import { analyzeIpcFile, formatFileSize, IpcFileInfo } from './ipcAnalyzer';

/**
 * Custom editor provider for IPC files.
 * Displays schema and preview data in a webview.
 */
export class IpcEditorProvider implements vscode.CustomReadonlyEditorProvider {

    public static readonly viewType = 'ipcViewer.ipcFile';

    constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * Called when a custom document is opened.
     */
    async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    /**
     * Called to resolve a custom editor for the given document.
     */
    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        webviewPanel.webview.options = { enableScripts: false };

        // Show loading state
        webviewPanel.webview.html = this.getLoadingHtml();

        // Get configuration
        const config = vscode.workspace.getConfiguration('ipcViewer');
        const previewRows = config.get<number>('previewRows') || 5;
        const statsThresholdMB = config.get<number>('statsThresholdMB') || 100;
        const statsThresholdBytes = statsThresholdMB * 1024 * 1024;

        // Analyze the IPC file
        const filePath = document.uri.fsPath;
        const stats = analyzeIpcFile(filePath, previewRows, statsThresholdBytes);

        // Render the result
        webviewPanel.webview.html = this.getWebviewHtml(stats, filePath);
    }

    /**
     * Generate HTML for loading state.
     */
    private getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
<style>
body {
    font-family: var(--vscode-font-family);
    padding: 20px;
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
}
</style>
</head>
<body>
<p>Loading IPC file...</p>
</body>
</html>`;
    }

    /**
     * Generate HTML for the webview displaying file info.
     */
    private getWebviewHtml(stats: IpcFileInfo, filePath: string): string {
        const fileName = path.basename(filePath);

        // Handle errors
        if (stats.error) {
            return this.getErrorHtml(stats.error, fileName);
        }

        // Build warning section if needed
        const warningHtml = stats.warning
            ? `<div class="warning">${this.escapeHtml(stats.warning)}</div>`
            : '';

        // Build schema metadata section (file-level metadata)
        const schemaMetadataHtml = `<h2>File Metadata</h2>
<div class="metadata-box">${stats.schemaMetadata
            ? `<code>${this.escapeHtml(stats.schemaMetadata)}</code>`
            : '<em class="null">None</em>'}</div>`;

        // Build schema table rows
        const schemaRows = stats.schema.map(col => `
            <tr>
                <td>${this.escapeHtml(col.columnName)}</td>
                <td><code>${this.escapeHtml(col.dataType)}</code></td>
                <td>${col.nullable ? 'Yes' : 'No'}</td>
                <td>${col.metadata ? `<code>${this.escapeHtml(col.metadata)}</code>` : '-'}</td>
            </tr>
        `).join('');

        // Build statistics table rows
        const statsRows = stats.stats.map(col => `
            <tr>
                <td>${this.escapeHtml(col.columnName)}</td>
                <td>${col.nullCount.toLocaleString()}</td>
                <td>${col.distinctCount !== undefined ? col.distinctCount.toLocaleString() : '-'}</td>
                <td>${col.minValue !== undefined ? this.escapeHtml(col.minValue) : '-'}</td>
                <td>${col.maxValue !== undefined ? this.escapeHtml(col.maxValue) : '-'}</td>
            </tr>
        `).join('');

        // Build preview table
        const columns = Object.keys(stats.preview);
        const numRows = columns.length > 0 ? stats.preview[columns[0]].length : 0;

        const previewHeaders = columns.map(c => `<th>${this.escapeHtml(c)}</th>`).join('');
        const previewRows: string[] = [];
        for (let i = 0; i < numRows; i++) {
            const cells = columns.map(c => {
                const val = stats.preview[c][i];
                return `<td>${val !== null ? this.escapeHtml(val) : '<em class="null">null</em>'}</td>`;
            }).join('');
            previewRows.push(`<tr>${cells}</tr>`);
        }

        const previewSection = numRows > 0 ? `
<h2>Preview (First ${stats.previewRowCount} Records)</h2>
<div class="table-container">
<table>
    <thead><tr>${previewHeaders}</tr></thead>
    <tbody>${previewRows.join('')}</tbody>
</table>
</div>` : '';

        const schemaSection = stats.schema.length > 0 ? `
<h2>Schema</h2>
<table>
    <thead>
        <tr>
            <th>Column Name</th>
            <th>Data Type</th>
            <th>Nullable</th>
            <th>Metadata</th>
        </tr>
    </thead>
    <tbody>${schemaRows}</tbody>
</table>` : '';

        const statsSection = stats.stats.length > 0 ? `
<h2>Statistics</h2>
<table>
    <thead>
        <tr>
            <th>Column Name</th>
            <th>Null Count</th>
            <th>Distinct</th>
            <th>Min</th>
            <th>Max</th>
        </tr>
    </thead>
    <tbody>${statsRows}</tbody>
</table>` : '';

        return `<!DOCTYPE html>
<html>
<head>
<style>
body {
    font-family: var(--vscode-font-family);
    padding: 20px;
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    line-height: 1.5;
}
h1 {
    font-size: 1.5em;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    padding-bottom: 8px;
}
h2 {
    font-size: 1.2em;
    margin-top: 24px;
    margin-bottom: 12px;
}
table {
    border-collapse: collapse;
    width: 100%;
    margin: 10px 0;
}
th, td {
    border: 1px solid var(--vscode-panel-border);
    padding: 8px 12px;
    text-align: left;
}
th {
    background-color: var(--vscode-editor-lineHighlightBackground);
    font-weight: 600;
}
tr:hover {
    background-color: var(--vscode-list-hoverBackground);
}
.info-grid {
    display: grid;
    grid-template-columns: auto auto;
    gap: 4px 20px;
    max-width: 400px;
    margin: 16px 0;
}
.info-label {
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
}
code {
    background-color: var(--vscode-textCodeBlock-background);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.9em;
}
.warning {
    background-color: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    padding: 12px;
    border-radius: 4px;
    margin: 16px 0;
}
.null {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
}
.table-container {
    overflow-x: auto;
}
.metadata-box {
    background-color: var(--vscode-textCodeBlock-background);
    padding: 12px;
    border-radius: 4px;
    margin: 10px 0;
    overflow-x: auto;
}
</style>
</head>
<body>
<h1>IPC File: ${this.escapeHtml(fileName)}</h1>

${warningHtml}

<h2>File Information</h2>
<div class="info-grid">
    <span class="info-label">File Size:</span>
    <span>${formatFileSize(stats.fileSizeBytes)}</span>
    <span class="info-label">Columns:</span>
    <span>${stats.numColumns}</span>
    <span class="info-label">Rows:</span>
    <span>${stats.numRows.toLocaleString()}</span>
</div>

${schemaMetadataHtml}

${schemaSection}

${statsSection}

${previewSection}

</body>
</html>`;
    }

    /**
     * Generate HTML for error state.
     */
    private getErrorHtml(error: string, fileName: string): string {
        return `<!DOCTYPE html>
<html>
<head>
<style>
body {
    font-family: var(--vscode-font-family);
    padding: 20px;
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
}
h1 {
    font-size: 1.5em;
    margin-bottom: 16px;
}
.error {
    background-color: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    padding: 12px;
    border-radius: 4px;
    margin: 16px 0;
}
</style>
</head>
<body>
<h1>IPC File: ${this.escapeHtml(fileName)}</h1>
<div class="error">
    <strong>Error:</strong> ${this.escapeHtml(error)}
</div>
</body>
</html>`;
    }

    /**
     * Escape HTML special characters to prevent XSS.
     */
    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
