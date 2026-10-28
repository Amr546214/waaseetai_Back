import { AppError } from './app-error';

/**
 * SVG sanitiser for the site-identity uploads. TWO independent DOM-based stages, never a regex on markup:
 *   1. DOMPurify (isomorphic-dompurify = DOMPurify on jsdom, the maintained reference sanitiser) with its SVG + SVG-filter allow-list profile, `<use>` added back, `<a>` / `<script>` / `<foreignObject>` forbidden;
 *   2. our own DOM walk over the result that enforces the identity rules DOMPurify's generic profile does not: only fragment references (href / xlink:href / url()), `<image>` only with an inline raster data URI,
 *      `<style>` and style="" only when they contain no import / external url() / escape / expression, no xml:base, no foreign namespaces.
 * The cleaned DOM is serialised by OUR serializer (valid XML, every element explicitly closed, one root, no prolog, no DOCTYPE, no comments), and the output must be a FIXED POINT: running the whole pipeline
 * again on its own output must change nothing (the mutation-XSS guard). Anything that cannot be cleaned safely (entities, DOCTYPE internal subset, a root that is not <svg>, nothing left) is REJECTED, not repaired.
 *
 * It never fetches anything: external references are removed, not resolved.
 */

export class SvgRejected extends AppError {
	constructor(message: string, public readonly reason: string) { super(message, 400, [{ field: 'file', message, reason }], 'SITE_IDENTITY_FILE_REJECTED'); }
}

export interface SvgSanitizeResult { svg: string; /** elements + attributes removed (DOMPurify + our stage) */ removed: number; changed: boolean; removedDetail: string[]; width: number | null; height: number | null }

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** DOMPurify forbids these outright (a, script, foreignObject, ... ); the allow-list profile already excludes most of them, this is belt and braces */
const FORBID_TAGS = ['script', 'foreignObject', 'foreignobject', 'a', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'html', 'body', 'head', 'math', 'template', 'noscript', 'animate', 'set', 'animateMotion', 'animateTransform', 'animateColor', 'discard', 'handler', 'listener', 'script'];
/** the elements our stage lets stay (SVG 1.1 static drawing + filters + <use> + <style>/<title>/<desc>); anything else is removed even if DOMPurify let it through */
const ALLOWED_TAGS = new Set([
	'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'title', 'desc', 'style',
	'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask', 'marker', 'image', 'switch', 'view',
	'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix', 'fediffuselighting', 'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood',
	'fefunca', 'fefuncb', 'fefuncg', 'fefuncr', 'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology', 'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
]);
const FRAGMENT = /^#[A-Za-z_][\w:.\-]*$/;
const RASTER_DATA_URI = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const BAD_VALUE = /javascript\s*:|vbscript\s*:|livescript\s*:|data\s*:\s*(?:text|application|image\/svg)|<\s*script|expression\s*\(|-moz-binding|behaviou?r\s*:/i;

let purifyPromise: Promise<any> | null = null;
const purify = () => (purifyPromise ??= import('isomorphic-dompurify').then(m => (m as any).default ?? m));

/** every url(...) in a value must point at a fragment (#id); returns false for anything else (external, data:, relative file, escaped) */
function urlsAreLocal(value: string): boolean {
	const re = /url\s*\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"]*))\s*\)/gi;
	let m: RegExpExecArray | null; let seen = 0;
	while ((m = re.exec(value))) { seen++; const target = (m[1] ?? m[2] ?? m[3] ?? '').trim(); if (!FRAGMENT.test(target)) return false; }
	// a "url(" that the pattern above could not parse (unterminated, odd quoting) is unsafe
	const opens = (value.match(/url\s*\(/gi) ?? []).length;
	return opens === seen;
}
/** CSS text (a <style> body or a style="" value) is acceptable when it carries no import, no escape, no external reference and no legacy script hooks */
export function cssIsSafe(css: string): boolean {
	if (/@import|@namespace|@font-face|@charset|\\|\/\*|image-set\s*\(|(?:^|[^\w-])src\s*\(|(?:^|[^\w-])element\s*\(|cross-fade\s*\(|paint\s*\(|<\s*\/?\s*style|<!\[|\]\]>|<\s*!--|--\s*>/i.test(css)) return false;
	if (BAD_VALUE.test(css)) return false;
	return urlsAreLocal(css);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// characters that are not allowed in XML 1.0 (control characters); they are dropped from text and attribute values
// eslint-disable-next-line no-control-regex
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

interface Ctx { removed: number; detail: string[] }
const note = (c: Ctx, what: string) => { c.removed++; if (c.detail.length < 40) c.detail.push(what); };

function walk(node: any, c: Ctx): void {
	for (const child of Array.from(node.childNodes) as any[]) {
		if (child.nodeType === 1) {
			const tag = String(child.localName ?? child.nodeName).toLowerCase();
			const ns = child.namespaceURI;
			if (ns !== SVG_NS || !ALLOWED_TAGS.has(tag) || FORBID_TAGS.includes(tag)) { note(c, `element <${tag}>`); node.removeChild(child); continue; }
			if (tag === 'style') {
				const css = String(child.textContent ?? '');
				if (!cssIsSafe(css)) { note(c, 'element <style> with unsafe CSS'); node.removeChild(child); continue; }
			}
			// attributes
			for (const attr of Array.from(child.attributes) as any[]) {
				const name = String(attr.name); const lname = name.toLowerCase(); const value = String(attr.value);
				let drop = false;
				if (lname.startsWith('xmlns')) { child.removeAttribute(name); continue; } // namespace declarations are re-added by the serializer (not a content change)
				else if (lname.startsWith('on')) drop = true;
				else if (lname === 'xml:base') drop = true;
				else if (name.includes(':') && !/^(xlink:href|xlink:title|xml:space|xml:lang)$/.test(lname)) drop = true; // foreign namespaces (inkscape:, sodipodi:, rdf:, ...)
				else if (lname === 'href' || lname === 'xlink:href') {
					const v = value.trim();
					const dataImage = tag === 'image' && RASTER_DATA_URI.test(v);
					if (!(FRAGMENT.test(v) || dataImage)) drop = true;
				} else if (lname === 'src' || lname === 'srcset' || lname === 'formaction' || lname === 'action' || lname === 'background' || lname === 'poster' || lname === 'data') drop = true;
				else if (lname === 'style') { if (!cssIsSafe(value)) drop = true; }
				else if (BAD_VALUE.test(value) || (/url\s*\(/i.test(value) && !urlsAreLocal(value))) drop = true;
				if (drop) { note(c, `attribute ${name} on <${tag}>`); child.removeAttribute(name); }
			}
			if (tag === 'use' || tag === 'image' || tag === 'feimage') {
				// nothing to draw once its reference was refused (or was never there)
				if (!child.hasAttribute('href') && !child.hasAttribute('xlink:href')) { note(c, `element <${tag}> without a safe reference`); node.removeChild(child); continue; }
			}
			walk(child, c);
		} else if (child.nodeType === 3) {
			// text stays (it is escaped on output)
		} else if (child.nodeType === 4) {
			// CDATA: keep its text as plain text
		} else { node.removeChild(child); } // comments, processing instructions, anything else
	}
}

function serialize(el: any, isRoot = false): string {
	const tag = String(el.localName);
	let attrs = '';
	for (const a of Array.from(el.attributes) as any[]) attrs += ` ${a.name}="${esc(String(a.value).replace(XML_BAD, ''))}"`;
	const ns = isRoot ? ` xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}"` : '';
	let inner = '';
	for (const ch of Array.from(el.childNodes) as any[]) {
		if (ch.nodeType === 1) inner += serialize(ch);
		else if (ch.nodeType === 3 || ch.nodeType === 4) inner += esc(String(ch.data).replace(XML_BAD, '')).replace(/&quot;/g, '"');
	}
	return `<${tag}${ns}${attrs}>${inner}</${tag}>`;
}

function dimensionsOf(root: any): { width: number | null; height: number | null } {
	const vb = String(root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
	if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
	const num = (v: string | null) => { const m = /^\s*([0-9]*\.?[0-9]+)\s*(?:px)?\s*$/i.exec(v ?? ''); return m ? Number(m[1]) : null; };
	const w = num(root.getAttribute('width')), h = num(root.getAttribute('height'));
	return { width: w && w > 0 ? w : null, height: h && h > 0 ? h : null };
}

/** one pass of the pipeline over a string; returns the serialised result and what was removed */
async function pass(markup: string): Promise<{ svg: string; ctx: Ctx; width: number | null; height: number | null }> {
	const DOMPurify = await purify();
	const ctx: Ctx = { removed: 0, detail: [] };
	const body: any = DOMPurify.sanitize(markup, {
		USE_PROFILES: { svg: true, svgFilters: true },
		ADD_TAGS: ['use'], FORBID_TAGS, FORBID_ATTR: ['xml:base'],
		RETURN_DOM: true, ALLOW_UNKNOWN_PROTOCOLS: false,
	});
	const removedByPurify = (DOMPurify.removed as any[]).filter(r => !(r.element && /^(body|html|head)$/i.test(String(r.element.nodeName)))).length;
	ctx.removed += removedByPurify; if (removedByPurify) ctx.detail.push(`${removedByPurify} item(s) removed by the DOMPurify allow-list`);
	const kids = Array.from(body.childNodes) as any[];
	const roots = kids.filter(k => k.nodeType === 1);
	const stray = kids.filter(k => k.nodeType === 3 && String(k.data).trim() !== '');
	if (stray.length) note(ctx, 'text outside the <svg> root');
	if (roots.length !== 1 || String(roots[0].localName).toLowerCase() !== 'svg') throw new SvgRejected('الملف ليس ملف SVG صالحًا (لا يوجد عنصر <svg> جذر واحد بعد التنظيف).', 'NO_SVG_ROOT');
	const root = roots[0];
	walk({ childNodes: [root], removeChild: () => { throw new SvgRejected('عنصر الجذر غير مسموح.', 'ROOT_FORBIDDEN'); } }, ctx);
	const { width, height } = dimensionsOf(root);
	return { svg: serialize(root, true), ctx, width, height };
}

/** structural pre-checks that must REJECT (not clean): entity declarations and DOCTYPE internal subsets are the vector of entity-expansion bombs and XXE; a parse is never attempted on them */
function preReject(text: string): void {
	if (/<!ENTITY/i.test(text) || /<!ATTLIST/i.test(text) || /<!ELEMENT/i.test(text) || /<!NOTATION/i.test(text)) throw new SvgRejected('ملف SVG يحتوي تعريفات كيانات (ENTITY/DOCTYPE) وهي غير مسموحة. صدّر الملف كـ SVG عادي بلا DOCTYPE.', 'ENTITY_DECLARATION');
	if (/<!DOCTYPE[^>]*\[/i.test(text)) throw new SvgRejected('ملف SVG يحتوي DOCTYPE بمجموعة داخلية وهو غير مسموح.', 'DOCTYPE_SUBSET');
	// a doctype that is never closed would swallow the document in a lenient parser
	if (/<!DOCTYPE/i.test(text) && !/<!DOCTYPE[^>]*>/i.test(text)) throw new SvgRejected('وسم DOCTYPE غير مكتمل.', 'DOCTYPE_UNTERMINATED');
	if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)[A-Za-z_][\w.-]*;/i.test(text)) throw new SvgRejected('ملف SVG يستخدم مراجع كيانات مخصّصة (&name;) وهي غير مسموحة.', 'ENTITY_REFERENCE');
}

/** Sanitises an uploaded SVG. Throws SvgRejected for anything that cannot be cleaned safely. Never returns markup that a second pass would still change. */
export async function sanitizeSvg(input: Buffer): Promise<SvgSanitizeResult> {
	let text: string;
	try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { throw new SvgRejected('ملف SVG ليس بترميز UTF-8 صالح.', 'NOT_UTF8'); }
	text = text.replace(/^﻿/, '');
	if (text.includes('\u0000')) throw new SvgRejected('ملف SVG يحتوي بايتات صفرية.', 'NUL_BYTE');
	preReject(text);
	const first = await pass(text);
	if (!first.svg) throw new SvgRejected('لم يتبقَّ شيء من الملف بعد التنظيف.', 'EMPTY_AFTER_CLEAN');
	// fixed point: the cleaned output, cleaned again, must be identical (mutation-XSS guard)
	const second = await pass(first.svg);
	if (second.svg !== first.svg || second.ctx.removed !== 0) throw new SvgRejected('تعذّر تنظيف ملف SVG بشكل مستقر (تغيّر ناتج التنظيف عند إعادته). يُرجى تبسيط الملف أو إعادة تصديره.', 'UNSTABLE_CLEAN');
	return { svg: first.svg, removed: first.ctx.removed, changed: first.ctx.removed > 0, removedDetail: first.ctx.detail, width: first.width, height: first.height };
}
