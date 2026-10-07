type ImageHeightRequest = {
  model: string;
  images?: MediaInput[];
  mask?: MediaInput;
  firstFrame?: MediaInput;
  lastFrame?: MediaInput;
};

function imageBytes(input: MediaInput) {
  if (input.type === "base64") return Buffer.from(input.data.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (input.type === "binary") return Buffer.from(input.data);
}

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

function imageSize(input: MediaInput) {
  const bytes = imageBytes(input);
  if (!bytes) return;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegSize(bytes);
  if (/^GIF8[79]a/.test(bytes.toString("ascii", 0, 6)) && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.toString("ascii", 0, 2) === "BM" && bytes.length >= 26) return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return webpSize(bytes);
}

function suggestedImageSize(image: { width: number; height: number }) {
  const targetHeight = Math.min(6000, Math.max(300, image.height));
  const scale = targetHeight / image.height;
  return Math.max(1, Math.round(image.width * scale)) + "×" + targetHeight + "px";
}

export function withImageHeightContext(message: string, request: ImageHeightRequest, providerLabel: string) {
  if (!/(?:素材|图片|图像)?\s*高度.*?(?:300|3\s*00).*?(?:6000|6\s*000)|height.*300.*6000/i.test(message)) return message;
  const entries: { label: string; input: MediaInput }[] = [
    ...(request.images ?? []).map((input, index) => ({ label: input.name || `参考图 ${index + 1}`, input })),
    ...(request.mask ? [{ label: request.mask.name || "蒙版", input: request.mask }] : []),
    ...(request.firstFrame ? [{ label: request.firstFrame.name || "首帧", input: request.firstFrame }] : []),
    ...(request.lastFrame ? [{ label: request.lastFrame.name || "尾帧", input: request.lastFrame }] : []),
  ];
  const issues = entries.flatMap(({ label, input }) => {
    const size = imageSize(input);
    return size && (size.height < 300 || size.height > 6000) ? [{ label, ...size }] : [];
  });
  const lines = issues.length
    ? issues.map(item => "- " + item.label + "：" + item.width + "×" + item.height + "px，建议调整为约 " + suggestedImageSize(item))
    : ["- 未能读取参考图尺寸，请检查图片格式，并确保高度在 300–6000px 范围内。"];
  return message + "\n供应商：" + providerLabel + "\n模型：" + request.model + "\n涉及素材：\n" + lines.join("\n") + "\n处理建议：保持原宽高比调整图片高度后重新生成。";
}
