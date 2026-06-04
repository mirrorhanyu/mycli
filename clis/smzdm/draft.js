const fs = require("node:fs");
const path = require("node:path");
const { defineCommand } = require("../../src/registry.js");
const { prepareDraftPayload } = require("./prepare.js");

const DEFAULT_WAIT_MS = 2 * 60 * 1000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

defineCommand({
  site: "smzdm",
  name: "draft",
  description:
    "Prepare a Markdown file and save it as a SMZDM draft via browser-side API calls.",
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
    const checkPreserveCards = options["check-preserve-cards"] === true;

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

    if (options["dry-run"]) {
      const out = {
        markdown: payload.markdown,
        title: payload.title,
        html_length: payload.html.length,
        image_occurrence_count: payload.image_occurrence_count,
        unique_image_count: payload.unique_image_count,
        attachments: attachments.map((a) => ({ name: a.name, size: a.size, mime: a.mime })),
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }

    const result = await sendCommand({
      site,
      action: checkPreserveCards ? "check-preserve-cards" : "draft",
      args: {
        title: payload.title,
        html: payload.html,
        images: imagesForUserscript,
        image_occurrence_count: payload.image_occurrence_count,
        unique_image_count: payload.unique_image_count,
        preserve_cards: options["preserve-cards"] === true || checkPreserveCards,
        check_preserve_cards: checkPreserveCards,
        attachments: checkPreserveCards ? [] : attachments,
        wait_ms: waitMs,
      },
      timeoutMs: waitMs + 10000,
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
    if (result?.existing_card_count !== undefined) {
      lines.push(`当前商品卡片: ${result.existing_card_count}`);
    }
    if (result?.preserved_card_count) {
      lines.push(`保留商品卡片: ${result.preserved_card_count}`);
    }
    if (result?.draft_id) {
      lines.push(`draft_id: ${result.draft_id}`);
    }
    if (result?.draft_url) {
      lines.push(`草稿编辑链接: [${result.draft_id || "draft"}](${result.draft_url})`);
    }
    if (result?.content_length) {
      lines.push(`最终 HTML 长度: ${result.content_length}`);
    }
    lines.push("未改写原 Markdown");
    process.stdout.write(lines.join("\n") + "\n");
  },
});
