import * as vscode from 'vscode';
import { clearDiagnostics, disposeDiagnostics, Finding, publishDiagnostics } from './diagnostics';

const PYTHON_LANGUAGE_ID = 'python';

export function activate(context: vscode.ExtensionContext) {
	const handleDocument = (document: vscode.TextDocument) => {
		if (!isPythonDocument(document)) {
			return;
		}

		const findings = analyzeDocument(document);
		if (findings.length === 0) {
			clearDiagnostics(document.uri);
			return;
		}

		publishDiagnostics(document.uri, findings);
	};

	const handleChange = (event: vscode.TextDocumentChangeEvent) => {
		handleDocument(event.document);
	};

	const handleClose = (document: vscode.TextDocument) => {
		if (isPythonDocument(document)) {
			clearDiagnostics(document.uri);
		}
	};

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(handleDocument),
		vscode.workspace.onDidChangeTextDocument(handleChange),
		vscode.workspace.onDidSaveTextDocument(handleDocument),
		vscode.workspace.onDidCloseTextDocument(handleClose),
	);

	vscode.workspace.textDocuments.forEach(handleDocument);
}

export function deactivate() {
	disposeDiagnostics();
}

function analyzeDocument(document: vscode.TextDocument): Finding[] {
	const findings: Finding[] = [];
	const text = document.getText();
	const todoRegExp = /TODO/g;
	let match: RegExpExecArray | null;

	while ((match = todoRegExp.exec(text)) !== null) {
		const start = document.positionAt(match.index);
		const end = document.positionAt(match.index + match[0].length);

		findings.push({
			message: 'TODO found. Replace with actionable code or remove placeholder.',
			severity: vscode.DiagnosticSeverity.Warning,
			range: new vscode.Range(start, end),
		});
	}

	return findings;
}

function isPythonDocument(document: vscode.TextDocument): boolean {
	return document.languageId === PYTHON_LANGUAGE_ID;
}
