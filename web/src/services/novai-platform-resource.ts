import { ApiError, http } from "@/services/api/request";
import { getNovaiPlatformAsset, type NovaiPlatformAsset } from "@/services/api/novai-platform-assets";
import { getResource, resourceFileUrl, resourceIdFromStorageKey, uploadResourceFile } from "@/services/api/resources";
import { getWorkspaceAsset } from "@/services/api/workspace-data";
import type { Asset } from "@/stores/use-asset-store";

// The main project owns the asset. HovAI's resource is an execution copy keyed
// by that same asset ID, so its existing ownership and canvas guards still apply.
export async function registerNovaiPlatformResource(asset: NovaiPlatformAsset, storageKey: string) {
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) throw new Error("素材缺少可持久化的画布资源");
    const url = resourceFileUrl(resourceId);
    const now = new Date().toISOString();
    const base = {
        id: asset.id, title: asset.file_name || "项目素材", coverUrl: asset.content_type.startsWith("image/") ? url : "",
        tags: [], status: "confirmed" as const, source: "novai-project", createdAt: now, updatedAt: now,
        metadata: { novaiProjectId: asset.project_id, novaiAssetId: asset.id, novaiAssetType: asset.type },
    };
    const data = { storageKey, bytes: asset.file_size, mimeType: asset.content_type };
    const durationMs = typeof asset.duration === "number" ? Math.round(asset.duration * 1000) : undefined;
    const record: Asset = asset.type === "audio" || asset.content_type.startsWith("audio/")
        ? { ...base, kind: "audio", data: { ...data, url, durationMs } }
        : asset.type === "video" || asset.content_type.startsWith("video/")
            ? { ...base, kind: "video", data: { ...data, url, durationMs, width: asset.width || 1, height: asset.height || 1 } }
            : { ...base, kind: "image", data: { ...data, dataUrl: url, width: asset.width || 1, height: asset.height || 1 } };
    await http.put(`/assets/${encodeURIComponent(asset.id)}`, { asset: record }, { timeout: 120_000 });
    return { url, storageKey };
}

export async function prepareNovaiPlatformResource(assetId: string, projectId: string) {
    // Revalidate before reading a cached execution copy; stale/deleted assets
    // must not appear to import successfully just because bytes were cached.
    const asset = await getNovaiPlatformAsset(assetId);
    if (asset.project_id !== projectId) throw new Error("素材不属于当前画布项目，请先复用");
    if (asset.status !== "ready" || asset.lifecycle_status === "trashed" || asset.type === "document") throw new Error("素材已失效或不支持，请重新选择");
    try {
        const { asset: cached } = await getWorkspaceAsset(assetId);
        const storageKey = "storageKey" in cached.data ? cached.data.storageKey : undefined;
        const resourceId = resourceIdFromStorageKey(storageKey);
        if (resourceId && cached.metadata?.novaiProjectId === projectId) {
            const resource = await getResource(resourceId);
            if (resource.status === "ready") return { url: resourceFileUrl(resourceId), storageKey: storageKey! };
        }
    } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
    const response = await http.raw<Blob>({ baseURL: "/api", url: `/v1/novtv/assets/${encodeURIComponent(asset.id)}/content`, responseType: "blob", timeout: 120_000 });
    const kind = asset.type === "audio" || asset.content_type.startsWith("audio/") ? "audio" : asset.type === "video" || asset.content_type.startsWith("video/") ? "video" : "image";
    const resource = await uploadResourceFile(response.data, kind, {
        fileName: asset.file_name, width: asset.width || undefined, height: asset.height || undefined,
        durationMs: typeof asset.duration === "number" ? Math.round(asset.duration * 1000) : undefined,
        idempotencyKey: `novai-asset-${asset.id}`,
    });
    return registerNovaiPlatformResource(asset, `resource:${resource.id}`);
}
