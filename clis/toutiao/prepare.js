// Port of scripts/prepare_toutiao_draft.py (林可怡 Coralie repo) to Node, with
// no external dependencies. Reads a Markdown file, extracts the title, finds
// local images, and produces HTML with `codex-local://image/<n>` placeholders.
//
// The userscript on the toutiao publish page is responsible for swapping
// those placeholders for real Toutiao image nodes after upload.

const fs = require("node:fs");
const path = require("node:path");

const IMAGE_RE = /!\[(?<alt>[^\]]*)\]\((?<path>(?:[^()]|\([^()]*\))+)\)/g;
// Comment-image: a Markdown comment whose body is a relative or absolute local image path.
// Mirrors the Python COMMENT_IMAGE_PATTERN; multiline, matches anchored lines.
const COMMENT_IMAGE_RE = /^(?<indent>[ \t]*)<!--\s*(?<path>(?:\.\.?\/|\/|稿件\/)[^<>]+?\.(?:jpe?g|png|webp))\s*-->\s*$/gm;

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function mimeOf(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function readMarkdown(markdownPath) {
  if (!fs.existsSync(markdownPath)) {
    throw new Error(`Markdown 文件不存在: ${markdownPath}`);
  }
  return fs.readFileSync(markdownPath, "utf8");
}

function isRemotePath(value) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value.trim());
}

function resolveImagePath(markdownPath, rawPath) {
  const cleaned = decodeURIComponent(rawPath.trim().replace(/^<|>$/g, ""));
  if (cleaned.startsWith("/")) {
    return path.resolve(cleaned);
  }

  const markdownRelative = path.resolve(path.dirname(markdownPath), cleaned);
  if (fs.existsSync(markdownRelative)) {
    return markdownRelative;
  }

  // Some repository Markdown files use paths relative to the repository root
  // even when the Markdown itself lives several directories below it.
  let ancestor = path.dirname(path.dirname(markdownPath));
  while (true) {
    const candidate = path.resolve(ancestor, cleaned);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    ancestor = parent;
  }

  return markdownRelative;
}

function extractLocalImages(markdownPath, content) {
  const entries = [];
  // ![alt](path)
  for (const match of content.matchAll(IMAGE_RE)) {
    const raw = match.groups.path.trim();
    if (isRemotePath(raw)) continue;
    const abs = resolveImagePath(markdownPath, raw);
    if (!fs.existsSync(abs)) continue;
    const pathGroupStart = match.index + match[0].indexOf(match.groups.path);
    entries.push({
      kind: "markdown",
      rawPath: raw,
      absPath: abs,
      span: [pathGroupStart, pathGroupStart + match.groups.path.length],
    });
  }
  // <!-- path -->
  COMMENT_IMAGE_RE.lastIndex = 0;
  for (const match of content.matchAll(COMMENT_IMAGE_RE)) {
    const raw = match.groups.path.trim();
    if (isRemotePath(raw)) continue;
    const abs = resolveImagePath(markdownPath, raw);
    if (!fs.existsSync(abs)) continue;
    entries.push({
      kind: "comment",
      rawPath: raw,
      absPath: abs,
      span: [match.index, match.index + match[0].length],
    });
  }
  return entries.sort((a, b) => a.span[0] - b.span[0]);
}

// Replace image refs in markdown with placeholder URLs. Preserves the surrounding
// `![alt](...)` for inline images, and replaces the entire comment for comment images.
function injectPlaceholders(content, entries) {
  const parts = [];
  const occurrences = [];
  let cursor = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const placeholder = `codex-local://image/${i}`;
    const [start, end] = entry.span;
    parts.push(content.slice(cursor, start));
    if (entry.kind === "comment") {
      parts.push(`![](${placeholder})`);
    } else {
      parts.push(placeholder);
    }
    cursor = end;
    occurrences.push({
      index: i,
      placeholder_src: placeholder,
      local_path: entry.absPath,
      raw_path: entry.rawPath,
      kind: entry.kind,
      mime_type: mimeOf(entry.absPath),
    });
  }
  parts.push(content.slice(cursor));
  return { markdownWithPlaceholders: parts.join(""), occurrences };
}

function extractTitleAndBody(markdownPath, content) {
  let title = null;
  let body = content;

  const yamlMatch = body.match(/^---\s*\n([\s\S]*?)\n---\s*\n*/);
  if (yamlMatch) {
    const titleLine = yamlMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
    if (titleLine) title = titleLine[1].trim();
    body = body.slice(yamlMatch[0].length);
  }

  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) {
      title = h1[1].trim();
      body = body.replace(/^#\s+.+\n+/m, "");
    }
  }

  if (!title) title = path.basename(markdownPath, path.extname(markdownPath));
  body = body.trim();
  if (!body) throw new Error(`Markdown 正文为空，无法保存草稿: ${markdownPath}`);
  return { title, body };
}

// ── Tiny Markdown → HTML ──────────────────────────────────────────────────
// Ports simple_markdown_to_html from upload_baijiahao_draft.py. Handles the
// subset Toutiao drafts need: headings, paragraphs, lists, tables, blockquotes,
// fenced code, hr, inline code/bold/em/links/images.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" />`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*(.+?)\*/g, "<em>$1</em>");
  return out;
}

function splitBlocks(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let buffer = [];
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (buffer.length && !inCode) {
        blocks.push(buffer.join("\n"));
        buffer = [];
      }
      buffer.push(line);
      inCode = !inCode;
      if (!inCode) {
        blocks.push(buffer.join("\n"));
        buffer = [];
      }
      continue;
    }
    if (inCode) {
      buffer.push(line);
      continue;
    }
    if (!line.trim()) {
      if (buffer.length) {
        blocks.push(buffer.join("\n"));
        buffer = [];
      }
      continue;
    }
    buffer.push(line);
  }
  if (buffer.length) blocks.push(buffer.join("\n"));
  return blocks.filter((b) => b.trim());
}

function isTable(block) {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const sep = lines[1].replace(/[|: ]/g, "");
  return lines[0].includes("|") && sep && /^-+$/.test(sep);
}

function renderTable(block) {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  const parseRow = (line) =>
    line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => renderInline(cell.trim()));
  const headers = parseRow(lines[0]);
  const rows = lines.slice(2);
  const thead = `<thead><tr>${headers.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map((r) => `<tr>${parseRow(r).map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

function renderList(block, ordered) {
  const stripper = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
  const items = block
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => `<li>${renderInline(l.replace(stripper, ""))}</li>`);
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items.join("")}</${tag}>`;
}

function markdownToHtml(markdown) {
  const out = [];
  for (const block of splitBlocks(markdown)) {
    if (block.startsWith("```") && block.endsWith("```")) {
      const firstNl = block.indexOf("\n");
      const lang = firstNl !== -1 ? block.slice(3, firstNl).trim() : "";
      const code = firstNl !== -1 ? block.slice(firstNl + 1, -3) : "";
      const cls = lang ? ` class="language-${lang}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(code)}</code></pre>`);
      continue;
    }
    if (isTable(block)) {
      out.push(renderTable(block));
      continue;
    }
    const heading = block.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }
    if (/^-{3,}$/.test(block.trim())) {
      out.push("<hr />");
      continue;
    }
    const lines = block.split("\n").filter((l) => l.trim());
    if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
      out.push(renderList(block, false));
      continue;
    }
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      out.push(renderList(block, true));
      continue;
    }
    if (lines.every((l) => /^\s*>/.test(l))) {
      const quoted = lines.map((l) => renderInline(l.replace(/^\s*>\s?/, ""))).join("<br />");
      out.push(`<blockquote>${quoted}</blockquote>`);
      continue;
    }
    if (block.startsWith("<") && block.endsWith(">")) {
      out.push(block);
      continue;
    }
    const paragraph = block.split("\n").map((l) => renderInline(l.trim())).join("<br />");
    out.push(`<p>${paragraph}</p>`);
  }
  return out.join("\n");
}

// ── Public entry point ────────────────────────────────────────────────────
function prepareDraftPayload(markdownPath) {
  const absMarkdown = path.resolve(markdownPath);
  const raw = readMarkdown(absMarkdown);
  const entries = extractLocalImages(absMarkdown, raw);
  const { markdownWithPlaceholders, occurrences } = injectPlaceholders(raw, entries);
  const { title, body } = extractTitleAndBody(absMarkdown, markdownWithPlaceholders);
  const html = markdownToHtml(body);

  // Dedupe by absolute path so we upload each unique image once.
  const uniqueByPath = new Map();
  for (const occ of occurrences) {
    if (!uniqueByPath.has(occ.local_path)) {
      uniqueByPath.set(occ.local_path, {
        local_path: occ.local_path,
        mime_type: occ.mime_type,
        placeholders: [occ.placeholder_src],
      });
    } else {
      uniqueByPath.get(occ.local_path).placeholders.push(occ.placeholder_src);
    }
  }

  return {
    markdown: absMarkdown,
    title,
    html,
    images: occurrences,
    image_occurrence_count: occurrences.length,
    unique_image_count: uniqueByPath.size,
    unique_images: [...uniqueByPath.values()],
  };
}

module.exports = { prepareDraftPayload, markdownToHtml };
