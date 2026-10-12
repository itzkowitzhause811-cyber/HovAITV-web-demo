import { ApiError, http } from "@/services/api/request";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { getWorkspaceAsset } from "@/services/api/workspace-data";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type NovaiPlatformAssetType = "character_ref" | "location_ref" | "prop_ref" | "style_ref" | "audio" | "image" | "video" | "document";

export type NovaiPlatformAsset = {
    id: string;
    project_id: string;
    type: NovaiPlatformAssetType;
    source_type: string;
    status: string;
    lifecycle_status?: string;
    content_type: string;
    file_name?: string;
    file_size: number;
    width?: number | null;
    height?: number | null;
    duration?: number | null;
    preview_url?: string | null;
    is_favorited?: boolean;
};

export type NovaiPlatformFavoriteAsset = {
    id: string;
    asset_id: string;
    source_project: { id: string; title: string; deleted?: boolean };
    asset: NovaiPlatformAsset;
    favorited_at: string;
};

type NovaiPage<T> = { items: T[]; page: number; page_size: number; total: number };
type NovaiEnvelope<T> = { code: number; data: T; message?: string; msg?: string };
type NovaiRequestConfig = Parameters<typeof http.raw>[0];

async function novaiRequest<T>(config: NovaiRequestConfig) {
    const response = await http.raw<NovaiEnvelope<T>>({ ...config, baseURL: "/api" });
    if (response.data.code !== 0) {
        throw new ApiError(response.data.message || response.data.msg || "主站素材请求失败", { code: response.data.code, status: response.status });
    }
    return response.data.data;
}

async function listAll<T>(path: string, signal?: AbortSignal) {
    const result: T[] = [];
    const pageSize = 100;
    for (let page = 1; ; page += 1) {
        const separator = path.includes("?") ? "&" : "?";
        const current = await novaiRequest<NovaiPage<T>>({ method: "get", url: `${path}${separator}page=${page}&page_size=${pageSize}`, signal });
        result.push(...(current.items || []));
        if (result.length >= current.total || current.items.length < pageSize) return result;
    }
}

export async function loadNovaiPlatformAssetSources(projectId: string, signal?: AbortSignal) {
    const encodedProjectId = encodeURIComponent(projectId);
    const [projectAssets, favoriteAssets] = await Promise.all([
        listAll<NovaiPlatformAsset>(`/v1/projects/${encodedProjectId}/assets?status=ready`, signal),
        listAll<NovaiPlatformFavoriteAsset>("/v1/asset-library/assets", signal),
    ]);
    return { projectAssets, favoriteAssets };
}

export async function reuseNovaiPlatformFavoriteAsset(sourceAssetId: string, targetProjectId: string, targetType?: NovaiPlatformAssetType) {
    const request = { target_project_id: targetProjectId, ...(targetType ? { target_type: targetType } : {}) };
    const identity = [sourceAssetId, targetProjectId, targetType || "source"].join(":");
    return novaiRequest<{ target_asset: NovaiPlatformAsset }>({
        method: "post",
        url: `/v1/asset-library/assets/${encodeURIComponent(sourceAssetId)}/reuse`,
        data: request,
        headers: { "Idempotency-Key": `novtv_reuse_${stableHash(identity)}` },
    });
}

export async function getNovaiPlatformAsset(assetId: string, signal?: AbortSignal) {
    return novaiRequest<NovaiPlatformAsset>({ method: "get", url: `/v1/assets/${encodeURIComponent(assetId)}`, signal });
}

export async function ensureNovaiPlatformCanvasAsset(input: {
    projectId: string;
    canvasId: string;
    node: CanvasNodeData;
    taskId?: string;
    signal?: AbortSignal;
}) {
    const explicitAssetId = input.node.metadata?.assetId?.trim();
    if (explicitAssetId) {
        // Materialization IDs are not main asset UUIDs. Sending them to the
        // main API returns 400 before an unlinked result can be uploaded.
        if (!/^generation_[a-f0-9]{64}$/.test(explicitAssetId)) {
            try {
                const existing = await getNovaiPlatformAsset(explicitAssetId, input.signal);
                if (existing.project_id !== input.projectId) throw new Error("所选素材尚未复用到当前画布项目");
                if (existing.status !== "ready" || existing.lifecycle_status === "trashed") throw new Error("所选项目素材已失效，请重新选择");
                return { asset: existing, created: false };
            } catch (error) {
                if (!(error instanceof ApiError) || error.status !== 404) throw error;
            }
        }
        if (contentAssetId(input.node.metadata?.content) === explicitAssetId) throw new Error("所选项目素材已删除或归档，请重新选择");
        // A resource copy must not resurrect a deleted main asset. Only
        // unlinked local generation results may fall through to upload.
        try {
            const { asset } = await getWorkspaceAsset(explicitAssetId);
            if (asset.metadata?.novaiAssetId) throw new Error("所选项目素材已删除或归档，请重新选择");
        } catch (lookupError) {
            if (!(lookupError instanceof ApiError) || lookupError.status !== 404) throw lookupError;
        }
    }

    const media = await canvasNodeMedia(input.node, input.signal);
    const form = new FormData();
    const fileName = canvasAssetFileName(input.node, media.type);
    form.set("file", new File([media], fileName, { type: media.type || fallbackMimeType(input.node.type) }));
    form.set("type", novaiAssetTypeForNode(input.node));
    const identity = [input.canvasId, input.node.id, input.taskId || input.node.metadata?.taskId || input.node.metadata?.storageKey || explicitAssetId || fileName].join(":");
    const asset = await novaiRequest<NovaiPlatformAsset>({
        method: "post",
        url: `/v1/projects/${encodeURIComponent(input.projectId)}/assets/uploads`,
        timeout: 120_000,
        data: form,
        headers: { "Idempotency-Key": `novtv_asset_${stableHash(identity)}` },
        signal: input.signal,
    });
    return { asset, created: true };
}

async function canvasNodeMedia(node: CanvasNodeData, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const resourceId = resourceIdFromStorageKey(node.metadata?.storageKey);
    const url = resourceId ? resourceFileUrl(resourceId) : node.metadata?.content?.trim();
    if (!url) throw new Error("当前节点没有可写入项目资产的媒体内容");
    const response = await fetch(url, { credentials: "include", signal });
    if (!response.ok) throw new Error(`项目素材内容读取失败（HTTP ${response.status}）`);
    return response.blob();
}

function novaiAssetTypeForNode(node: CanvasNodeData): NovaiPlatformAssetType {
    if (node.type === CanvasNodeType.Video) return "video";
    if (node.type === CanvasNodeType.Audio) return "audio";
    if (node.type !== CanvasNodeType.Image) throw new Error("当前节点类型不能写入项目媒体资产");
    if (node.metadata?.assetCategory === "character" || node.metadata?.workflowKind === "character") return "character_ref";
    if (node.metadata?.assetCategory === "environment" || node.metadata?.workflowKind === "scene") return "location_ref";
    if (node.metadata?.assetCategory === "prop") return "prop_ref";
    if (node.metadata?.workflowKind === "styleboard") return "style_ref";
    return "image";
}

function canvasAssetFileName(node: CanvasNodeData, mimeType: string) {
    const base = (node.title || "画布素材").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80) || "画布素材";
    const extension = extensionForMimeType(mimeType || fallbackMimeType(node.type));
    return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
}

function fallbackMimeType(nodeType: string) {
    if (nodeType === CanvasNodeType.Video) return "video/mp4";
    if (nodeType === CanvasNodeType.Audio) return "audio/mpeg";
    return "image/png";
}

function extensionForMimeType(mimeType: string) {
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("quicktime")) return "mov";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("audio")) return "mp3";
    if (mimeType.includes("video")) return "mp4";
    return "png";
}

function contentAssetId(value?: string) {
    if (!value) return "";
    try {
        const path = new URL(value, globalThis.location?.origin || "http://localhost").pathname;
        return path.match(/\/api\/v1\/assets\/([^/]+)\/content$/)?.[1] || "";
    } catch {
        return "";
    }
}

function stableHash(value: string) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    }
    return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}
