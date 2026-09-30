import axios from "axios";
import { computed, ref } from "vue";

type AssetEntry = { name: string; path: string; type: "file" | "directory"; children?: AssetEntry[] };
export type SubjectAsset = { name: string; path: string; kind: "image" | "audio"; mimeType: string };
export type SubjectEntry = { name: string; path: string; cover?: SubjectAsset; images: SubjectAsset[]; voices: SubjectAsset[] };
export type SubjectMention = { id: string; name: string; dataType: "IMAGE" | "AUDIO"; media: { url: string; mimeType: string }; avatar?: string };

const subjectRoot = "subjects";
const imageExtensions: Record<string, string> = { avif: "image/avif", apng: "image/apng", bmp: "image/bmp", gif: "image/gif", ico: "image/x-icon", jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp" };
const audioExtensions: Record<string, string> = { aac: "audio/aac", flac: "audio/flac", m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav" };
export const subjects = ref<SubjectEntry[]>([]);
let loadRequest: Promise<SubjectEntry[]> | undefined;

export function assetUrl(path: string) {
  return `/api/assets/read?path=${encodeURIComponent(path)}`;
}

function getAsset(path: string): SubjectAsset | undefined {
  const name = path.split("/").pop() ?? "";
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (imageExtensions[extension]) return { name, path, kind: "image", mimeType: imageExtensions[extension] };
  if (audioExtensions[extension]) return { name, path, kind: "audio", mimeType: audioExtensions[extension] };
}

function flattenFiles(entries: AssetEntry[]): AssetEntry[] {
  return entries.flatMap(entry => entry.type === "directory" ? flattenFiles(entry.children ?? []) : [entry]);
}

function toSubject(entry: AssetEntry): SubjectEntry {
  const assets = flattenFiles(entry.children ?? []).flatMap(file => {
    const asset = getAsset(file.path);
    return asset ? [asset] : [];
  });
  const images = assets.filter(asset => asset.kind === "image");
  return { name: entry.name, path: entry.path, cover: images[0], images, voices: assets.filter(asset => asset.kind === "audio") };
}

export async function loadSubjects() {
  if (loadRequest) return loadRequest;
  loadRequest = axios.get<{ data: { entries: AssetEntry[] } }>("/api/assets/list").then(({ data }) => {
    const root = data.data.entries.find(entry => entry.type === "directory" && entry.path === subjectRoot);
    subjects.value = (root?.children ?? []).filter(entry => entry.type === "directory").map(toSubject);
    return subjects.value;
  }).finally(() => { loadRequest = undefined; });
  return loadRequest;
}

async function ensureFolder(path: string) {
  await axios.post("/api/assets/mkdir", { path }).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
    if (error.response?.data?.data?.code !== "EEXIST") throw error;
  });
}

function uniqueName(name: string) {
  const normalized = name.replace(/[\\/]/g, "_").trim() || "asset";
  const extension = normalized.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] ?? "";
  const base = normalized.slice(0, normalized.length - extension.length).slice(0, 60) || "asset";
  return `${base}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension.toLowerCase()}`;
}

export async function createSubject(name: string) {
  const subjectName = name.trim();
  if (!subjectName || /[\\/]/.test(subjectName)) throw new Error("主体名称不能为空且不能包含斜杠");
  await ensureFolder(subjectRoot);
  const path = `${subjectRoot}/${subjectName}`;
  await ensureFolder(path);
  await ensureFolder(`${path}/images`);
  await ensureFolder(`${path}/voices`);
  return (await loadSubjects()).find(subject => subject.path === path)!;
}

export async function uploadSubjectFiles(subject: SubjectEntry, kind: "image" | "audio", files: File[]) {
  const folder = kind === "image" ? "images" : "voices";
  await ensureFolder(`${subject.path}/${folder}`);
  for (const file of files) {
    const expected = kind === "image" ? "image/" : "audio/";
    if (!file.type.startsWith(expected)) throw new Error(`${file.name} 不是有效的${kind === "image" ? "图片" : "音频"}`);
    await axios.put("/api/assets/save", file, { params: { path: `${subject.path}/${folder}/${uniqueName(file.name)}` }, headers: { "Content-Type": "application/octet-stream" } });
  }
  await loadSubjects();
}

export async function uploadSubjectContent(subject: SubjectEntry, dataType: "IMAGE" | "AUDIO", content: Blob | ArrayBuffer, name: string, mimeType: string) {
  const file = new File([content], name, { type: mimeType });
  await uploadSubjectFiles(subject, dataType === "IMAGE" ? "image" : "audio", [file]);
}

export async function removeSubjectAsset(path: string) {
  await axios.delete("/api/assets/remove", { data: { path } });
  await loadSubjects();
}

export async function removeSubject(subject: SubjectEntry) {
  await axios.delete("/api/assets/remove", { data: { path: subject.path, recursive: true } });
  await loadSubjects();
}

export async function renameSubject(subject: SubjectEntry, name: string) {
  const target = name.trim();
  if (!target || /[\\/]/.test(target)) throw new Error("主体名称不能为空且不能包含斜杠");
  await axios.post("/api/assets/rename", { path: subject.path, target: `${subjectRoot}/${target}` });
  await loadSubjects();
}

export const subjectMentions = computed<SubjectMention[]>(() => subjects.value.flatMap(subject => [...subject.images, ...subject.voices].map(asset => ({
  id: asset.path,
  name: `${subject.name} · ${asset.name}`,
  dataType: asset.kind === "image" ? "IMAGE" : "AUDIO",
  media: { url: asset.path, mimeType: asset.mimeType },
  avatar: asset.kind === "image" ? assetUrl(asset.path) : subject.cover ? assetUrl(subject.cover.path) : undefined,
}))));
