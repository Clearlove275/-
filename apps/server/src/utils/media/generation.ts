import { mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { mediaProviders, type Provider } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, MediaModel, MediaReference } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { getMediaProvider, listMediaProviders, loadMediaProviderSource } from "@/utils/media/provider";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";

const maxMediaSize = 100 * 1024 * 1024;
const mediaExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/opus": "opus", "audio/pcm": "pcm",
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageOptions(value: unknown, pattern: RegExp) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 64 && item === item.trim() && pattern.test(item)))] : undefined;
}

export async function listMediaModels(): Promise<MediaModel[]> {
  const installedProviders = await listMediaProviders();
  return installedProviders.flatMap(provider => provider.models.flatMap(model => {
    if (model.type !== "image" && model.type !== "video" && model.type !== "audio") return [];
    const builtIn = (mediaProviders as readonly Provider[]).find(item => item.id === provider.id)?.models.find(item => item.id === model.id);
    return [{
      providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label, type: model.type,
      mode: model.mode, durationResolutionMap: model.durationResolutionMap, audio: model.audio,
      ...(model.type === "audio" ? { voices: model.voices } : {}),
      ...(model.type === "image" ? {
        imageSizes: imageOptions(Array.isArray(model.imageSizes) ? model.imageSizes : builtIn?.imageSizes, /^[^\u0000-\u001f\u007f]+$/),
        imageRatios: imageOptions(Array.isArray(model.imageRatios) ? model.imageRatios : builtIn?.imageRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/),
      } : {}),
    } as MediaModel];
  }));
}

function detectMimeType(bytes: Uint8Array, fallback: string) {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  const text = header.toString("ascii");
  const mimeType = fallback.split(";")[0].trim().toLowerCase();
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(text)) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return "audio/wav";
  if (text.startsWith("fLaC")) return "audio/flac";
  if (text.startsWith("OggS")) return mimeType.startsWith("video/") ? "video/ogg" : mimeType === "audio/opus" ? "audio/opus" : "audio/ogg";
  if (header[0] === 0xff && (header[1]! & 0xf6) === 0xf0) return "audio/aac";
  if (text.startsWith("ID3") || (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0 && (header[1]! & 0x06) !== 0)) return "audio/mpeg";
  if (text.slice(4, 8) === "ftyp") {
    if (/avif|avis/.test(text.slice(8))) return "image/avif";
    if (/^M4[AB] $/.test(text.slice(8, 12)) || mimeType.startsWith("audio/")) return "audio/mp4";
    return text.slice(8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return mimeType.startsWith("audio/") ? "audio/webm" : "video/webm";
  return ({ "image/jpg": "image/jpeg", "audio/mp3": "audio/mpeg", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/x-flac": "audio/flac" } as Record<string, string>)[mimeType] ?? mimeType;
}

type ReferenceMedia = Extract<MediaInput, { type: "base64" }> & { sourcePath: string; width?: number; height?: number };

function readUInt24LE(bytes: Buffer, offset: number) {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) >>> 0;
}

function jpegSize(bytes: Buffer) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && offset + 7 <= bytes.length) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    offset += length;
  }
}

function webpSize(bytes: Buffer) {
  if (bytes.length < 25) return;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: readUInt24LE(bytes, 24) + 1, height: readUInt24LE(bytes, 27) + 1 };
  if (chunk === "VP8 " && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
}

function imageSize(bytes: Buffer, mimeType: string) {
  if (mimeType === "image/png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mimeType === "image/jpeg") return jpegSize(bytes);
  if (mimeType === "image/gif" && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (mimeType === "image/bmp" && bytes.length >= 26) return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
  if (mimeType === "image/webp") return webpSize(bytes);
}

function suggestedSize(image: ReferenceMedia & { width: number; height: number }) {
  const targetHeight = Math.min(6000, Math.max(300, image.height));
  if (targetHeight === image.height) return "";
  const scale = targetHeight / image.height;
  return "，建议调整为约 " + Math.max(1, Math.round(image.width * scale)) + "×" + targetHeight + "px";
}

function enrichImageHeightError(error: unknown, references: (ReferenceMedia | undefined)[], modelLabel: string) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!/(?:素材|图片|图像)?\s*高度.*?(?:300|3\s*00).*?(?:6000|6\s*000)|height.*300.*6000/i.test(message)) return error;
  const details = [...new Map(references.filter((item): item is ReferenceMedia & { width: number; height: number } =>
    !!item?.width && !!item.height && (item.height < 300 || item.height > 6000)).map(item => [item.sourcePath, item])).values()];
  const lines = details.length
    ? details.map(item => "- " + item.sourcePath + "：" + item.width + "×" + item.height + "px" + suggestedSize(item))
    : ["- 未能读取参考图尺寸，请检查图片格式，并确保高度在 300–6000px 范围内。"];
  const enriched = new Error(
    message + "\n模型：" + modelLabel + "\n涉及参考图：\n" + lines.join("\n") + "\n处理建议：保持原宽高比调整图片高度后重新生成。",
    error instanceof Error ? { cause: error } : undefined,
  );
  if (error && typeof error === "object" && "status" in error) Object.assign(enriched, { status: (error as { status?: number }).status });
  return enriched;
}

export async function readReference(cwd: string, reference: MediaReference, mediaType: string, signal?: AbortSignal): Promise<ReferenceMedia> {
  signal?.throwIfAborted();
  const { path } = await resolveWorkspacePath(cwd, reference.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxMediaSize) invalid("参考媒体须为不超过 100 MB 的文件");
  const bytes = await readFile(path, { signal });
  if (!bytes.length || bytes.length > maxMediaSize) invalid("参考媒体为空或超过 100 MB");
  const mimeType = detectMimeType(bytes, reference.mimeType);
  if (!mimeType.startsWith(`${mediaType}/`)) invalid(`参考媒体类型须为 ${mediaType}`);
  const size = mediaType === "image" ? imageSize(bytes, mimeType) : undefined;
  return { type: "base64", data: bytes.toString("base64"), mimeType, sourcePath: reference.path, ...(size ?? {}) };
}

async function downloadAsset(url: string, signal?: AbortSignal) {
  if (!/^https?:\/\//i.test(url)) invalid("生成结果必须使用 HTTP 或 HTTPS 地址");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`下载生成结果失败（HTTP ${response.status}）`);
  if (Number(response.headers.get("content-length")) > maxMediaSize) {
    await response.body?.cancel();
    invalid("生成文件不能超过 100 MB");
  }
  const reader = response.body?.getReader();
  if (!reader) invalid("生成结果为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxMediaSize) invalid("生成文件不能超过 100 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { bytes: Buffer.concat(chunks, size), mimeType: response.headers.get("content-type") ?? "" };
}

async function assetBytes(asset: MediaAsset, mediaType: "image" | "video" | "audio", signal?: AbortSignal) {
  if (!asset || asset.mediaType !== mediaType) invalid("供应商返回的媒体类型不正确");
  let bytes: Uint8Array;
  let mimeType = asset.mimeType ?? "";
  if (asset.type === "url") {
    const result = await downloadAsset(asset.url, signal);
    bytes = result.bytes;
    mimeType = result.mimeType || mimeType;
  } else if (asset.type === "base64") {
    const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(asset.data);
    const content = (data?.[2] ?? asset.data).replace(/\s/g, "");
    if (content.length > Math.ceil(maxMediaSize / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(content) || content.length % 4 === 1) invalid("生成结果的 base64 内容无效或超过 100 MB");
    bytes = Buffer.from(content, "base64");
    mimeType = data?.[1] ?? mimeType;
  } else if (asset.type === "binary" && ArrayBuffer.isView(asset.data) && asset.data.BYTES_PER_ELEMENT === 1) {
    bytes = asset.data;
  } else { return invalid("供应商返回了无效的媒体结果"); }
  if (!bytes.byteLength || bytes.byteLength > maxMediaSize) invalid("生成文件为空或超过 100 MB");
  mimeType = detectMimeType(bytes, mimeType);
  if (!mimeType.startsWith(`${mediaType}/`) || !mediaExtensions[mimeType]) invalid("生成结果不是支持的图片、视频或音频格式");
  return { bytes, mimeType };
}

export async function generateMedia(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  if (!request.prompt.trim()) invalid("请输入生成提示词");
  const directory = await realpath(cwd);
  const outputDirectory = request.outputDirectory ?? "assets/generated";
  await resolveWorkspacePath(directory, outputDirectory, true);
  const providerInfo = await getMediaProvider(request.providerId);
  const model = providerInfo.models.find(model => model.id === request.modelId && model.type === mediaType);
  if (!model) invalid("所选媒体模型不存在或类型不匹配，请重新选择");
  const configurations = record(conf.get("settings", {}).mediaProviderConfigs);
  const provider = await loadMediaProviderSource(providerInfo.source, record(configurations[providerInfo.id]), signal, undefined, directory);
  const generate = mediaType === "image" ? provider.generateImage : mediaType === "video" ? provider.generateVideo : provider.generateAudio;
  if (typeof generate !== "function") invalid(`此供应商不支持${{ image: "图片", video: "视频", audio: "音频" }[mediaType]}生成`);
  const rules = Array.isArray(provider.rules) ? provider.rules : [];
  if (rules.some(rule => rule.field === "apiKey") && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) invalid("请先在媒体模型设置中配置供应商 API Key");
  const references = async (items: MediaReference[] | undefined, type: string) => items ? Promise.all(items.map(item => readReference(directory, item, type, signal))) : undefined;
  const images = await references(request.images, "image");
  const videos = mediaType === "video" ? await references(request.videos, "video") : undefined;
  const audios = mediaType === "image" ? undefined : await references(request.audios, "audio");
  const firstFrame = mediaType === "video" && request.firstFrame ? await readReference(directory, request.firstFrame, "image", signal) : undefined;
  const lastFrame = mediaType === "video" && request.lastFrame ? await readReference(directory, request.lastFrame, "image", signal) : undefined;
  signal?.throwIfAborted();
  let assets;
  try {
    assets = mediaType === "audio"
      ? await provider.generateAudio!({
        model: request.modelId, text: request.prompt, audios,
        voice: request.voice, speed: request.speed, volume: request.volume, format: request.format, sampleRate: request.sampleRate,
      })
      : mediaType === "image"
      ? await provider.generateImage!({ model: request.modelId, prompt: request.prompt, images, ratio: request.ratio, size: request.size })
      : await provider.generateVideo!({
        model: request.modelId, prompt: request.prompt, images,
        videos, audios, firstFrame, lastFrame,
        ratio: request.ratio, resolution: request.resolution, duration: request.duration,
        generateAudio: request.generateAudio, mode: request.mode,
      });
  } catch (error) {
    throw enrichImageHeightError(error, [...(images ?? []), firstFrame, lastFrame], `${providerInfo.label} / ${model.label}`);
  }
  if (!Array.isArray(assets) || !assets.length) invalid("供应商未返回生成结果");
  const written: string[] = [];
  const result: GeneratedMedia[] = [];
  try {
    for (const asset of assets) {
      signal?.throwIfAborted();
      const { bytes, mimeType } = await assetBytes(asset, mediaType, signal);
      signal?.throwIfAborted();
      const output = await resolveWorkspacePath(directory, outputDirectory, true);
      const release = lockWorkspaceFiles([output.path]);
      try {
        await mkdir(output.path, { recursive: true });
        const file = join(outputDirectory, `${mediaType}${crypto.randomUUID()}.${mediaExtensions[mimeType]}`);
        const { path } = await resolveWorkspacePath(directory, file);
        signal?.throwIfAborted();
        await writeWorkspaceFile(path, bytes, true);
        written.push(path);
        result.push({ path: relative(directory, path).replace(/\\/g, "/"), mimeType, mediaType });
      } finally { release(); }
    }
    signal?.throwIfAborted();
    return result;
  } catch (err) {
    // ACT: 只回滚本次创建的文件，保留目录中已有的节点资源。
    await Promise.all(written.map(path => unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
    throw err;
  }
}
