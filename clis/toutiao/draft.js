const fs = require("node:fs");
const path = require("node:path");
const { defineCommand } = require("../../src/registry.js");
const { prepareDraftPayload } = require("./prepare.js");

const DEFAULT_WAIT_MS = 5 * 60 * 1000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

defineCommand({
  site: "toutiao",
  name: "draft",
  description:
    "Prepare a Markdown file and save it as a Toutiao draft via the publish-page bridge.",
  async run({ options, sendCommand, site }) {
    const markdownArg = options.markdown || options.file;
    if (!markdownArg || markdownArg === true) {
      throw new Error("Missing --markdown <path>");
    }
    const markdownPath = path.resolve(String(markdownArg));

    const waitMs =
      options.wait && options.wait !== true ? Number(options.wait) : DEFAULT_WAIT_MS;
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      throw new Error(`Invalid --wait value: ${options.wait}`);
    }

    const payload = prepareDraftPayload(markdownPath);

    // Each unique image becomes an attachment so the daemon serves it back at
    // /attachment/<cmd_id>/<idx>. The job's `images` array records each
    // occurrence's placeholder + which attachment to use.
    const uniquePaths = [...new Map(payload.images.map((img) => [img.local_path, img])).keys()];
    const attachments = uniquePaths.map((absPath) => {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large (${stat.size} bytes): ${absPath}`);
      }
      const mime = payload.images.find((img) => img.local_path === absPath)?.mime_type;
      return {
        path: absPath,
        name: path.basename(absPath),
        mime: mime || "application/octet-stream",
        size: stat.size,
      };
    });
    const attachmentIndexByPath = new Map(uniquePaths.map((p, i) => [p, i]));

    const imagesForUserscript = payload.images.map((img) => ({
      index: img.index,
      placeholder_src: img.placeholder_src,
      local_path: img.local_path,
      raw_path: img.raw_path,
      kind: img.kind,
      mime_type: img.mime_type,
      attachment_index: attachmentIndexByPath.get(img.local_path),
    }));

    // Optional --cover <path>: append as an extra attachment after the content
    // images. The userscript uploads it separately and references it in the
    // publish body's cover fields.
    let coverAttachmentIndex = null;
    const coverArg = options.cover;
    if (coverArg && coverArg !== true) {
      const coverPath = path.resolve(String(coverArg));
      const stat = fs.statSync(coverPath);
      if (!stat.isFile()) throw new Error(`Cover is not a file: ${coverPath}`);
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(`Cover image too large (${stat.size} bytes): ${coverPath}`);
      }
      const coverMime =
        {
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".png": "image/png",
          ".webp": "image/webp",
          ".gif": "image/gif",
        }[path.extname(coverPath).toLowerCase()] || "application/octet-stream";
      coverAttachmentIndex = attachments.length;
      attachments.push({
        path: coverPath,
        name: path.basename(coverPath),
        mime: coverMime,
        size: stat.size,
      });
    }

    if (options["dry-run"]) {
      // Print the prepared job without contacting the daemon.
      const out = {
        markdown: payload.markdown,
        title: payload.title,
        html_length: payload.html.length,
        image_occurrence_count: payload.image_occurrence_count,
        unique_image_count: payload.unique_image_count,
        cover_attachment_index: coverAttachmentIndex,
        attachments: attachments.map((a) => ({ name: a.name, size: a.size, mime: a.mime })),
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }

    const result = await sendCommand({
      site,
      action: "draft",
      args: {
        title: payload.title,
        html: payload.html,
        images: imagesForUserscript,
        image_occurrence_count: payload.image_occurrence_count,
        unique_image_count: payload.unique_image_count,
        cover_attachment_index: coverAttachmentIndex,
        attachments,
        wait_ms: waitMs,
      },
      timeoutMs: waitMs + 5000,
    });

    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }

    const lines = [];
    lines.push(`Markdown: ${payload.markdown}`);
    lines.push(`标题: ${payload.title}`);
    lines.push(`图片出现次数: ${payload.image_occurrence_count}`);
    lines.push(`唯一图片数: ${result?.unique_image_count ?? payload.unique_image_count}`);
    if (result?.pgc_id) {
      lines.push(`pgc_id: ${result.pgc_id}`);
    }
    if (result?.draft_url) {
      lines.push(`草稿编辑链接: [${result.pgc_id || "draft"}](${result.draft_url})`);
    }
    if (result?.content_length) {
      lines.push(`最终 HTML 长度: ${result.content_length}`);
    }
    if (result?.cover) {
      lines.push(`展示封面: ${result.cover.image_url || "(uploaded)"}`);
    }
    lines.push("未改写原 Markdown");
    process.stdout.write(lines.join("\n") + "\n");
  },
});
