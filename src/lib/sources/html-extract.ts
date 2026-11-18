// Bounded extraction of facts from one HTML document.
// The HTML is UNTRUSTED: it is parsed as data, never executed, and nothing in
// it can alter program behavior. Text is length-capped before storage.
//
// Limitation (stated in every report): this reads the HTML as delivered. Content
// inserted by JavaScript after load is not seen.

import { parse } from 'parse5';

export type ExtractedLink = { href: string; text: string; sameHost: boolean; path: string | null };
export type ExtractedForm = { fieldCount: number; hasTextarea: boolean; isSearch: boolean };

export type PageFacts = {
  title: string;
  text: string;
  links: ExtractedLink[];
  forms: ExtractedForm[];
  phones: string[];
  /**
   * Reasons this page could NOT be read in full. A page with any entry here
   * must not be used to conclude that something is absent.
   *   html_truncated / text_truncated / links_truncated   a size limit was hit
   *   thin_content        almost no text in the HTML: the page is probably drawn by scripts
   *   embedded:<host>     an iframe or known third-party widget whose content is not in this HTML
   */
  readLimits: string[];
};

type Node = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
};

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'head']);
const BLOCK = new Set(['p', 'div', 'li', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'footer', 'header', 'tr', 'td', 'address', 'nav']);
const MAX_TEXT = 60_000;
const MAX_LINKS = 600;
const MAX_HTML = 1_000_000;

/** Iframes that are media or maps, not a place where a form or scheduler would be. */
const BENIGN_EMBED = /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|google\.com|gstatic\.com|googletagmanager\.com|doubleclick\.net|facebook\.com|fbcdn\.net|twitter\.com|x\.com|instagram\.com|bing\.com|openstreetmap\.org)$/i;
/** Script hosts of scheduling, form and chat products that draw their own interface after load. */
const WIDGET_SCRIPT = /(?:^|\.)(?:housecallpro\.com|servicetitan\.com|scheduleengine\.net|getjobber\.com|clienthub\.getjobber\.com|workiz\.com|calendly\.com|acuityscheduling\.com|squareup\.com|setmore\.com|schedulenow\.com|jotform\.com|typeform\.com|hsforms\.net|hsforms\.com|hubspot\.com|formstack\.com|wufoo\.com|cognitoforms\.com|123formbuilder\.com|formassembly\.com|leadconnectorhq\.com|msgsndr\.com|podium\.com|birdeye\.com|elfsight\.com|tawk\.to|intercom\.io|drift\.com|liveperson\.net|olark\.com|tidio\.co|crisp\.chat|zendesk\.com|zdassets\.com|smith\.ai|ruby\.com|callrail\.com)$/i;

export const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

function attr(node: Node, name: string): string | null {
  return node.attrs?.find((a) => a.name === name)?.value ?? null;
}

function isHidden(node: Node): boolean {
  if (attr(node, 'hidden') !== null) return true;
  if (attr(node, 'aria-hidden') === 'true') return true;
  const style = (attr(node, 'style') ?? '').replace(/\s+/g, '').toLowerCase();
  return style.includes('display:none') || style.includes('visibility:hidden');
}

function textOf(node: Node, out: string[], budget: { left: number }): void {
  if (budget.left <= 0) return;
  if (node.nodeName === '#text') {
    const v = (node.value ?? '').replace(/\s+/g, ' ');
    if (v.trim()) {
      out.push(v.slice(0, budget.left));
      budget.left -= v.length;
    }
    return;
  }
  if (node.nodeName.startsWith('#') && node.nodeName !== '#document' && node.nodeName !== '#document-fragment') return;
  if (SKIP.has(node.nodeName) || isHidden(node)) return;
  for (const child of node.childNodes ?? []) textOf(child, out, budget);
  if (BLOCK.has(node.nodeName)) out.push('\n');
}

function collapse(parts: string[]): string {
  return parts
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function find(node: Node, name: string): Node | null {
  if (node.nodeName === name) return node;
  for (const child of node.childNodes ?? []) {
    const hit = find(child, name);
    if (hit) return hit;
  }
  return null;
}

export function extractPage(html: string, pageUrl: string): PageFacts {
  const readLimits: string[] = [];
  if (html.length > MAX_HTML) readLimits.push('html_truncated');
  const doc = parse(html.slice(0, MAX_HTML)) as unknown as Node;
  const base = new URL(pageUrl);

  const titleNode = find(doc, 'title');
  const titleParts: string[] = [];
  if (titleNode) for (const c of titleNode.childNodes ?? []) if (c.nodeName === '#text') titleParts.push(c.value ?? '');
  const title = titleParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);

  const body = find(doc, 'body') ?? doc;
  const parts: string[] = [];
  const textBudget = { left: MAX_TEXT };
  textOf(body, parts, textBudget);
  if (textBudget.left <= 0) readLimits.push('text_truncated');
  const text = collapse(parts).slice(0, MAX_TEXT);
  let scriptCount = 0;
  let linksTruncated = false;
  const embedded = new Set<string>();
  const thirdPartyHost = (raw: string | null): string | null => {
    if (!raw) return null;
    try {
      const u = new URL(raw, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const host = u.hostname.toLowerCase();
      return host.replace(/^www\./, '') === base.hostname.toLowerCase().replace(/^www\./, '') ? null : host;
    } catch {
      return null;
    }
  };

  const links: ExtractedLink[] = [];
  const forms: ExtractedForm[] = [];

  const walk = (node: Node, hidden: boolean): void => {
    // Content this parser does not read is noted, so its absence is never mistaken for "not there".
    if (node.nodeName === 'iframe') {
      const host = thirdPartyHost(attr(node, 'src') ?? attr(node, 'data-src'));
      if (host && !BENIGN_EMBED.test(host)) embedded.add(host);
    } else if (node.nodeName === 'script') {
      scriptCount++;
      const host = thirdPartyHost(attr(node, 'src'));
      if (host && WIDGET_SCRIPT.test(host)) embedded.add(host);
    }
    if (SKIP.has(node.nodeName)) return;
    const nowHidden = hidden || (!node.nodeName.startsWith('#') && isHidden(node));
    if (!nowHidden && (node.nodeName === 'a' || node.nodeName === 'button') && links.length >= MAX_LINKS) linksTruncated = true;
    if (!nowHidden && (node.nodeName === 'a' || node.nodeName === 'button') && links.length < MAX_LINKS) {
      const rawHref = attr(node, 'href') ?? attr(node, 'formaction') ?? '';
      const labelParts: string[] = [];
      textOf(node, labelParts, { left: 200 });
      const label = collapse(labelParts).replace(/\n/g, ' ').slice(0, 120) || (attr(node, 'aria-label') ?? '').slice(0, 120);
      let href = '';
      let sameHost = false;
      let path: string | null = null;
      if (rawHref) {
        try {
          const u = new URL(rawHref, base);
          href = u.toString().slice(0, 500);
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            sameHost = u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '');
            path = sameHost ? u.pathname : null;
          }
        } catch {
          href = '';
        }
      }
      if (href || label) links.push({ href, text: label, sameHost, path });
    }
    if (!nowHidden && node.nodeName === 'form') {
      let fieldCount = 0;
      let hasTextarea = false;
      let isSearch = (attr(node, 'role') ?? '').toLowerCase() === 'search';
      const scan = (n: Node): void => {
        if (n.nodeName === 'textarea') {
          hasTextarea = true;
          fieldCount++;
        } else if (n.nodeName === 'select') {
          fieldCount++;
        } else if (n.nodeName === 'input') {
          const type = (attr(n, 'type') ?? 'text').toLowerCase();
          if (type === 'search') isSearch = true;
          if (['text', 'email', 'tel', 'date', 'datetime-local', 'number'].includes(type)) fieldCount++;
        }
        for (const c of n.childNodes ?? []) scan(c);
      };
      scan(node);
      forms.push({ fieldCount, hasTextarea, isSearch });
    }
    for (const child of node.childNodes ?? []) walk(child, nowHidden);
  };
  walk(body, false);
  // Scripts in <head> count too when judging whether the page is drawn by scripts.
  const head = find(doc, 'head');
  const countScripts = (node: Node): void => {
    if (node.nodeName === 'script') {
      scriptCount++;
      const host = thirdPartyHost(attr(node, 'src'));
      if (host && WIDGET_SCRIPT.test(host)) embedded.add(host);
    }
    for (const child of node.childNodes ?? []) countScripts(child);
  };
  if (head) countScripts(head);
  if (linksTruncated) readLimits.push('links_truncated');
  if (text.length < 400 && (scriptCount >= 5 || html.length > 30_000)) readLimits.push('thin_content');
  for (const host of [...embedded].sort().slice(0, 8)) readLimits.push(`embedded:${host.slice(0, 80)}`);

  const phones = new Set<string>();
  for (const m of text.matchAll(PHONE_RE)) phones.add(m[0].trim());
  for (const link of links) {
    if (link.href.startsWith('tel:')) phones.add(decodeURIComponent(link.href.slice(4)).trim());
  }

  return { title, text, links, forms, phones: [...phones].slice(0, 10), readLimits };
}

// ---- Signal detection over extracted facts -------------------------------

const BOOKING_TEXT = /\b(book (?:online|now|an? (?:appointment|visit|service))|book|schedule (?:online|service|an? (?:appointment|visit))|schedule now|appointments?|request (?:service|an appointment|a quote|an estimate|a visit)|get a (?:free )?(?:quote|estimate)|online scheduling)\b/i;
const BOOKING_HOSTS = ['housecallpro.com', 'servicetitan.com', 'getjobber.com', 'calendly.com', 'schedulenow.com', 'workiz.com', 'squareup.com', 'acuityscheduling.com'];
const AFTER_HOURS = /\b(24\s?\/\s?7|24[- ]hours?|after[- ]hours|emergency (?:service|repairs?|calls?|line)|nights? (?:and|&) weekends?|around the clock)\b/i;
const PHONE_SCHEDULING = /\bcall\b[^.\n]{0,50}\b(?:schedule|book|appointment)\b|\b(?:schedule|book)\b[^.\n]{0,40}\bby (?:phone|calling)\b/i;
const HOURS = /\b(?:mon|monday|tue|tuesday|wed|thu|fri|friday|sat|sun|weekdays)\b[^.\n]{0,40}\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)/i;
const COPYRIGHT = /(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/i;
const INSTRUCTION_LIKE = /\b(ignore (?:all |any )?(?:previous|prior|above|your) instructions|disregard (?:the |all )?(?:previous|prior|above)|you are now\b|system prompt|attention ai\b|ai agents?:|email all leads|reveal (?:your )?(?:api )?keys?|mark this (?:business|report) as approved)/i;

export function excerptAround(text: string, index: number, length: number, radius = 80): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`.slice(0, 240);
}

export type PageSignals = {
  bookingLinks: { text: string; href: string }[];
  contactForms: ExtractedForm[];
  afterHours: string | null;
  phoneScheduling: string | null;
  hours: string | null;
  copyrightYear: number | null;
  instructionLike: string | null;
};

function match(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? excerptAround(text, m.index, m[0].length) : null;
}

export function detectSignals(facts: PageFacts): PageSignals {
  const bookingLinks: { text: string; href: string }[] = [];
  for (const link of facts.links) {
    if (link.href.startsWith('tel:') || link.href.startsWith('mailto:')) continue;
    let host = '';
    try {
      host = link.href ? new URL(link.href).hostname : '';
    } catch {
      host = '';
    }
    const knownHost = BOOKING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    if (knownHost || BOOKING_TEXT.test(link.text)) {
      bookingLinks.push({ text: link.text.slice(0, 80), href: link.href });
    }
  }
  const copyright = COPYRIGHT.exec(facts.text);
  return {
    bookingLinks: bookingLinks.slice(0, 5),
    contactForms: facts.forms.filter((f) => !f.isSearch && f.fieldCount >= 2),
    afterHours: match(facts.text, AFTER_HOURS),
    phoneScheduling: match(facts.text, PHONE_SCHEDULING),
    hours: match(facts.text, HOURS),
    copyrightYear: copyright ? Number(copyright[1]) : null,
    instructionLike: match(facts.text, INSTRUCTION_LIKE),
  };
}

const CANDIDATE_PATH = /(contact|book|schedul|appointment|request|quote|estimate|service)/i;

/** Same-site pages worth inspecting for the contact/booking journey, in page order. */
export function candidatePaths(facts: PageFacts, limit: number): string[] {
  const seen = new Set<string>(['/']);
  const out: string[] = [];
  for (const link of facts.links) {
    if (!link.sameHost || !link.path) continue;
    const path = link.path.replace(/\/+$/, '') || '/';
    if (seen.has(path)) continue;
    if (!CANDIDATE_PATH.test(path) && !CANDIDATE_PATH.test(link.text)) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|zip|docx?)$/i.test(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}
