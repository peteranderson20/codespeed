import * as vscode from 'vscode';

export interface Finding {
	message: string;
	severity: vscode.DiagnosticSeverity;
	range: vscode.Range;
}

const collection = vscode.languages.createDiagnosticCollection('codespeed');

export function publishDiagnostics(uri: vscode.Uri, findings: Finding[]): void {
	const diagnostics = findings.map((finding) => {
		const diagnostic = new vscode.Diagnostic(
			finding.range,
			finding.message,
			finding.severity,
		);
		diagnostic.source = 'codespeed';
		return diagnostic;
	});

	collection.set(uri, diagnostics);
}

export function clearDiagnostics(uri: vscode.Uri): void {
	collection.delete(uri);
}

export function disposeDiagnostics(): void {
	collection.dispose();
}
