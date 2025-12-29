// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { analyzeAndPublish, initDiagnostics } from './diagnostics';

const PYTHON_LANGUAGE_ID = 'python';
const DEBUG_LOGGING = true;
const INITIAL_SCAN_SUPPRESSION_TIMEOUT_MS = 5000;
const TEST_GET_HANDLED_URIS_COMMAND = 'codespeed.__test_getHandledPythonUris';
const TEST_RESET_HANDLED_URIS_COMMAND = 'codespeed.__test_resetHandledPythonUris';
const SET_OPENAI_KEY_COMMAND = 'codespeed.setOpenAIKey';
const CLEAR_OPENAI_KEY_COMMAND = 'codespeed.clearOpenAIKey';

const handledPythonUris: string[] = [];
const initialScanSuppression = new Set<string>();

export function getHandledPythonUris(): string[] {
	return [...handledPythonUris];
}

export function resetHandledPythonUris(): void {
	handledPythonUris.length = 0;
	initialScanSuppression.clear();
}

function logDebug(message: string): void {
	if (!DEBUG_LOGGING) {
		return;
	}

	console.log(`[codespeed][debug] ${message}`);
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	logDebug('activate() called');

	initDiagnostics(context, {
		getApiKey: () => context.secrets.get('codespeed.openaiKey'),
		enableLLM: process.env.CODESPEED_ENABLE_LLM === 'true',
	});

	const helloWorldCommand = vscode.commands.registerCommand('codespeed.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from codespeed!');
	});

	const setOpenAiKeyCommand = vscode.commands.registerCommand(SET_OPENAI_KEY_COMMAND, async () => {
		const key = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			password: true,
			title: 'Enter OpenAI API key',
			prompt: 'Key will be stored securely for codespeed diagnostics.',
		});

		if (!key) {
			return;
		}

		await context.secrets.store('codespeed.openaiKey', key);
		vscode.window.showInformationMessage('codespeed OpenAI key saved.');
	});

	const clearOpenAiKeyCommand = vscode.commands.registerCommand(CLEAR_OPENAI_KEY_COMMAND, async () => {
		await context.secrets.delete('codespeed.openaiKey');
		vscode.window.showInformationMessage('codespeed OpenAI key cleared.');
	});

	const handleDocumentEvent = async (document: vscode.TextDocument, reason: string) => {
		if (document.languageId !== PYTHON_LANGUAGE_ID) {
			return;
		}

		if (reason === 'onDidOpenTextDocument') {
			const key = document.uri.toString(true);
			if (initialScanSuppression.delete(key)) {
				logDebug(`[${reason}] Skipping ${key} because it was already processed during activation`);
				return;
			}
		}

		logDebug(`[${reason}] Received Python document ${document.uri.toString(true)}`);
		await handlePythonDocument(document, reason);
	};

	context.subscriptions.push(
		helloWorldCommand,
		setOpenAiKeyCommand,
		clearOpenAiKeyCommand,
		vscode.workspace.onDidOpenTextDocument((document) => handleDocumentEvent(document, 'onDidOpenTextDocument')),
		vscode.workspace.onDidChangeTextDocument((event) => handleDocumentEvent(event.document, 'onDidChangeTextDocument')),
		vscode.workspace.onDidSaveTextDocument((document) => handleDocumentEvent(document, 'onDidSaveTextDocument')),
		vscode.commands.registerCommand(TEST_GET_HANDLED_URIS_COMMAND, () => getHandledPythonUris()),
		vscode.commands.registerCommand(TEST_RESET_HANDLED_URIS_COMMAND, () => resetHandledPythonUris()),
	);

	// Ensure already-open Python files are processed right after activation.
	for (const document of vscode.workspace.textDocuments) {
		if (document.languageId !== PYTHON_LANGUAGE_ID) {
			continue;
		}

		const uriString = document.uri.toString(true);
		initialScanSuppression.add(uriString);
		setTimeout(() => initialScanSuppression.delete(uriString), INITIAL_SCAN_SUPPRESSION_TIMEOUT_MS).unref?.();
		void handleDocumentEvent(document, 'initial-scan');
	}
}

// This method is called when your extension is deactivated
export function deactivate() {
	logDebug('deactivate() called');
}

async function handlePythonDocument(document: vscode.TextDocument, reason: string) {
	const uriString = document.uri.toString(true);
	logDebug(`[handlePythonDocument] Handling ${uriString} due to ${reason}`);
	handledPythonUris.push(uriString);
	logDebug(`[handlePythonDocument] Total handled count: ${handledPythonUris.length}`);
	try {
		await analyzeAndPublish(document.uri, document.getText(), reason);
	} catch (error) {
		logDebug(`Failed to analyze ${uriString}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
