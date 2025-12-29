import * as vscode from 'vscode';
import { analyzePython, configureAnalyzer, Finding, FindingSeverity } from './analyzer';

type ApiKeyProvider = () => PromiseLike<string | undefined>;

let collection: vscode.DiagnosticCollection | undefined;
let initialized = false;

export function initDiagnostics(
	context: vscode.ExtensionContext,
	options: { getApiKey?: ApiKeyProvider; enableLLM?: boolean } = {},
): void {
	if (initialized) {
		return;
	}

	collection = vscode.languages.createDiagnosticCollection('codespeed');
	context.subscriptions.push(collection);
	configureAnalyzer({ getApiKey: options.getApiKey, enableLLM: options.enableLLM });
	initialized = true;
}

export async function analyzeAndPublish(uri: vscode.Uri, text: string, reason: string): Promise<void> {
	if (!collection) {
		return;
	}

	const findings = await analyzePython(uri.toString(true), text);
	const diagnostics = findings.map((finding) => {
		const diagnostic = new vscode.Diagnostic(
			toRange(finding),
			annotateMessage(finding, reason),
			mapSeverity(finding.severity),
		);
		diagnostic.source = 'codespeed';
		diagnostic.code = finding.ruleId;
		return diagnostic;
	});

	collection.set(uri, diagnostics);
}

export function clearDiagnostics(uri: vscode.Uri): void {
	if (!collection) {
		return;
	}

	collection.set(uri, []);
}

function mapSeverity(severity: FindingSeverity): vscode.DiagnosticSeverity {
	switch (severity) {
		case FindingSeverity.Error:
			return vscode.DiagnosticSeverity.Error;
		case FindingSeverity.Warning:
			return vscode.DiagnosticSeverity.Warning;
		case FindingSeverity.Info:
			return vscode.DiagnosticSeverity.Information;
		case FindingSeverity.Hint:
		default:
			return vscode.DiagnosticSeverity.Hint;
	}
}

function toRange(finding: Finding): vscode.Range {
	return new vscode.Range(
		new vscode.Position(finding.range.startLine, finding.range.startChar),
		new vscode.Position(finding.range.endLine, finding.range.endChar),
	);
}

function annotateMessage(finding: Finding, reason: string): string {
	const suffix = finding.needsContext ? ' (review context)' : '';
	return `[${finding.ruleId}] ${finding.message}${suffix} [${reason}]`;
}
