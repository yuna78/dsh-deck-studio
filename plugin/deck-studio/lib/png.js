/**
 * 最小 PNG 编解码 + 缩放 + 叠加（F-125 水印用）。
 *
 * 为什么自己写：插件对外承诺「零第三方依赖」，而出图产物是 PNG（real renderer 写
 * image.png）。水印只需要：读 PNG → 解码成 RGBA → 把 logo 缩放到目标尺寸 → alpha 叠加
 * → 再编码回 PNG。用 node 内置 zlib 足够，不引 sharp / canvas。
 *
 * 支持范围（够用且明确报错，不静默出错）：
 * - 解码：8 bit、非隔行；colorType 0/2/3/4/6（灰度 / RGB / 调色板 / 灰度+alpha / RGBA），
 *   调色板带 tRNS 透明度；不支持 16 bit / Adam7 / APNG。
 * - 编码：RGBA（colorType 6）+ filter 0。
 *
 * @module dsh-plugin-deck-studio/png
 */

import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 解码 PNG → { width, height, data: Uint8Array RGBA }。
 * 不认识的就抛错（调用方决定是否跳过该页），不返回半成品。
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("不是 PNG 文件");
  }
  let offset = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      transparency = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!header) throw new Error("PNG 缺 IHDR");
  if (header.bitDepth !== 8) throw new Error(`暂不支持 ${header.bitDepth} bit PNG（水印需要 8 bit）`);
  if (header.interlace !== 0) throw new Error("暂不支持隔行（Adam7）PNG");
  if (header.compression !== 0 || header.filter !== 0) throw new Error("PNG 压缩 / 过滤方式不支持");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (!channels) throw new Error(`暂不支持 PNG colorType=${header.colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const bpp = channels;
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  if (raw.length < stride * height) throw new Error("PNG 像素数据不完整");
  const pixels = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(rowBytes);
  const line = new Uint8Array(rowBytes);
  const paletteEntries = palette
    ? Array.from({ length: Math.floor(palette.length / 3) }, (_, index) => [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2], transparency?.[index] ?? 255])
    : null;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * stride];
    const srcRow = raw.subarray(y * stride + 1, y * stride + 1 + rowBytes);
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bpp ? line[x - bpp] : 0;
      const up = prev[x];
      const upLeft = x >= bpp ? prev[x - bpp] : 0;
      let value = srcRow[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`PNG 行过滤类型不支持：${filter}`);
      line[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      const index = x * bpp;
      if (header.colorType === 6) {
        pixels[target] = line[index];
        pixels[target + 1] = line[index + 1];
        pixels[target + 2] = line[index + 2];
        pixels[target + 3] = line[index + 3];
      } else if (header.colorType === 2) {
        pixels[target] = line[index];
        pixels[target + 1] = line[index + 1];
        pixels[target + 2] = line[index + 2];
        pixels[target + 3] = 255;
      } else if (header.colorType === 0) {
        pixels[target] = pixels[target + 1] = pixels[target + 2] = line[index];
        pixels[target + 3] = 255;
      } else if (header.colorType === 4) {
        pixels[target] = pixels[target + 1] = pixels[target + 2] = line[index];
        pixels[target + 3] = line[index + 1];
      } else if (header.colorType === 3) {
        if (!paletteEntries) throw new Error("调色板 PNG 缺 PLTE");
        const entry = paletteEntries[line[index]] ?? [0, 0, 0, 255];
        pixels[target] = entry[0];
        pixels[target + 1] = entry[1];
        pixels[target + 2] = entry[2];
        pixels[target + 3] = entry[3];
      }
    }
    prev.set(line);
  }
  return { width, height, data: pixels };
}

/** 编码 RGBA（Uint8Array/Uint8ClampedArray）→ PNG Buffer。 */
export function encodePng({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("PNG 尺寸非法");
  if (data.length !== width * height * 4) throw new Error("RGBA 数据长度与尺寸不匹配");
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter 0
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bitDepth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 面积平均缩放（预乘 alpha，避免透明边缘发黑）。
 * 放大用双线性近似（直接按最近邻会更脆；面积法放大同样可用）。
 */
export function resizeRgba(image, targetWidth, targetHeight) {
  const { width, height, data } = image;
  if (targetWidth === width && targetHeight === height) return { width, height, data: Uint8Array.from(data) };
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  const scaleX = width / targetWidth;
  const scaleY = height / targetHeight;
  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((x + 1) * scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * width + sx) * 4;
          const alpha = data[index + 3] / 255;
          r += data[index] * alpha;
          g += data[index + 1] * alpha;
          b += data[index + 2] * alpha;
          a += alpha;
          count += 1;
        }
      }
      const target = (y * targetWidth + x) * 4;
      if (a > 0) {
        out[target] = Math.round(r / a);
        out[target + 1] = Math.round(g / a);
        out[target + 2] = Math.round(b / a);
      }
      out[target + 3] = Math.round((a / count) * 255);
    }
  }
  return { width: targetWidth, height: targetHeight, data: out };
}

/**
 * 把 logo 叠加到页面图上（原地生成新 buffer）。
 * position：top-right / top-left / bottom-right / bottom-left / center；margin/scale 都是页面宽度的比例。
 */
export function compositeLogo({ page, logo, position = "top-right", opacity = 0.85, scale = 0.14, margin = 0.04 }) {
  const pageWidth = page.width;
  const pageHeight = page.height;
  const logoWidth = Math.max(8, Math.round(pageWidth * Math.min(Math.max(scale, 0.02), 0.5)));
  const logoHeight = Math.max(4, Math.round((logo.height / logo.width) * logoWidth));
  const scaled = resizeRgba(logo, logoWidth, logoHeight);
  const gap = Math.round(pageWidth * Math.min(Math.max(margin, 0), 0.2));
  const positions = {
    "top-right": [pageWidth - logoWidth - gap, gap],
    "top-left": [gap, gap],
    "bottom-right": [pageWidth - logoWidth - gap, pageHeight - logoHeight - gap],
    "bottom-left": [gap, pageHeight - logoHeight - gap],
    center: [Math.round((pageWidth - logoWidth) / 2), Math.round((pageHeight - logoHeight) / 2)],
  };
  const [originX, originY] = positions[position] ?? positions["top-right"];
  const alphaScale = Math.min(Math.max(Number(opacity) || 0, 0), 1);
  const out = Uint8Array.from(page.data);
  for (let y = 0; y < logoHeight; y += 1) {
    const pageY = originY + y;
    if (pageY < 0 || pageY >= pageHeight) continue;
    for (let x = 0; x < logoWidth; x += 1) {
      const pageX = originX + x;
      if (pageX < 0 || pageX >= pageWidth) continue;
      const src = (y * logoWidth + x) * 4;
      const srcAlpha = (scaled.data[src + 3] / 255) * alphaScale;
      if (srcAlpha <= 0) continue;
      const dst = (pageY * pageWidth + pageX) * 4;
      out[dst] = Math.round(scaled.data[src] * srcAlpha + out[dst] * (1 - srcAlpha));
      out[dst + 1] = Math.round(scaled.data[src + 1] * srcAlpha + out[dst + 1] * (1 - srcAlpha));
      out[dst + 2] = Math.round(scaled.data[src + 2] * srcAlpha + out[dst + 2] * (1 - srcAlpha));
      out[dst + 3] = 255;
    }
  }
  return {
    image: { width: pageWidth, height: pageHeight, data: out },
    placement: { position, originX, originY, logoWidth, logoHeight, opacity: alphaScale, scale },
  };
}

/** 读一张 PNG 文件 → 解码后的图（调用方自己兜异常）。 */
export function readPng(buffer) {
  return decodePng(buffer);
}
