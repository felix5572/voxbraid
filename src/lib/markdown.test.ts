import { describe, expect, it } from 'vitest';
import { markdownHtml, safeMarkdownHtml } from './markdown';

describe('markdownHtml', () => {
	it('renders the Markdown structures used by model answers', () => {
		const html = markdownHtml(`# Topic

- first
- **second**

| Source | Meaning |
| --- | --- |
| term | explanation |

\`inline\`

line one
line two

\`\`\`ts
const answer = 42;
\`\`\``);

		expect(html).toContain('<h1>Topic</h1>');
		expect(html).toContain('<ul>');
		expect(html).toContain('<strong>second</strong>');
		expect(html).toContain('<table>');
		expect(html).toContain('<code>inline</code>');
		expect(html).toMatch(/line one<br\s*\/?\s*>line two/u);
		expect(html).toMatch(/<pre><code(?: class="language-ts")?>const answer = 42;/u);
	});

	it('does not attempt browser sanitation while rendering on the server', () => {
		expect(safeMarkdownHtml('**client-only answer**')).toBe('');
	});
});
