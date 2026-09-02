export function errorDetails(error: unknown): string {
	if (!(error instanceof Error)) {
		try {
			return `thrown value: ${JSON.stringify(error)}`;
		} catch {
			return `thrown value: ${String(error)}`;
		}
	}
	const details = [`name: ${error.name}`, `message: ${error.message}`];
	if (error.stack) details.push(`stack:\n${error.stack}`);
	if (error.cause !== undefined) details.push(`cause:\n${errorDetails(error.cause)}`);
	return details.join('\n');
}

export function inlineErrorDetails(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	try {
		return String(error);
	} catch {
		return '[无法转换的异常值]';
	}
}
