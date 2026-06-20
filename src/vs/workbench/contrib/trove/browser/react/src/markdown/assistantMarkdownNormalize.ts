/**
 * Normalize agent "Step N — file:" headers so markdown renders cleanly.
 * Patterns like **Step 1 — `clock.js` :** break bold parsing and show literal asterisks.
 */
export const normalizeAssistantMarkdown = (text: string): string => {
	let s = text;

	// **Step N — `path` :** → heading (file path was inline code inside broken bold)
	s = s.replace(
		/\*\*Step (\d+)\s*[—–-]\s*`([^`]+)`\s*:\*\*/gi,
		(_match, stepNum: string, filePath: string) => `\n\n### Step ${stepNum} — ${filePath.trim()}\n\n`,
	);

	// **Step N — label :** without backticks
	s = s.replace(
		/\*\*Step (\d+)\s*[—–-]\s*([^*\n:`][^:\n*]{0,160}?)\s*:\*\*/gi,
		(_match, stepNum: string, label: string) => `\n\n### Step ${stepNum} — ${label.trim()}\n\n`,
	);

	// Remaining **label** at line start → heading (orphaned emphasis from partial streams)
	s = s.replace(
		/^\*\*([^*\n]{1,120})\*\*\s*$/gm,
		(_match, label: string) => `### ${label.trim()}`,
	);

	return s.replace(/\n{3,}/g, '\n\n');
}
