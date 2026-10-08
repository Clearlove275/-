import axios from "axios";

export const isDesktopClipboard = new URLSearchParams(window.location.search).get("desktop") === "1";
const headers = { "x-toonflow-desktop": "1" };

export async function readClipboardText(): Promise<string> {
  if (!isDesktopClipboard) return navigator.clipboard.readText();
  const { data } = await axios.post<{ code: number; data: { text: string }; message: string }>("/api/desktop/clipboard/read", {}, { headers });
  if (data.code !== 200) throw new Error(data.message || "读取剪贴板失败");
  return data.data.text;
}

export async function readClipboardImage(): Promise<Blob | null> {
  if (isDesktopClipboard) {
    const { data } = await axios.post<{ code: number; data: { image: string | null }; message: string }>("/api/desktop/clipboard/read", { format: "image" }, { headers });
    if (data.code !== 200) throw new Error(data.message || "读取剪贴板图片失败");
    if (!data.data.image) return null;
    const binary = atob(data.data.image);
    return new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], { type: "image/png" });
  }
  if (!navigator.clipboard?.read) throw new Error("当前环境不支持读取剪贴板图片");
  for (const item of await navigator.clipboard.read()) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (imageType) return item.getType(imageType);
  }
  return null;
}

function clipboardFile(type: string, base64: string, name: string) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new File([bytes], name, { type });
}

export async function readClipboardFiles(): Promise<File[]> {
  if (isDesktopClipboard) {
    const { data } = await axios.post<{ code: number; data: { files: { name: string; mimeType: string; data: string }[] }; message: string }>(
      "/api/desktop/clipboard/read",
      { format: "files" },
      { headers }
    );
    if (data.code !== 200) throw new Error(data.message || "读取剪贴板文件失败");
    return data.data.files.map(file => clipboardFile(file.mimeType, file.data, file.name));
  }
  if (!navigator.clipboard?.read) throw new Error("当前环境不支持读取剪贴板文件");
  const files: File[] = [];
  for (const item of await navigator.clipboard.read()) {
    for (const type of item.types.filter(type => /^(image|audio|video)\//.test(type))) {
      const extension = type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
      files.push(new File([await item.getType(type)], "pasted-media-" + (files.length + 1) + "." + extension, { type }));
    }
  }
  return files;
}

export async function writeClipboardText(text: string): Promise<void> {
  if (!isDesktopClipboard) return navigator.clipboard.writeText(text);
  const { data } = await axios.post<{ code: number; message: string }>("/api/desktop/clipboard/write", { text }, { headers });
  if (data.code !== 200) throw new Error(data.message || "写入剪贴板失败");
}
