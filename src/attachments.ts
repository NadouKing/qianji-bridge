import { createHash } from "node:crypto";
import sharp from "sharp";
import { AppError } from "./errors.ts";
import type { QianjiFetch } from "./qianji-client.ts";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 24_000_000;
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export async function imageIdentity(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new AppError("INVALID_IMAGE_SIZE", "图片大小必须为 1 至 8 MiB");
  try {
    const input = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" });
    const metadata = await input.metadata();
    if (!["png", "jpeg"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) throw new Error();
    const { data, info } = await input.rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { mime: metadata.format === "png" ? "image/png" : "image/jpeg", width: info.width, height: info.height,
      sha256: sha256(bytes), pixels: sha256(data) };
  } catch { throw new AppError("INVALID_IMAGE", "仅支持可完整解码的单帧 PNG 或 JPEG，最多 2400 万像素"); }
}

export function decodeImageBase64(encoded: string): Buffer {
  if (!encoded.length || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new AppError("INVALID_IMAGE_BASE64", "图片必须为不含 data URL 前缀的标准 Base64，最多 8 MiB");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new AppError("INVALID_IMAGE_BASE64", "Base64 编码无效");
  return bytes;
}

/** Qiniu content ETag, including the multi-block case; not an MD5. */
export function imageEtag(bytes: Buffer): string {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) parts.push(createHash("sha1").update(bytes.subarray(offset, offset + 4 * 1024 * 1024)).digest());
  if (!parts.length) parts.push(createHash("sha1").update("").digest());
  return Buffer.concat(parts.length === 1 ? [Buffer.from([0x16]), parts[0]!] :
    [Buffer.from([0x96]), createHash("sha1").update(Buffer.concat(parts)).digest()]).toString("base64url");
}

export function imageUploadHost(token: string): string {
  try {
    const policy = JSON.parse(Buffer.from(token.split(":")[2]!, "base64url").toString("utf8"));
    const regions: Record<string, string> = { "up.qiniu.com": "", "upload.qiniu.com": "", "up-z1.qiniu.com": "-z1", "upload-z1.qiniu.com": "-z1", "up-z2.qiniu.com": "-z2", "upload-z2.qiniu.com": "-z2", "up-na0.qiniu.com": "-na0", "upload-na0.qiniu.com": "-na0", "up-as0.qiniu.com": "-as0", "upload-as0.qiniu.com": "-as0" };
    for (const candidate of policy.upHosts) {
      const url = new URL(candidate);
      if (Object.hasOwn(regions, url.hostname) && ["http:", "https:"].includes(url.protocol) && url.pathname === "/" && !url.username && !url.password && !url.port && !url.search && !url.hash) {
        return `https://upload${regions[url.hostname]}.qiniup.com/`;
      }
    }
  } catch { /* Invalid policies never become arbitrary fetch destinations. */ }
  throw new AppError("UPLOAD_HOST_UNSUPPORTED", "上传令牌未提供受支持的存储地址");
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new AppError("IMAGE_HTTP_ERROR", "图片服务未返回成功响应");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new AppError("IMAGE_RESPONSE_TOO_LARGE", "图片服务响应超过大小限制");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function uploadImage(fetch: QianjiFetch, uid: string, bytes: Buffer, token: string) {
  const original = await imageIdentity(bytes);
  const imageKey = sha256(Buffer.from(uid + ":" + original.sha256)).slice(0, 32);
  const form = new FormData();
  form.set("token", token); form.set("key", imageKey);
  form.set("file", new Blob([new Uint8Array(bytes)], { type: original.mime }), "image");
  let receipt: Record<string, unknown>;
  try {
    const response = await fetch(imageUploadHost(token), { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(30_000) });
    receipt = JSON.parse((await boundedBody(response, 100_000)).toString("utf8"));
  } catch { throw new AppError("IMAGE_UPLOAD_UNCERTAIN", "上传结果未确认，请查询原请求，不重发上传"); }
  if (receipt.key !== imageKey || receipt.hash !== imageEtag(bytes)) throw new AppError("IMAGE_UPLOAD_UNCERTAIN", "存储回执与图片内容不符，不重发上传");
  let fileVerified = false, pixelsVerified = false;
  try {
    const response = await fetch(`https://billimg.qianjiapp.com/${imageKey}!huge`, {
      headers: { accept: "image/png,image/jpeg" }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!/^image\/(?:png|jpeg)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error();
    const downloaded = await imageIdentity(await boundedBody(response, MAX_IMAGE_BYTES));
    fileVerified = downloaded.sha256 === original.sha256;
    pixelsVerified = downloaded.width === original.width && downloaded.height === original.height && downloaded.pixels === original.pixels;
  } catch { /* Storage proof and CDN content proof are intentionally separate. */ }
  return { imageKey, sha256: original.sha256, storageVerified: true, fileVerified, pixelsVerified };
}
