export enum FindingSeverity {
	Hint = 'hint',
	Info = 'info',
	Warning = 'warning',
	Error = 'error',
}

export type FindingConfidence = 'high' | 'medium' | 'low';

export interface FindingRange {
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
}

export interface Finding {
	ruleId: string;
	message: string;
	severity: FindingSeverity;
	range: FindingRange;
	confidence: FindingConfidence;
	needsContext: boolean;
	notes?: string;
}

type ApiKeyProvider = () => PromiseLike<string | undefined>;

let apiKeyProvider: ApiKeyProvider | undefined;
let llmEnabled: boolean | undefined;

const DEFAULT_ENABLE_LLM = process.env.CODESPEED_ENABLE_LLM === 'true';

export function configureAnalyzer(config: { getApiKey?: ApiKeyProvider; enableLLM?: boolean }): void {
	apiKeyProvider = config.getApiKey ?? apiKeyProvider;
	llmEnabled = config.enableLLM ?? llmEnabled;
}

export async function analyzePython(uri: string, text: string): Promise<Finding[]> {
	const ruleFindings = runStaticRules(text);
	const needsLLM = ruleFindings.some((finding) => finding.confidence === 'low' || finding.needsContext);

	if (!needsLLM) {
		return ruleFindings;
	}

	if (!(llmEnabled ?? DEFAULT_ENABLE_LLM)) {
		return ruleFindings;
	}

	const key = await apiKeyProvider?.();
	if (!key) {
		return ruleFindings;
	}

	const llmFindings = await runLlmPass(uri, text, ruleFindings, key);
	return [...ruleFindings, ...llmFindings];
}

function runStaticRules(text: string): Finding[] {
	const findings: Finding[] = [];
	const lines = text.split(/\r?\n/);
	const loopIndents: number[] = [];

	// Track simple assignments of list/tuple literals so we can flag membership checks with high confidence.
	const collectionLiteralKindByVar = new Map<string, 'list' | 'tuple'>();

	for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
		const line = lines[lineNumber];
		const indent = line.match(/^\s*/)?.[0].length ?? 0;

		while (loopIndents.length > 0 && indent <= loopIndents[loopIndents.length - 1]) {
			loopIndents.pop();
		}

		const trimmed = line.trimStart();
		if (trimmed.startsWith('for ') || trimmed.startsWith('while ')) {
			loopIndents.push(indent);
		}

		const insideLoop = loopIndents.some((loopIndent) => indent > loopIndent);

		// Record simple list/tuple literal assignments (best-effort, avoids heavy parsing).
		// Examples: allowed = [1, 2, 3]  OR  allowed = (
		const assignMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\[|\()/);
		if (assignMatch) {
			const varName = assignMatch[1];
			const opener = assignMatch[2];
			collectionLiteralKindByVar.set(varName, opener === '[' ? 'list' : 'tuple');
		}

		// High-confidence: string concatenation inside loops (can become quadratic as the string grows).
		const stringConcatAugAssign = insideLoop && /\b[a-zA-Z0-9_\[\].]+\s*\+=\s*(f?["']|str\(|format\(|\().*/.test(line);
		const stringConcatExplicit =
			insideLoop &&
			/\b([a-zA-Z0-9_\[\].]+)\s*=\s*\1\s*\+\s*(f?["']|str\(|format\(|\().*/.test(line);

		if (stringConcatAugAssign || stringConcatExplicit) {
			findings.push({
				ruleId: 'loop.string-concat',
				message:
					'Building strings with + or += inside loops can be slow (often quadratic). Prefer collecting parts and using "".join(parts), or use io.StringIO / chunked writes for streaming output.',
				severity: FindingSeverity.Warning,
				range: buildRange(lineNumber, line, stringConcatExplicit ? '+' : '+='),
				confidence: 'high',
				needsContext: false,
			});
		}

		if (insideLoop && line.includes('re.compile')) {
			findings.push({
				ruleId: 'loop.re-compile',
				message: 'Regular expressions compiled inside loops re-do work; compile once outside the loop.',
				severity: FindingSeverity.Warning,
				range: buildRange(lineNumber, line, 're.compile'),
				confidence: 'high',
				needsContext: false,
			});
		}

		if (insideLoop && /\.pop\(\s*0\s*\)/.test(line)) {
			findings.push({
				ruleId: 'loop.pop-front',
				message: 'list.pop(0) inside loops is O(n); consider collections.deque for efficient pops from the front.',
				severity: FindingSeverity.Warning,
				range: buildRange(lineNumber, line, '.pop'),
				confidence: 'high',
				needsContext: false,
			});
		}

		// High-signal: repeated membership checks against a list/tuple inside loops.
		// Example: if x in allowed_list:  (where allowed_list was created as a list/tuple literal)
		if (insideLoop) {
			// Case A (high confidence): membership against a tracked list/tuple variable
			const inVarMatch = line.match(/\bin\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
			if (inVarMatch) {
				const varName = inVarMatch[1];
				const kind = collectionLiteralKindByVar.get(varName);
				if (kind) {
					findings.push({
						ruleId: 'ds.list-membership',
						message:
							`Membership checks against a ${kind} inside loops are O(n) per lookup. If you do this repeatedly, convert it to a set/dict once (e.g., constSet = set(${varName})) for average O(1) membership.`,
						severity: FindingSeverity.Warning,
						range: buildRange(lineNumber, line, ' in '),
						confidence: 'high',
						needsContext: false,
					});
				}
			}

			// Case B (medium confidence): explicit list/tuple literal membership inside a loop
			// Example: if x in [1, 2, 3]:
			if (/\bin\s*\[/.test(line) || /\bin\s*\(/.test(line)) {
				findings.push({
					ruleId: 'ds.list-membership',
					message:
						'Membership checks against list/tuple literals inside loops are O(n) per lookup and rebuild the literal each time. Move the collection out of the loop and use a set/dict for repeated membership tests.',
					severity: FindingSeverity.Warning,
					range: buildRange(lineNumber, line, ' in '),
					confidence: 'medium',
					needsContext: true,
				});
			}
		}

		if (line.includes('.apply(') && line.includes('axis=1')) {
			findings.push({
				ruleId: 'pandas.apply-rowwise',
				message: 'DataFrame.apply(axis=1) runs Python for each row; vectorize operations where possible.',
				severity: FindingSeverity.Info,
				range: buildRange(lineNumber, line, '.apply'),
				confidence: 'medium',
				needsContext: true,
			});
		}

		if (line.includes('iterrows()')) {
			findings.push({
				ruleId: 'pandas.iterrows',
				message: 'DataFrame.iterrows() is slow for large frames; prefer itertuples() or vectorized operations.',
				severity: FindingSeverity.Info,
				range: buildRange(lineNumber, line, 'iterrows'),
				confidence: 'medium',
				needsContext: true,
			});
		}
	}

	return findings;
}

function buildRange(lineNumber: number, line: string, token: string): FindingRange {
	const startChar = Math.max(0, line.indexOf(token));
	const endChar = Math.max(startChar + token.length, startChar + 1);
	return {
		startLine: lineNumber,
		startChar,
		endLine: lineNumber,
		endChar,
	};
}

async function runLlmPass(uri: string, text: string, existingFindings: Finding[], apiKey: string): Promise<Finding[]> {
	const contextWindow = 12;
	const lines = text.split(/\r?\n/);
	const anchor = existingFindings.find((finding) => finding.needsContext || finding.confidence === 'low');

	if (!anchor) {
		return [];
	}

	const startLine = Math.max(0, anchor.range.startLine - Math.floor(contextWindow / 2));
	const endLine = Math.min(lines.length, anchor.range.endLine + Math.floor(contextWindow / 2));
	const snippet = lines.slice(startLine, endLine).join('\n');

	try {
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: 'gpt-4o-mini',
				messages: [
					{
						role: 'system',
						content:
							'You are an assistant that identifies performance issues in Python. Return concise JSON findings.',
					},
					{
						role: 'user',
						content: [
							`File: ${uri}`,
							'Analyze the performance of this snippet and suggest improvements.',
							'Return JSON array with fields: ruleId, message, severity (info|warning), confidence (low|medium), notes.',
							'If nothing obvious, return an empty array.',
							'Snippet:',
							snippet,
						].join('\n'),
					},
				],
				max_tokens: 300,
				temperature: 0.2,
			}),
		});

		const json: any = await response.json();
		const content: string | undefined = json?.choices?.[0]?.message?.content;
		if (!content) {
			return [];
		}

		const parsed = JSON.parse(content) as Array<{
			ruleId: string;
			message: string;
			severity?: string;
			confidence?: FindingConfidence;
			notes?: string;
		}>;

		return parsed
			.filter((item) => Boolean(item?.ruleId && item?.message))
			.map<Finding>((item) => ({
				ruleId: item.ruleId || 'llm.suggestion',
				message: item.message,
				severity: normalizeSeverity(item.severity),
				range: {
					startLine,
					startChar: 0,
					endLine: endLine - 1,
					endChar: lines[endLine - 1]?.length ?? 0,
				},
				confidence: item.confidence ?? 'low',
				needsContext: false,
				notes: item.notes,
			}));
	} catch (error) {
		console.warn('[codespeed] LLM analysis skipped due to error:', error);
		return [];
	}
}

function normalizeSeverity(severity?: string): FindingSeverity {
	if (!severity) {
		return FindingSeverity.Info;
	}

	const normalized = severity.toLowerCase();
	if (normalized === 'error') {
		return FindingSeverity.Error;
	}
	if (normalized === 'warning' || normalized === 'warn') {
		return FindingSeverity.Warning;
	}
	if (normalized === 'hint') {
		return FindingSeverity.Hint;
	}
	return FindingSeverity.Info;
}
