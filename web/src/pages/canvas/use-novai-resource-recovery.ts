import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { NOVAI_PLATFORM_ENABLED } from "@/lib/novai-platform";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { prepareNovaiPlatformResource } from "@/services/novai-platform-resource";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

// Older platform uploads saved browser-only keys despite successful main-library
// writes. Recover from the authorized main asset, never from a stale blob URL.
export function useNovaiResourceRecovery(projectId: string, loaded: boolean, nodes: CanvasNodeData[], setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>) {
    const { message } = App.useApp();
    const attempted = useRef(new Set<string>());
    const activeProject = useRef(projectId);
    activeProject.current = projectId;
    useEffect(() => {
        if (!NOVAI_PLATFORM_ENABLED || !loaded || !projectId) return;
        for (const node of nodes) {
            if (![CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio].includes(node.type as CanvasNodeType)) continue;
            const assetId = node.metadata?.assetId;
            const oldKey = node.metadata?.storageKey;
            if (!assetId || resourceIdFromStorageKey(oldKey)) continue;
            const identity = `${projectId}:${node.id}:${assetId}:${oldKey || ""}`;
            if (attempted.current.has(identity)) continue;
            attempted.current.add(identity);
            void prepareNovaiPlatformResource(assetId, projectId).then((resource) => {
                if (activeProject.current !== projectId) return;
                setNodes((current) => current.map((item) => item.id === node.id && item.metadata?.assetId === assetId && item.metadata?.storageKey === oldKey
                    ? { ...item, metadata: { ...item.metadata, storageKey: resource.storageKey, content: resource.url } }
                    : item));
            }).catch((error) => message.warning(`素材恢复失败：${error instanceof Error ? error.message : "请重新选择项目素材"}`));
        }
    }, [loaded, message, nodes, projectId, setNodes]);
}
