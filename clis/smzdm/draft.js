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
    const checkProductCards =
      options["check-product-cards"] === true ||
      options["check-preserve-cards"] === true;
    const generateProductCards =
      options["no-product-cards"] !== true &&
      options["product-cards"] !== "false";

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
        product_link_count: payload.product_link_count,
        product_links: payload.product_links,
        attachments: attachments.map((a) => ({ name: a.name, size: a.size, mime: a.mime })),
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }

    const result = await sendCommand({
      site,
      action: checkProductCards ? "check-product-cards" : "draft",
      args: {
        title: payload.title,
        html: payload.html,
        images: imagesForUserscript,
        product_links: payload.product_links,
        image_occurrence_count: payload.image_occurrence_count,
        unique_image_count: payload.unique_image_count,
        generate_product_cards: generateProductCards,
        check_product_cards: checkProductCards,
        attachments: checkProductCards ? [] : attachments,
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
    lines.push(`京东商品链接: ${payload.product_link_count}`);
    if (result?.generated_product_card_count !== undefined) {
      lines.push(`新建商品卡片: ${result.generated_product_card_count}`);
    }
    if (result?.reused_product_card_count) {
      lines.push(`复用现有商品卡片: ${result.reused_product_card_count}`);
    }
    if (result?.inserted_product_card_count !== undefined) {
      lines.push(`插入商品卡片: ${result.inserted_product_card_count}`);
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
