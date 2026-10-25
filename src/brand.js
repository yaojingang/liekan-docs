import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const defaultBrandCaption = "DOCUMENT WORKSPACE";
export const maxLogoBytes = 2 * 1024 * 1024;
const logoTypes = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export function isPublicUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (!(value.startsWith("/") && !value.startsWith("//") || /^https?:\/\//i.test(value))) return false;
  try {
    const url = new URL(value, "http://document.local");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export function validateBrandSettings(settings) {
  const result = {};
  const fail = (error, field) => { throw Object.assign(new Error(error), { code: "BRAND_INVALID", field }); };
  if (Object.hasOwn(settings, "publicLogoUrl")) {
    if (typeof settings.publicLogoUrl !== "string") fail("LOGO 图片地址无效", "publicLogoUrlInput");
    const url = settings.publicLogoUrl.trim();
    if (url && !isPublicUrl(url)) fail("LOGO 图片需填写站内路径或 HTTP/HTTPS 地址", "publicLogoUrlInput");
    result.publicLogoUrl = url;
  }
  if (Object.hasOwn(settings, "publicBrandCaption")) {
    if (typeof settings.publicBrandCaption !== "string" || [...settings.publicBrandCaption.trim()].length > 80)
      fail("LOGO 副标题最多填写 80 个字符", "publicBrandCaptionInput");
    result.publicBrandCaption = settings.publicBrandCaption.trim();
  }
  return result;
}

function logoExtension(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return "png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return "jpg";
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) return "webp";
  return null;
}

export async function storeLogo(config, bytes) {
  if (bytes.length > maxLogoBytes) throw Object.assign(new Error("LOGO 图片最大为 2 MiB"), { code: "BRAND_INVALID", statusCode: 413 });
  const extension = logoExtension(bytes);
  if (!extension) throw Object.assign(new Error("请上传 PNG、JPG 或 WebP 图片"), { code: "BRAND_INVALID", statusCode: 400 });
  const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const fileName = `logo-${hash}.${extension}`;
  const directory = path.join(config.dataDir, "brand");
  await fs.mkdir(directory, { recursive: true });
  const pending = path.join(directory, `.logo-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(pending, bytes, { flag: "wx" });
    await fs.rename(pending, path.join(directory, fileName));
  } finally { await fs.rm(pending, { force: true }); }
  return `/public/brand/${fileName}`;
}

export async function readLogo(config, fileName) {
  const match = /^logo-[a-f0-9]{32}\.(png|jpg|webp)$/.exec(fileName);
  if (!match) return null;
  try {
    return { bytes: await fs.readFile(path.join(config.dataDir, "brand", fileName)), type: logoTypes[match[1]] };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
