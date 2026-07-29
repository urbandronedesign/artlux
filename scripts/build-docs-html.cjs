// Render the docs/user-guide/ markdown set into ONE self-contained HTML file:
// all pages concatenated with a sidebar, all screenshots inlined as base64 data URIs,
// internal .md links rewritten to in-page anchors, and external ../docs links pointed
// at the GitHub repo. Open the result in any browser, or print it to PDF.
//
//   node scripts/build-docs-html.cjs   →   docs/user-guide/artlux-user-guide.html

const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');

const DIR = path.resolve(__dirname, '..', 'docs', 'user-guide');
const IMG = path.join(DIR, 'images');
const OUT = path.join(DIR, 'artlux-user-guide.html');
const REPO_DOCS = 'https://github.com/urbandronedesign/artlux/blob/main/docs';

// Page order (README first, then numbered pages) — read from docs/manifest.json.
//
// ⚠ THIS LIST USED TO BE HAND-MAINTAINED HERE, AND IT FAILED EXACTLY AS ITS OWN WARNING PREDICTED.
// The warning read: "A page missing from it is simply ABSENT from the built HTML — no error, no
// warning." By 2026-07-29 the list ended at `'13-keyboard-reference.md'`, **a file that no longer
// existed** — the guide had grown 13-tracking, 14-show-state-machine and 15-keyboard-reference — so the
// built guide silently dropped the Tracking and Show/state-machine chapters and emitted one dead entry.
// Nobody noticed, because a silent omission looks exactly like a complete document.
//
// It now comes from docs/manifest.json, the single documentation index, and scripts/verify-docs.cjs
// fails `npm run verify` if that manifest and the directory disagree. A comment warning you to keep two
// lists in sync is not a mechanism; this is.
const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'manifest.json'), 'utf8'));
const PAGES = MANIFEST.guide;

const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, '')
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
const pageId = (file) => (file === 'README.md' ? 'index' : file.replace(/\.md$/, ''));

const imgCache = new Map();
function dataUri(rel) {
    const name = rel.replace(/^images\//, '');
    if (imgCache.has(name)) return imgCache.get(name);
    const file = path.join(IMG, name);
    if (!fs.existsSync(file)) return rel;
    const b64 = fs.readFileSync(file).toString('base64');
    const uri = `data:image/png;base64,${b64}`;
    imgCache.set(name, uri);
    return uri;
}

const nav = [];

function renderPage(file) {
    const md = fs.readFileSync(path.join(DIR, file), 'utf-8');
    let html = marked.parse(md, { mangle: false, headerIds: false });

    // give headings stable ids (for the sidebar + cross-page anchors)
    html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) =>
        `<h${lvl} id="${slug(inner)}">${inner}</h${lvl}>`);

    // record the page title (first h1) for the sidebar
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    nav.push({ id: pageId(file), title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '') : file });

    // inline images
    html = html.replace(/<img([^>]*?)src="([^"]+)"/g, (_m, pre, src) =>
        `<img${pre}src="${src.startsWith('images/') ? dataUri(src) : src}"`);

    // rewrite links
    html = html.replace(/href="([^"]+)"/g, (_m, href) => {
        if (/^https?:|^mailto:|^data:/.test(href)) return `href="${href}"`;
        if (href.startsWith('#')) return `href="${href}"`;                 // same-page anchor
        // ../something(.md)  →  GitHub docs
        if (href.startsWith('../')) {
            const clean = href.replace(/^\.\.\//, '').replace(/^docs\//, '');
            return `href="${REPO_DOCS}/${clean}" target="_blank" rel="noopener"`;
        }
        // X.md  or  ./X.md  or  X.md#frag  →  in-page anchor
        const m = href.match(/^\.?\/?([\w-]+)\.md(#.+)?$/);
        if (m) {
            if (m[2]) return `href="${m[2]}"`;          // keep the fragment (global heading id)
            return `href="#${m[1] === 'README' ? 'index' : m[1]}"`;
        }
        return `href="${href}"`;
    });

    return `<section id="${pageId(file)}" class="page">${html}</section>`;
}

const sections = PAGES.map(renderPage).join('\n');
const navHtml = nav.map((n) => `<a href="#${n.id}">${n.title}</a>`).join('\n');

const doc = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ArtLux — User Guide</title>
<style>
:root{--bg:#0c0e12;--bg2:#14171d;--panel:#171b22;--line:#262b33;--fg:#e6e9ee;--fg2:#aab2bd;--fg3:#717a86;--accent:#36c5f0;}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
#wrap{display:flex;align-items:flex-start;max-width:1200px;margin:0 auto}
nav{position:sticky;top:0;align-self:flex-start;width:250px;height:100vh;overflow:auto;padding:24px 14px;border-right:1px solid var(--line);background:var(--bg2);flex:none}
nav .brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:16px;margin:0 6px 16px}
nav .brand .mark{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#38bdf8,#2563eb);display:grid;place-items:center;color:#fff;font-weight:800}
nav a{display:block;padding:6px 10px;border-radius:7px;color:var(--fg2);text-decoration:none;font-size:13.5px}
nav a:hover{background:#ffffff0d;color:var(--fg)}
main{flex:1;min-width:0;padding:32px 44px 120px}
.page{padding-bottom:28px;margin-bottom:28px;border-bottom:1px solid var(--line)}
.page:last-child{border-bottom:none}
h1{font-size:30px;margin:.2em 0 .5em;padding-top:12px}
h2{font-size:22px;margin:1.6em 0 .5em;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:17px;margin:1.4em 0 .4em;color:#dbe3ec}
a{color:var(--accent)}
img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;margin:10px 0;box-shadow:0 6px 24px #0006}
em{color:var(--fg2)}
code{background:#ffffff12;padding:1.5px 5px;border-radius:5px;font-size:13px;font-family:ui-monospace,Consolas,monospace}
pre{background:#0a0c10;border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13.5px}
th,td{border:1px solid var(--line);padding:7px 11px;text-align:left;vertical-align:top}
th{background:#ffffff08}
blockquote{margin:14px 0;padding:10px 16px;border-left:3px solid var(--accent);background:#36c5f00f;border-radius:0 8px 8px 0;color:var(--fg2)}
hr{border:none;border-top:1px solid var(--line);margin:24px 0}
@media print{nav{display:none}main{padding:0}.page{break-after:page}}
</style></head>
<body><div id="wrap">
<nav>
<div class="brand"><span class="mark">A</span> ArtLux Guide</div>
${navHtml}
</nav>
<main>${sections}</main>
</div></body></html>`;

fs.writeFileSync(OUT, doc, 'utf-8');
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`Wrote ${path.relative(path.resolve(__dirname, '..'), OUT)} (${kb} KB, ${nav.length} pages, ${imgCache.size} images inlined)`);
