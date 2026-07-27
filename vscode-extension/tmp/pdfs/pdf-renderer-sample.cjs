"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/pdfRenderer.ts
var pdfRenderer_exports = {};
__export(pdfRenderer_exports, {
  renderMarkdownPdf: () => renderMarkdownPdf
});
module.exports = __toCommonJS(pdfRenderer_exports);
var import_node_fs = require("node:fs");
var import_pdfkit = __toESM(require("pdfkit"));
function firstExisting(paths) {
  return paths.find((path) => (0, import_node_fs.existsSync)(path));
}
function systemFonts() {
  if (process.platform === "darwin") {
    return {
      regular: firstExisting([
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf"
      ]),
      bold: firstExisting([
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
      ]),
      mono: firstExisting([
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/System/Library/Fonts/Menlo.ttc"
      ])
    };
  }
  if (process.platform === "win32") {
    return {
      regular: firstExisting(["C:\\Windows\\Fonts\\arial.ttf"]),
      bold: firstExisting(["C:\\Windows\\Fonts\\arialbd.ttf"]),
      mono: firstExisting(["C:\\Windows\\Fonts\\consola.ttf"])
    };
  }
  return {
    regular: firstExisting([
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"
    ]),
    bold: firstExisting([
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
      "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"
    ]),
    mono: firstExisting([
      "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
      "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf"
    ])
  };
}
function plainMarkdown(text) {
  return text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/<[^>]+>/g, "");
}
async function renderMarkdownPdf(markdown, options = {}) {
  const fonts = systemFonts();
  const document = new import_pdfkit.default({
    size: "A4",
    margins: { top: 64, right: 54, bottom: 58, left: 54 },
    bufferPages: true,
    info: {
      Title: options.title ?? "CodeGraph report",
      Author: options.author ?? "CodeGraph for VS Code"
    }
  });
  const chunks = [];
  if (process.env.CODEGRAPH_PDF_DEBUG === "1") {
    document.on("pageAdded", () => {
      console.error(
        `[codegraph-pdf] page added at y=${document.y.toFixed(1)}
${new Error().stack ?? ""}`
      );
    });
  }
  document.on("data", (chunk) => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => {
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  if (fonts.regular) document.registerFont("Body", fonts.regular);
  if (fonts.bold) document.registerFont("Bold", fonts.bold);
  if (fonts.mono) document.registerFont("Mono", fonts.mono);
  const regular = fonts.regular ? "Body" : "Helvetica";
  const bold = fonts.bold ? "Bold" : "Helvetica-Bold";
  const mono = fonts.mono ? "Mono" : "Courier";
  const blue = "#174A7E";
  const teal = "#0E7C7B";
  const ink = "#1E293B";
  const muted = "#64748B";
  const codeBackground = "#F1F5F9";
  let inCode = false;
  let codeLines = [];
  const ensureSpace = (height) => {
    if (document.y + height > document.page.height - 64) {
      document.addPage();
    }
  };
  const drawCode = () => {
    if (codeLines.length === 0) return;
    const text = codeLines.join("\n");
    document.font(mono).fontSize(8.5);
    const height = Math.min(
      360,
      document.heightOfString(text, { width: 466 }) + 18
    );
    ensureSpace(height + 8);
    const y = document.y;
    document.roundedRect(54, y, 487, height, 5).fill(codeBackground);
    document.fillColor(ink).text(text.slice(0, 8e3), 65, y + 9, {
      width: 465,
      height: height - 14
    });
    document.y = y + height + 10;
    codeLines = [];
  };
  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^```/.test(rawLine)) {
      if (inCode) drawCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }
    document.x = 54;
    const heading = /^(#{1,4})\s+(.+)$/.exec(rawLine);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const size = level === 1 ? 23 : level === 2 ? 15 : 11.5;
      ensureSpace(size * 2.4);
      document.moveDown(level === 1 ? 0.15 : 0.55).font(bold).fontSize(size).fillColor(level === 1 ? blue : teal).text(plainMarkdown(heading[2] ?? ""), {
        lineGap: level === 1 ? 4 : 2
      });
      if (level === 1) {
        document.moveDown(0.25).strokeColor("#B8D8E8").lineWidth(1).moveTo(54, document.y).lineTo(541, document.y).stroke();
      }
      continue;
    }
    if (/^\|.+\|$/.test(rawLine)) {
      if (/^\|[\s:|-]+\|$/.test(rawLine)) continue;
      const cells = rawLine.slice(1, -1).split("|").map((cell) => plainMarkdown(cell.trim()));
      ensureSpace(24);
      const columnWidth = 487 / Math.max(1, cells.length);
      const y = document.y;
      document.rect(54, y, 487, 21).fill("#E8F2F7");
      cells.forEach((cell, index) => {
        document.font(regular).fontSize(8.5).fillColor(ink).text(cell, 60 + index * columnWidth, y + 6, {
          width: columnWidth - 10,
          height: 12,
          ellipsis: true
        });
      });
      document.y = y + 23;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(rawLine);
    if (bullet) {
      ensureSpace(24);
      document.font(regular).fontSize(10).fillColor(ink).text(`\u2022  ${plainMarkdown(bullet[1] ?? "")}`, 66, document.y, {
        width: 463,
        lineGap: 2
      });
      continue;
    }
    if (/^>\s?/.test(rawLine)) {
      ensureSpace(38);
      const note = plainMarkdown(rawLine.replace(/^>\s?/, ""));
      const y = document.y;
      document.rect(54, y, 4, 28).fill(teal);
      document.font(regular).fontSize(9.5).fillColor(muted).text(note, 66, y + 2, { width: 463, lineGap: 2 });
      document.moveDown(0.5);
      continue;
    }
    if (rawLine.trim() === "") {
      document.moveDown(0.35);
      continue;
    }
    ensureSpace(26);
    document.font(regular).fontSize(10.2).fillColor(ink).text(plainMarkdown(rawLine), { width: 487, lineGap: 2.5 });
  }
  if (inCode) drawCode();
  const range = document.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);
    const footerY = document.page.height - 76;
    document.font(regular).fontSize(8).fillColor(muted).text(
      `CodeGraph \u2022 ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`,
      54,
      footerY,
      { width: 390, align: "left", lineBreak: false }
    ).text(
      `${index - range.start + 1} / ${range.count}`,
      444,
      footerY,
      { width: 97, align: "right", lineBreak: false }
    );
  }
  document.end();
  return complete;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  renderMarkdownPdf
});
