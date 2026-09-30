<template>
  <el-card v-if="visible" class="subjectLibrary" shadow="never" :bodyStyle="{ padding: '8px' }" role="region" aria-label="主体库" @dblclick.stop>
    <div class="libraryToolbar">
      <el-input v-model="searchQuery" class="searchInput" :prefixIcon="IconSearch" placeholder="搜索主体" aria-label="搜索主体" clearable />
      <el-button class="toolbarButton" text :icon="IconPlus" title="新建主体" aria-label="新建主体" @click="startCreate" />
      <el-button class="toolbarButton" text :icon="IconX" title="关闭主体库" aria-label="关闭主体库" @click="visible = false" />
    </div>
    <el-scrollbar class="subjectScroll" maxHeight="min(440px, calc(100dvh - 198px))">
      <div v-if="loading" class="libraryState">正在加载…</div>
      <div v-else-if="loadError" class="libraryState errorState">
        <span>{{ loadError }}</span>
        <el-button text type="primary" size="small" @click="refresh">重试</el-button>
      </div>
      <div v-else-if="!filteredSubjects.length" class="libraryState">暂无主体，先新建一个主体再导入图片或音色。</div>
      <div v-else class="subjectGrid">
        <article v-for="subject in filteredSubjects" :key="subject.path" class="subjectCard">
          <button class="subjectCover" type="button" :aria-label="`查看主体 ${subject.name}`" @click="openSubject(subject)">
            <img v-if="subject.cover" :src="assetUrl(subject.cover.path)" alt="" />
            <icon-user v-else :size="42" />
          </button>
          <div class="subjectInfo">
            <strong :title="subject.name">{{ subject.name }}</strong>
            <span>{{ subject.images.length }} 张参考图 · {{ subject.voices.length }} 条音色</span>
          </div>
          <div class="subjectActions">
            <el-button text :icon="IconPhotoPlus" @click.stop="pickFiles(subject, 'image')">图片</el-button>
            <el-button text :icon="IconMicrophone" @click.stop="pickFiles(subject, 'audio')">音色</el-button>
            <el-dropdown trigger="click" @command="handleSubjectCommand($event, subject)">
              <el-button text :icon="IconDots" aria-label="主体操作" title="主体操作" @click.stop />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename">重命名</el-dropdown-item>
                  <el-dropdown-item command="delete">删除主体</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </article>
      </div>
    </el-scrollbar>
  </el-card>

  <input ref="fileInput" class="fileInput" type="file" hidden multiple :accept="fileAccept" @change="importFiles" />

  <el-dialog v-model="detailVisible" :title="activeSubject?.name" width="min(720px, calc(100vw - 32px))" alignCenter appendToBody destroyOnClose>
    <div v-if="activeSubject" class="subjectDetail">
      <section class="assetSection">
        <div class="sectionHeader"><strong>参考图</strong><span>{{ activeSubject.images.length }} 项</span></div>
        <div v-if="activeSubject.images.length" class="assetGrid">
          <div v-for="asset in activeSubject.images" :key="asset.path" class="assetTile">
            <img :src="assetUrl(asset.path)" :alt="asset.name" />
            <span :title="asset.name">{{ asset.name }}</span>
            <el-button class="removeAsset" text :icon="IconTrash" aria-label="删除参考图" title="删除" @click="removeAsset(asset)" />
          </div>
        </div>
        <div v-else class="sectionEmpty">暂无参考图</div>
      </section>
      <section class="assetSection">
        <div class="sectionHeader"><strong>音色样本</strong><span>{{ activeSubject.voices.length }} 项</span></div>
        <div v-if="activeSubject.voices.length" class="voiceList">
          <div v-for="asset in activeSubject.voices" :key="asset.path" class="voiceItem">
            <div class="voiceInfo"><icon-microphone :size="18" /><span :title="asset.name">{{ asset.name }}</span></div>
            <audio :src="assetUrl(asset.path)" controls preload="metadata" />
            <el-button text :icon="IconTrash" aria-label="删除音色" title="删除" @click="removeAsset(asset)" />
          </div>
        </div>
        <div v-else class="sectionEmpty">暂无音色样本</div>
      </section>
    </div>
    <template #footer>
      <el-button @click="detailVisible = false">关闭</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="saveVisible" title="保存到主体库" width="460px" alignCenter appendToBody :closeOnClickModal="false">
    <el-form class="saveForm" labelPosition="top" @submit.prevent="saveOutput">
      <el-form-item label="主体">
        <el-select v-model="saveSubjectPath" aria-label="选择主体" :disabled="saving">
          <el-option v-for="subject in subjects" :key="subject.path" :label="subject.name" :value="subject.path" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="saveOutputs.length > 1" label="节点输出">
        <el-select v-model="saveOutputIndex" aria-label="节点输出" :disabled="saving">
          <el-option v-for="(item, index) in saveOutputs" :key="index" :label="item.label" :value="index" />
        </el-select>
      </el-form-item>
      <el-form-item label="素材名称">
        <el-input v-model="saveName" aria-label="素材名称" placeholder="输入完整文件名" :disabled="saving" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="saveVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!canSaveOutput" @click="saveOutput">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import axios from "axios";
import { ElMessage, ElMessageBox } from "element-plus";
import { IconDots, IconMicrophone, IconPhotoPlus, IconPlus, IconSearch, IconTrash, IconUser, IconX } from "@tabler/icons-vue";
import type { NodeOutput } from "@toonflow/nodes-scaffold/values";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { assetUrl, createSubject, loadSubjects, removeSubject, removeSubjectAsset, renameSubject, subjects, uploadSubjectContent, uploadSubjectFiles, type SubjectAsset, type SubjectEntry } from "@/lib/subjects";

type SubjectOutput = { label: string; output: NodeOutput };
const props = defineProps<{ directory?: string }>();
const visible = defineModel<boolean>({ default: false });
const loading = ref(false);
const loadError = ref("");
const searchQuery = ref("");
const fileInput = ref<HTMLInputElement>();
const pendingSubject = ref<SubjectEntry>();
const pendingKind = ref<"image" | "audio">("image");
const detailVisible = ref(false);
const activeSubject = ref<SubjectEntry>();
const saveVisible = ref(false);
const saving = ref(false);
const saveOutputs = ref<SubjectOutput[]>([]);
const saveOutputIndex = ref(0);
const saveSubjectPath = ref("");
const saveName = ref("");
let sourceDirectory: string | undefined;

const filteredSubjects = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  return query ? subjects.value.filter(subject => subject.name.toLocaleLowerCase().includes(query)) : subjects.value;
});
const fileAccept = computed(() => pendingKind.value === "image" ? "image/*" : "audio/*");
const selectedSaveSubject = computed(() => subjects.value.find(subject => subject.path === saveSubjectPath.value));
const canSaveOutput = computed(() => !!selectedSaveSubject.value && !!saveName.value.trim() && !!saveOutputs.value[saveOutputIndex.value]);

watch(visible, opened => { if (opened) void refresh(); });
watch(subjects, () => {
  if (activeSubject.value) activeSubject.value = subjects.value.find(subject => subject.path === activeSubject.value?.path);
  if (!subjects.value.some(subject => subject.path === saveSubjectPath.value)) saveSubjectPath.value = subjects.value[0]?.path ?? "";
}, { deep: true });

async function refresh() {
  loading.value = true;
  loadError.value = "";
  try { await loadSubjects(); }
  catch (error) { loadError.value = errorMessage(error, "主体库读取失败"); }
  finally { loading.value = false; }
}

async function startCreate() {
  try {
    const { value } = await ElMessageBox.prompt("创建一个可复用的主体，例如角色、场景或道具。", "新建主体", {
      inputValue: "新主体",
      inputPattern: /^[^\\/]+$/,
      inputValidator: input => !!input?.trim() || "请输入主体名称",
      confirmButtonText: "创建",
    });
    const subject = await createSubject(value);
    await refresh();
    ElMessage.success("已创建主体");
    return subject;
  } catch (error) {
    if (error !== "cancel" && error !== "close") showError(error, "创建主体失败");
  }
}

function pickFiles(subject: SubjectEntry, kind: "image" | "audio") {
  pendingSubject.value = subject;
  pendingKind.value = kind;
  fileInput.value?.click();
}

async function importFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  const subject = pendingSubject.value;
  if (!subject || !files.length) return;
  try {
    await uploadSubjectFiles(subject, pendingKind.value, files);
    ElMessage.success(`已导入 ${files.length} 个文件`);
  } catch (error) {
    showError(error, "导入主体素材失败");
  }
}

function openSubject(subject: SubjectEntry) {
  activeSubject.value = subject;
  detailVisible.value = true;
}

async function handleSubjectCommand(command: string, subject: SubjectEntry) {
  if (command === "delete") return void deleteSubject(subject);
  if (command === "rename") return void renameCurrentSubject(subject);
}

async function renameCurrentSubject(subject: SubjectEntry) {
  try {
    const { value } = await ElMessageBox.prompt("输入新的主体名称", "重命名主体", {
      inputValue: subject.name,
      inputPattern: /^[^\\/]+$/,
      inputValidator: input => !!input?.trim() || "请输入主体名称",
      confirmButtonText: "重命名",
    });
    await renameSubject(subject, value);
    ElMessage.success("主体已重命名");
  } catch (error) {
    if (error !== "cancel" && error !== "close") showError(error, "重命名主体失败");
  }
}

async function deleteSubject(subject: SubjectEntry) {
  try {
    await ElMessageBox.confirm(`确定删除主体“${subject.name}”及其全部参考图和音色？`, "删除主体", { type: "warning" });
    await removeSubject(subject);
    if (activeSubject.value?.path === subject.path) detailVisible.value = false;
    ElMessage.success("主体已删除");
  } catch (error) {
    if (error !== "cancel" && error !== "close") showError(error, "删除主体失败");
  }
}

async function removeAsset(asset: SubjectAsset) {
  try {
    await ElMessageBox.confirm(`确定删除“${asset.name}”？`, "删除主体素材", { type: "warning" });
    await removeSubjectAsset(asset.path);
    ElMessage.success("素材已删除");
  } catch (error) {
    if (error !== "cancel" && error !== "close") showError(error, "删除素材失败");
  }
}

async function openSave(label: string, outputs: SubjectOutput[]) {
  const items = outputs.filter(item => item.output.dataType === "IMAGE" || item.output.dataType === "AUDIO");
  if (!items.length) return showError(new Error("当前节点没有可保存的图片或音频输出"), "保存到主体库失败");
  await refresh();
  if (!subjects.value.length) {
    const subject = await startCreate();
    if (!subject) return;
  }
  sourceDirectory = props.directory;
  saveOutputs.value = items;
  saveOutputIndex.value = 0;
  saveSubjectPath.value = subjects.value[0]?.path ?? "";
  const output = items[0]!.output;
  saveName.value = label + outputFileExtension(output);
  saveVisible.value = true;
}

async function saveOutput() {
  const subject = selectedSaveSubject.value;
  const output = saveOutputs.value[saveOutputIndex.value]?.output;
  const name = saveName.value.trim();
  if (!subject || !output || !name || saving.value) return;
  if (!props.directory) return showError(new Error("请先选择工作目录"), "保存到主体库失败");
  saving.value = true;
  try {
    const value = output.value;
    if (typeof value !== "object") throw new Error("当前输出不是媒体文件");
    const content = await useWorkspaceFiles(() => sourceDirectory).read(value.url);
    await uploadSubjectContent(subject, output.dataType as "IMAGE" | "AUDIO", content, name, value.mimeType);
    saveVisible.value = false;
    ElMessage.success("已保存到主体库");
  } catch (error) {
    showError(error, "保存到主体库失败");
  } finally {
    saving.value = false;
  }
}

function outputFileExtension(output: NodeOutput) {
  if (typeof output.value !== "object") return "";
  return output.value.url.match(/\.[^./\\]+$/)?.[0] ?? (output.dataType === "IMAGE" ? ".png" : ".mp3");
}

function showError(error: unknown, fallback: string) {
  ElMessage.error(errorMessage(error, fallback));
}

function errorMessage(error: unknown, fallback: string) {
  return axios.isAxiosError<{ message: string }>(error) ? error.response?.data.message || error.message : error instanceof Error ? error.message : fallback;
}

defineExpose({ openSave });
</script>

<style lang="scss" scoped>
.subjectLibrary {
  width: min(420px, calc(100vw - 30px));
  max-height: calc(100dvh - 140px);

  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    max-height: inherit;
    box-sizing: border-box;
  }

  .libraryToolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    margin-bottom: 8px;

    .searchInput { flex: 1; min-width: 0; }
    .toolbarButton { flex-shrink: 0; width: 28px; height: 28px; margin: 0; padding: 0; }
  }

  .libraryState {
    padding: 36px 16px;
    color: var(--el-text-color-secondary);
    font-size: var(--el-font-size-small);
    line-height: 1.7;
    text-align: center;

    &.errorState { color: var(--el-color-danger); }
  }

  .subjectScroll { min-height: 0; max-height: 440px; }

  .subjectGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .subjectCard {
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: var(--el-border-radius-base);
    background: var(--el-bg-color-overlay);
  }

  .subjectCover {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    aspect-ratio: 1.35;
    padding: 0;
    border: 0;
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-light);
    cursor: pointer;

    img { width: 100%; height: 100%; object-fit: cover; }
    &:hover { filter: brightness(.94); }
    &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
  }

  .subjectInfo {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 8px 8px 4px;

    strong, span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    strong { font-size: var(--el-font-size-base); }
    span { color: var(--el-text-color-secondary); font-size: 11px; }
  }

  .subjectActions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2px;
    padding: 0 4px 4px;

    :deep(.el-button) { min-width: 0; margin: 0; padding: 4px; font-size: 12px; }
  }
}

.fileInput { display: none; }

.subjectDetail {
  display: flex;
  flex-direction: column;
  gap: 18px;

  .sectionHeader { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; span, strong { font-size: 13px; } span { color: var(--el-text-color-secondary); } }
  .sectionEmpty { padding: 16px 0; color: var(--el-text-color-secondary); font-size: 13px; text-align: center; }
  .assetGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; }
  .assetTile { position: relative; min-width: 0; overflow: hidden; border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base); background: var(--el-fill-color-light); }
  .assetTile img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; }
  .assetTile > span { display: block; overflow: hidden; padding: 5px 6px; color: var(--el-text-color-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .removeAsset { position: absolute; top: 3px; right: 3px; width: 24px; height: 24px; padding: 0; margin: 0; color: var(--el-color-white); background: color-mix(in srgb, #000 58%, transparent); }
  .voiceList { display: flex; flex-direction: column; gap: 8px; }
  .voiceItem { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base); }
  .voiceInfo { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; color: var(--el-text-color-secondary); }
  .voiceInfo span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .voiceItem audio { flex: 1; min-width: 180px; max-width: 360px; }
}

.saveForm :deep(.el-select) { width: 100%; }
</style>
