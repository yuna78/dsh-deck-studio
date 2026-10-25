/**
 * Deck 导出：PPTX（每页一张整页图）与 PDF（每页一张整页图）。
 *
 * 零第三方依赖：
 *   - PPTX = OOXML zip（deflate + PNG/JPEG 直接嵌入），16:9 13.333×7.5in；
 *   - PDF = 每页一张 JPEG（DCTDecode），页面尺寸按图片比例；
 *   - PNG → JPEG 用 macOS `sips`（本地工具；找不到时 PDF 导出会报清晰错误）。
 *
 * 导出是「整页图」的拼装，不做文字重排——与 image deck 的 renderer 契约一致。
 * @module dsh-plugin-deck-studio/exporter
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";

/* ------------------------------------------------------------------ *
 * zip（PPTX 容器）
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 内存 zip：entries [{name, data:Buffer|string, store?:boolean}] */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const deflated = entry.store ? null : deflateRawSync(raw);
    const useDeflate = deflated && deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/* ------------------------------------------------------------------ *
 * PPTX
 * ------------------------------------------------------------------ */

const EMU_W = 12192000;
const EMU_H = 6858000;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = {
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  slide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
  slideLayout: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
  slideMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
  theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
  image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
};

const relsXml = (rels) =>
  `${XML_HEAD}<Relationships xmlns="${REL_NS}">${rels
    .map((rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}"/>`)
    .join("")}</Relationships>`;

const emptySpTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>`;

const themeXml = `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Deck Studio"><a:themeElements>
<a:clrScheme name="Deck Studio"><a:dk1><a:srgbClr val="0C4651"/></a:dk1><a:lt1><a:srgbClr val="FAF8F2"/></a:lt1><a:dk2><a:srgbClr val="0F6975"/></a:dk2><a:lt2><a:srgbClr val="F1EDE2"/></a:lt2><a:accent1><a:srgbClr val="1496A8"/></a:accent1><a:accent2><a:srgbClr val="C5882F"/></a:accent2><a:accent3><a:srgbClr val="7FA3A8"/></a:accent3><a:accent4><a:srgbClr val="B4462F"/></a:accent4><a:accent5><a:srgbClr val="5E7F86"/></a:accent5><a:accent6><a:srgbClr val="D9D2C2"/></a:accent6><a:hlink><a:srgbClr val="1496A8"/></a:hlink><a:folHlink><a:srgbClr val="C5882F"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Deck Studio"><a:majorFont><a:latin typeface="Helvetica"/><a:ea typeface="PingFang SC"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Helvetica"/><a:ea typeface="PingFang SC"/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Deck Studio"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;

/**
 * 生成 PPTX。
 * @param {{file: string}[]} slides 按页序
 * @returns {Buffer}
 */
/**
 * 单页 PPTX slide XML：整页图以一个铺满画布的 <p:pic> 放进 spTree。
 * 导出 blank 回归根因（F-98）：旧实现用 emptySpTree.replace("</p:grpSpPr>", …)，
 * 而 emptySpTree 里是自闭合的 <p:grpSpPr/>，替换永远不命中 → 每页 spTree 为空，
 * PPT 打开全是空白（图片却在包里）。现在直接拼完整 spTree，并有 smoke 断言。
 */
export function pptxSlideXml(number) {
  return `${XML_HEAD}<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="page ${number}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU_W}" cy="${EMU_H}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

export function buildPptx(slides) {
  if (!slides?.length) throw new Error("没有可导出的页（至少需要 1 页图片）");
  const entries = [];
  const slideCount = slides.length;
  const contentTypes = [
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Default Extension="jpg" ContentType="image/jpeg"/>',
    '<Default Extension="jpeg" ContentType="image/jpeg"/>',
    '<Default Extension="webp" ContentType="image/png"/>',
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    ...slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`),
    "</Types>",
  ].join("");

  entries.push({ name: "[Content_Types].xml", data: contentTypes });
  entries.push({
    name: "_rels/.rels",
    data: relsXml([{ id: "rId1", type: REL_TYPE.officeDocument, target: "ppt/presentation.xml" }]),
  });

  const presentationRels = [
    { id: "rId1", type: REL_TYPE.slideMaster, target: "slideMasters/slideMaster1.xml" },
    ...slides.map((_, index) => ({ id: `rId${index + 2}`, type: REL_TYPE.slide, target: `slides/slide${index + 1}.xml` })),
  ];
  const presentation = `${XML_HEAD}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`)
    .join("")}</p:sldIdLst><p:sldSz cx="${EMU_W}" cy="${EMU_H}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  entries.push({ name: "ppt/presentation.xml", data: presentation });
  entries.push({ name: "ppt/_rels/presentation.xml.rels", data: relsXml(presentationRels) });

  entries.push({
    name: "ppt/slideMasters/slideMaster1.xml",
    data: `${XML_HEAD}<p:sldMaster ${NS}><p:cSld>${emptySpTree}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
  });
  entries.push({
    name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    data: relsXml([
      { id: "rId1", type: REL_TYPE.slideLayout, target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: REL_TYPE.theme, target: "../theme/theme1.xml" },
    ]),
  });
  entries.push({
    name: "ppt/slideLayouts/slideLayout1.xml",
    data: `${XML_HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${emptySpTree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  });
  entries.push({
    name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    data: relsXml([{ id: "rId1", type: REL_TYPE.slideMaster, target: "../slideMasters/slideMaster1.xml" }]),
  });
  entries.push({ name: "ppt/theme/theme1.xml", data: themeXml });

  slides.forEach((slide, index) => {
    const number = index + 1;
    const ext = extname(slide.file).toLowerCase().replace(".", "") || "png";
    const mediaName = `image${number}.${ext === "jpg" ? "jpeg" : ext}`;
    const rels = [
      { id: "rId1", type: REL_TYPE.slideLayout, target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: REL_TYPE.image, target: `../media/${mediaName}` },
    ];
    const slideXml = pptxSlideXml(number);
    entries.push({ name: `ppt/slides/slide${number}.xml`, data: slideXml });
    entries.push({ name: `ppt/slides/_rels/slide${number}.xml.rels`, data: relsXml(rels) });
    entries.push({ name: `ppt/media/${mediaName}`, data: readFileSync(slide.file), store: true });
  });
  return zip(entries);
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

/** JPEG 尺寸（SOF0/SOF2）。 */
function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return null;
}

/** PNG/JPEG/WEBP → JPEG（macOS sips）。 */
export function toJpeg(file, workDir) {
  const out = join(workDir, `${file.split("/").pop().replace(/[^\w.-]/g, "_")}.jpg`);
  try {
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "88", file, "--out", out], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    throw new Error("PDF 导出需要 macOS `sips` 把整页图转成 JPEG；当前环境不可用。可改导 PPTX。");
  }
  return readFileSync(out);
}

/**
 * 生成 PDF（每页一张整页图，按图片比例铺满）。
 * @param {{file: string}[]} slides
 * @returns {Buffer}
 */
export function buildPdf(slides) {
  if (!slides?.length) throw new Error("没有可导出的页（至少需要 1 页图片）");
  const workDir = mkdtempSync(join(tmpdir(), "deck-pdf-"));
  try {
    const images = slides.map((slide) => {
      const jpeg = toJpeg(slide.file, workDir);
      const size = jpegSize(jpeg) ?? { width: 2560, height: 1440 };
      const pageHeight = 540;
      const pageWidth = Math.round((pageHeight * size.width) / size.height);
      return { jpeg, width: size.width, height: size.height, pageWidth, pageHeight };
    });

    const objects = [];
    const add = (data) => {
      objects.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"));
      return objects.length;
    };
    const catalogId = add("<< /Type /Catalog /Pages 2 0 R >>");
    const pagesId = add(""); // 占位，稍后回填
    const pageIds = [];
    const contentIds = [];
    const imageIds = [];
    for (const image of images) {
      const stream = `q\n${image.pageWidth} 0 0 ${image.pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
      contentIds.push(add(Buffer.concat([Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n`), Buffer.from(stream), Buffer.from("endstream")])));
      imageIds.push(
        add(
          Buffer.concat([
            Buffer.from(
              `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`,
            ),
            image.jpeg,
            Buffer.from("\nendstream"),
          ]),
        ),
      );
    }
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      pageIds.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${image.pageWidth} ${image.pageHeight}] /Resources << /XObject << /Im0 ${imageIds[index]} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
        ),
      );
    }
    objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);

    const chunks = [Buffer.from("%PDF-1.5\n%\u00e2\u00e3\u00cf\u00d3\n", "latin1")];
    const offsets = [];
    let position = chunks[0].length;
    objects.forEach((body, index) => {
      offsets.push(position);
      const head = Buffer.from(`${index + 1} 0 obj\n`, "utf8");
      const tail = Buffer.from("\nendobj\n", "utf8");
      chunks.push(head, body, tail);
      position += head.length + body.length + tail.length;
    });
    const xrefStart = position;
    const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
    for (const offset of offsets) xref.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
    chunks.push(Buffer.from(xref.join(""), "utf8"));
    chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`, "utf8"));
    return Buffer.concat(chunks);
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响导出 */
    }
  }
}

/** 导出入口。 */
export function exportDeck({ format, slides }) {
  if (format === "pptx") return { buffer: buildPptx(slides), ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  if (format === "pdf") return { buffer: buildPdf(slides), ext: "pdf", mime: "application/pdf" };
  throw new Error(`不支持的导出格式：${format}（只支持 pdf / pptx）`);
}

export { jpegSize, deflateSync, existsSync };
