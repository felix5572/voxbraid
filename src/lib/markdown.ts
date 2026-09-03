import createDOMPurify, { type DOMPurify } from 'dompurify';
import { marked } from 'marked';

const ALLOWED_TAGS = [
	'a',
	'blockquote',
	'br',
	'code',
	'del',
	'em',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'hr',
	'li',
	'ol',
	'p',
	'pre',
	'strong',
	'table',
	'tbody',
	'td',
	'th',
	'thead',
	'tr',
	'ul'
];

const SAFE_LINK_PATTERN = /^(?:https?|mailto):/i;

let browserPurifier: DOMPurify | null = null;

export function markdownHtml(markdown: string): string {
	return marked.parse(markdown, {
		async: false,
		gfm: true,
		breaks: true
	});
}

function purifier(): DOMPurify | null {
	if (browserPurifier) return browserPurifier;
	if (typeof window === 'undefined') return null;

	browserPurifier = createDOMPurify(window);
	browserPurifier.addHook('afterSanitizeAttributes', (node) => {
		if (node.nodeName !== 'A') return;
		const link = node as HTMLAnchorElement;
		if (!link.hasAttribute('href')) {
			link.replaceWith(link.textContent ?? '');
			return;
		}
		link.setAttribute('target', '_blank');
		link.setAttribute('rel', 'noopener noreferrer');
	});
	return browserPurifier;
}

export function safeMarkdownHtml(markdown: string): string {
	const instance = purifier();
	if (!instance) return '';

	return instance.sanitize(markdownHtml(markdown), {
		ALLOWED_TAGS,
		ALLOWED_ATTR: ['href', 'title'],
		ALLOWED_URI_REGEXP: SAFE_LINK_PATTERN,
		ALLOW_ARIA_ATTR: false,
		ALLOW_DATA_ATTR: false
	});
}
