import { computed, inject, ref, toValue, type MaybeRefOrGetter } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import type { NodeData } from "./connection";
import { useNodeEvent } from "./nodeEvent";
import type { NodeInputValue, NodeMediaValue } from "./values";

export type ExternalNodeMention = {
  id: string;
  name: string;
  dataType: "IMAGE" | "VIDEO" | "AUDIO";
  media: NodeMediaValue;
  avatar?: string;
};

type ReferenceValue = NodeInputValue & { subject?: boolean; label?: string; avatar?: string };

function isReference(value: unknown): value is ReferenceValue {
  return !!value && typeof value === "object" && "source" in value && "sourceHandle" in value && "dataType" in value && "value" in value;
}

export function referenceIdsFromModel(model: unknown) {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const tag = value as { type?: unknown; html?: unknown };
    if (tag.type !== "Custom" || typeof tag.html !== "string") return;
    for (const match of tag.html.matchAll(/data-reference-id=(?:"([^"]+)"|'([^']+)')/g)) {
      const id = match[1] ?? match[2];
      if (id) ids.add(id);
    }
  };
  visit(model);
  return ids;
}

export function useNodeReferences(
  handleId = "in",
  selectedReferences?: MaybeRefOrGetter<ReadonlySet<string> | undefined>,
  externalDataTypes: readonly string[] = [],
) {
  const { id, node } = useNode<NodeData & { referenceOrder?: Record<string, string[]> }>();
  const { removeEdges } = useVueFlow();
  const inputValues = ref<NodeInputValue[]>([]);
  const previews = ref(new Map<string, string>());
  const externalMentions = inject<MaybeRefOrGetter<ExternalNodeMention[]>>("externalNodeMentions", []);
  const externalValues = computed<ReferenceValue[]>(() => {
    const allowed = new Set(externalDataTypes);
    return toValue(externalMentions).filter(item => allowed.has(item.dataType)).map(item => ({
      source: `subject:${item.id}`,
      sourceHandle: item.id,
      dataType: item.dataType,
      value: item.media,
      subject: true,
      label: item.name,
      avatar: item.avatar,
    }));
  });
  const allInputValues = computed<ReferenceValue[]>(() => [...inputValues.value, ...externalValues.value]);
  const orderedRefs = computed(() => {
    const order = new Map(node.data.referenceOrder?.[handleId]?.map((key, index) => [key, index]));
    return [...allInputValues.value].filter(isReference).sort((a, b) => (order.get(referenceKey(a)) ?? order.size) - (order.get(referenceKey(b)) ?? order.size));
  });
  const refList = computed<ReferenceValue[]>({
    get() {
      const selected = toValue(selectedReferences);
      return orderedRefs.value.filter(item => !item.subject || (!!selected && selected.has(referenceKey(item))));
    },
    set(values: ReferenceValue[]) {
      node.data.referenceOrder = { ...node.data.referenceOrder, [handleId]: values.map(referenceKey) };
    },
  });
  const referenceMentions = computed(() => {
    const positions = new Map(refList.value.map((item, index) => [referenceKey(item), index + 1]));
    return orderedRefs.value.flatMap((item) => {
      if (!["IMAGE", "VIDEO", "AUDIO", "STRING"].includes(String(item.dataType))) return [];
      const key = referenceKey(item);
      const position = positions.get(key);
      const isSubject = item.subject === true;
      return [{
        id: key,
        name: isSubject ? item.label ?? "主体素材" : `参考 ${position ?? 1}`,
        value: isSubject ? `@${item.label ?? "主体素材"}` : `{{ref ${position ?? 1}}}`,
        avatar: isSubject ? item.avatar : previews.value.get(key) || undefined,
      }];
    });
  });

  useNodeEvent().on(`input:${handleId}`, (values) => {
    inputValues.value = values;
    const ids = new Set(values.filter(item => item.dataType === "IMAGE" || item.dataType === "VIDEO").map(referenceKey));
    for (const key of previews.value.keys()) {
      if (!ids.has(key)) previews.value.delete(key);
    }
  });

  function setReferencePreview(item: NodeInputValue, url: string) {
    previews.value.set(referenceKey(item), url);
  }

  function removeReference(item: ReferenceValue) {
    if (item.subject) return;
    removeEdges(edges => edges.filter(edge =>
      edge.target === id && edge.targetHandle === handleId && edge.source === item.source && edge.sourceHandle === item.sourceHandle
    ));
  }

  return { refList, referenceMentions, setReferencePreview, removeReference };
}

function referenceKey(item: Pick<NodeInputValue, "source" | "sourceHandle">) {
  return encodeURIComponent(JSON.stringify([item.source, item.sourceHandle]));
}
