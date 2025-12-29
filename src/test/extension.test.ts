import * as assert from 'assert';
import * as vscode from 'vscode';

const wait = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
const TEST_GET_COMMAND = 'codespeed.__test_getHandledPythonUris';
const TEST_RESET_COMMAND = 'codespeed.__test_resetHandledPythonUris';
const SET_KEY_COMMAND = 'codespeed.setOpenAIKey';

suite('Python document monitoring', () => {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		throw new Error('Workspace folder not found for integration tests.');
	}

	const tempDir = vscode.Uri.joinPath(workspaceFolder.uri, '.codespeed-test-workspace');

	suiteSetup(async () => {
		await vscode.workspace.fs.createDirectory(tempDir);
		await activateExtension(tempDir);
		await resetHandledUris();
	});

	suiteTeardown(async () => {
		try {
			await vscode.workspace.fs.delete(tempDir, { recursive: true, useTrash: false });
		} catch {
			// best effort cleanup
		}
	});

	setup(async () => {
		await resetHandledUris();
		await vscode.workspace.fs.createDirectory(tempDir);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	async function activateExtension(folder: vscode.Uri): Promise<void> {
		const activationFile = vscode.Uri.joinPath(folder, `${Date.now()}-activate.py`);
		await vscode.workspace.fs.writeFile(activationFile, Buffer.from('print("activate")\n', 'utf8'));
		const document = await vscode.workspace.openTextDocument(activationFile);
		await vscode.window.showTextDocument(document, { preview: false });
		await wait();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.workspace.fs.delete(activationFile, { useTrash: false });
		await wait();
	}

	async function resetHandledUris(): Promise<void> {
		await vscode.commands.executeCommand(TEST_RESET_COMMAND);
		await wait();
	}

	async function handledUris(): Promise<string[]> {
		const uris = await vscode.commands.executeCommand<string[]>(TEST_GET_COMMAND);
		return uris ?? [];
	}

	async function createWorkspaceFile(filename: string, contents: string): Promise<vscode.Uri> {
		const target = vscode.Uri.joinPath(tempDir, `${Date.now()}-${filename}`);
		await vscode.workspace.fs.writeFile(target, Buffer.from(contents, 'utf8'));
		return target;
	}

	async function openDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: false });
		await wait();
		return document;
	}

	async function codespeedDiagnostics(uri: vscode.Uri): Promise<vscode.Diagnostic[]> {
		await wait(200);
		return vscode.languages.getDiagnostics(uri).filter((diag) => diag.source === 'codespeed');
	}

	test('Non-Python files do not register as handled', async () => {
		const txtUri = await createWorkspaceFile('notes.txt', 'hello');
		await openDocument(txtUri);
		await wait();

		assert.strictEqual((await handledUris()).length, 0, 'Non-Python files should be ignored');
	});

	test('Opening a Python file records its URI once', async () => {
		const pythonUri = await createWorkspaceFile('script.py', 'print("hello")\n');
		const document = await openDocument(pythonUri);
		await wait();

		const uris = await handledUris();
		assert.strictEqual(uris.length, 1, 'Python open should be handled exactly once');
		assert.strictEqual(uris[0], document.uri.toString(true));
	});

	test('Editing and saving a Python file records additional events', async () => {
		const pythonUri = await createWorkspaceFile('editable.py', 'print("hi")\n');
		const document = await openDocument(pythonUri);
		await wait();

		const initialCount = (await handledUris()).length;
		assert.strictEqual(initialCount, 1, 'Initial open should be counted once');

		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, new vscode.Position(document.lineCount, 0), 'print("edit")\n');
		await vscode.workspace.applyEdit(edit);
		await wait();

		const afterEditCount = (await handledUris()).length;
		assert.ok(afterEditCount > initialCount, `Edit should trigger change handling (got ${afterEditCount}, expected greater than ${initialCount})`);

		await document.save();
		await wait();

		const afterSaveCount = (await handledUris()).length;
		assert.ok(afterSaveCount > afterEditCount, `Save should trigger additional handling (got ${afterSaveCount}, expected greater than ${afterEditCount})`);
	});

	test('Non-Python documents remain ignored even after activation', async () => {
		const pythonUri = await createWorkspaceFile('baseline.py', 'print("ready")\n');
		await openDocument(pythonUri);
		await wait();

		assert.strictEqual((await handledUris()).length, 1, 'Activation baseline should be recorded once');

		const txtUri = await createWorkspaceFile('story.txt', 'lorem ipsum');
		const txtDocument = await openDocument(txtUri);
		await wait();

		assert.strictEqual((await handledUris()).length, 1, 'Opening non-Python file should not change count');

		const edit = new vscode.WorkspaceEdit();
		edit.insert(txtDocument.uri, new vscode.Position(0, 0), 'prefix ');
		await vscode.workspace.applyEdit(edit);
		await wait();

		assert.strictEqual((await handledUris()).length, 1, 'Editing non-Python file should not change count');

		await txtDocument.save();
		await wait();

		assert.strictEqual((await handledUris()).length, 1, 'Saving non-Python file should not change count');
	});

	test('Diagnostics populate for inefficient Python pattern', async () => {
		const pythonUri = await createWorkspaceFile(
			'hot-loop.py',
			[
				'def build():',
				'    s = ""',
				'    for i in range(5):',
				'        s += "x"',
				'    return s',
				'',
			].join('\n'),
		);

		await openDocument(pythonUri);
		const diagnostics = await codespeedDiagnostics(pythonUri);
		assert.ok(diagnostics.length > 0, 'Expected diagnostics for inefficient pattern');
		assert.ok(
			diagnostics.some((diag) => diag.message.toLowerCase().includes('string concatenation')),
			'Diagnostic message should mention string concatenation',
		);
	});

	test('Diagnostics remain empty for clean Python', async () => {
		const pythonUri = await createWorkspaceFile(
			'clean.py',
			[
				'def total(values):',
				'    return sum(values)',
				'',
			].join('\n'),
		);

		await openDocument(pythonUri);
		const diagnostics = await codespeedDiagnostics(pythonUri);
		assert.strictEqual(diagnostics.length, 0, 'Expected no diagnostics for clean file');
	});

	test('Secret storage command is registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes(SET_KEY_COMMAND), 'set key command should be registered');
	});
});
