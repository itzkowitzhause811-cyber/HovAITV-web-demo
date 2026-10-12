import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { AssetLibraryPickerModal, type AssetLibraryPickerItem, type AssetLibraryPickerSource, type AssetPickerMediaKind } from "@/components/assets/asset-library-picker-modal";
import { useExternalAssetSources } from "@/hooks/use-external-asset-sources";
import { externalAssetToInsertPayload, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { compileCharacterReferencePrompt } from "@/lib/canvas/canvas-character-reference";
import { ASSET_CATEGORY_LABELS, normalizeAssetCategory } from "@/lib/asset-category";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import type { ProjectAsset, ProjectDetail } from "@/services/api/projects";
import { getWorkspaceAsset } from "@/services/api/workspace-data";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { NOVAI_PLATFORM_ENABLED } from "@/lib/novai-platform";
import { prepareNovaiPlatformResource } from "@/services/novai-platform-resource";
import { loadNovaiPlatformAssetSources, reuseNovaiPlatformFavoriteAsset, type NovaiPlatformAsset, type NovaiPlatformAssetType } from "@/services/api/novai-platform-assets";

const categoryLabels: Record<string, string> = { all: "全部资产", ...ASSET_CATEGORY_LABELS };
type ProjectPickerItem = {
    id: string;
    category: string;
    folderId?: string;
    project?: ProjectAsset;
    character?: ProjectAsset;
    media?: Asset;
    novaiAsset?: NovaiPlatformAsset;
    favoriteSourceAssetId?: string;
};

export function CanvasProjectAssetModal({
    open,
    detail,
    domainProjectId,
    initialCategory = "all",
    initialFolderId = "all",
    onClose,
    onInsert,
    onInsertFolder,
}: {
    open: boolean;
    detail?: ProjectDetail;
    domainProjectId?: string;
    initialCategory?: string;
    initialFolderId?: string;
    onClose: () => void;
    onInsert: (payloads: InsertAssetPayload[]) => Promise<void> | void;
    onInsertFolder?: (folderId: string) => Promise<void> | void;
}) {
    const mediaAssets = useAssetStore((state) => state.assets);
    const externalAssetSources = useExternalAssetSources(open && !NOVAI_PLATFORM_ENABLED);
    const targetProjectId = domainProjectId || detail?.project.id || "";
    const platformAssetsQuery = useQuery({
        queryKey: ["novai-platform-assets", targetProjectId],
        queryFn: ({ signal }) => loadNovaiPlatformAssetSources(targetProjectId, signal),
        enabled: NOVAI_PLATFORM_ENABLED && open && Boolean(targetProjectId),
    });
    const items = useMemo<ProjectPickerItem[]>(() => {
        const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
        const projectItems = (detail?.assets || []).flatMap((asset): ProjectPickerItem[] => {
            if (asset.category === "character" && asset.character) return [{ id: asset.id, category: "character", folderId: asset.folderId, project: asset, character: asset }];
            const media = mediaById.get(asset.id);
            if (media?.status === "archived") return [];
            return asset.mediaType === "model" || asset.mediaType === "entity" ? [] : [{ id: asset.id, category: normalizeAssetCategory(asset.category || media?.category), folderId: asset.folderId, project: asset, media }];
        });
        if (detail) return projectItems;
        // 自由画布未关联项目时回退到个人素材库。
        return mediaAssets.filter((asset) => asset.kind !== "model" && asset.kind !== "entity" && asset.status !== "archived").map((media): ProjectPickerItem => ({ id: media.id, category: normalizeAssetCategory(media.category), media }));
    }, [detail?.assets, mediaAssets]);
    const localPickerItems = useMemo<AssetLibraryPickerItem[]>(
        () =>
            items.map((item) => {
                const character = item.character;
                const project = item.project;
                const media = item.media;
                const coverRepresentation =
                    character?.character?.representations.find((representation) => representation.role === "turnaround_sheet") ||
                    character?.character?.representations.find((representation) => representation.role === "primary") ||
                    character?.character?.representations.find((representation) => representation.role === "front");
                const remoteResourceId = resourceIdFromStorageKey(project?.storageKey);
                // 项目资产可能只有服务端记录、没有本地素材，媒体类型要显式声明，筛选才能覆盖它们。
                const mediaKind = character ? undefined : pickerMediaKind(media?.kind || project?.mediaType);
                return {
                    id: item.id,
                    title: character?.title || project?.title || media?.title || "未命名资产",
                    category: item.category,
                    folderId: item.folderId,
                    kindLabel: character ? "角色卡" : mediaKind === "video" ? "视频" : mediaKind === "audio" ? "音频" : mediaKind === "text" ? "文本" : "图片",
                    mediaKind,
                    asset: media,
                    imageUrl: coverRepresentation ? resourceFileUrl(coverRepresentation.resourceId) : project?.mediaType === "image" && remoteResourceId ? resourceFileUrl(remoteResourceId) : undefined,
                    imageStorageKey: coverRepresentation ? `resource:${coverRepresentation.resourceId}` : undefined,
                    imageFit: character ? "contain" : "cover",
                    description: character ? `${character.character?.visualStatus === "ready" ? "形象就绪" : "形象待完善"} · ${character.character?.voiceStatus === "ready" ? "声音已绑定" : "声音未绑定"}` : project?.previewText,
                    searchText: [media?.tags?.join(" ") || "", project?.previewText || ""].join(" "),
                };
            }),
        [items],
    );
    const platformProjectItems = useMemo<ProjectPickerItem[]>(
        () => (platformAssetsQuery.data?.projectAssets || []).map((asset) => novaiProjectPickerItem("project", asset)),
        [platformAssetsQuery.data?.projectAssets],
    );
    const platformFavoriteItems = useMemo<ProjectPickerItem[]>(
        () =>
            (platformAssetsQuery.data?.favoriteAssets || []).map((favorite) => ({
                ...novaiProjectPickerItem("favorite", favorite.asset),
                favoriteSourceAssetId: favorite.asset_id,
            })),
        [platformAssetsQuery.data?.favoriteAssets],
    );
    const platformProjectPickerItems = useMemo(() => platformProjectItems.map(projectPickerItemView), [platformProjectItems]);
    const platformFavoritePickerItems = useMemo(() => platformFavoriteItems.map(projectPickerItemView), [platformFavoriteItems]);
    const platformSources = useMemo<AssetLibraryPickerSource[]>(
        () => [
            { key: "project", label: "当前项目", icon: "project", items: platformProjectPickerItems },
            { key: "favorites", label: "我的收藏", icon: "favorite", items: platformFavoritePickerItems },
        ],
        [platformFavoritePickerItems, platformProjectPickerItems],
    );
    const pickerItems = useMemo<AssetLibraryPickerItem[]>(
        () => (NOVAI_PLATFORM_ENABLED ? [...platformProjectPickerItems, ...platformFavoritePickerItems] : [...localPickerItems, ...externalAssetSources.items]),
        [externalAssetSources.items, localPickerItems, platformFavoritePickerItems, platformProjectPickerItems],
    );
    const selectableItems = NOVAI_PLATFORM_ENABLED ? [...platformProjectItems, ...platformFavoriteItems] : items;

    return (
        <AssetLibraryPickerModal
            remoteLibrary={!detail && !isLocalWorkspaceMode()}
            open={open}
            mediaKinds={["image", "video", "audio", "text"]}
            items={pickerItems}
            sources={NOVAI_PLATFORM_ENABLED ? platformSources : undefined}
            categoryLabels={{ ...categoryLabels, ...externalAssetSources.categoryLabels }}
            initialCategory={initialCategory}
            initialFolderId={initialFolderId}
            folders={externalAssetSources.folders}
            folderActionSource="local"
            title="项目资产"
            confirmLabel={(count) => `引入已选资产${count ? `（${count}）` : ""}`}
            emptyTitle="此分类没有可引用资产"
            emptyDescription={NOVAI_PLATFORM_ENABLED ? "当前来源暂无可用素材。" : detail ? "先在项目角色与资产中完成角色确认或素材关联。" : "当前为自由画布，可先在素材库添加内容。"}
            footerNote={NOVAI_PLATFORM_ENABLED ? (!targetProjectId ? "未关联画布项目，请从主站项目列表重新进入画布" : platformAssetsQuery.error instanceof Error ? platformAssetsQuery.error.message : "收藏素材会先复用到当前项目，再绑定到画布节点") : externalAssetSources.error || "角色引用会在生成时解析当前角色版本"}
            loading={NOVAI_PLATFORM_ENABLED && platformAssetsQuery.isLoading}
            onFolderAction={
                onInsertFolder
                    ? async (folderId) => {
                          await onInsertFolder(folderId);
                          onClose();
                      }
                    : undefined
            }
            onClose={onClose}
            onConfirm={async (ids) => {
                const payloads = await Promise.all(
                    ids.map(async (id) => {
                        const external = externalAssetSources.items.find((item) => item.id === id)?.external;
                        if (external) return externalAssetToInsertPayload(external);
                        const item = selectableItems.find((candidate) => candidate.id === id);
                        if (!item) throw new Error("所选资产已不存在，请重新选择");
                        if (item.novaiAsset) {
                            const payload = await resolveNovaiPlatformInsertPayload(item.novaiAsset, targetProjectId, item.favoriteSourceAssetId);
                            const media = await prepareNovaiPlatformResource(item.novaiAsset.project_id === targetProjectId ? item.novaiAsset.id : payload.assetId!, targetProjectId);
                            return payload.kind === "image" ? { ...payload, ...media, dataUrl: media.url } : { ...payload, ...media };
                        }
                        if (item.media || item.character || !item.project) return toInsertPayload(item);
                        const { asset } = await getWorkspaceAsset(item.project.id);
                        return toInsertPayload({ ...item, media: asset });
                    }),
                );
                if (!payloads.length) return;
                await onInsert(payloads);
                onClose();
            }}
        />
    );
}

function novaiProjectPickerItem(source: "project" | "favorite", asset: NovaiPlatformAsset): ProjectPickerItem {
    return {
        id: `${source}:${asset.id}`,
        category: novaiAssetCategory(asset.type),
        folderId: undefined,
        novaiAsset: asset,
    };
}

function projectPickerItemView(item: ProjectPickerItem): AssetLibraryPickerItem {
    const asset = item.novaiAsset!;
    const mediaKind = novaiAssetMediaKind(asset);
    const usable = Boolean(mediaKind) && asset.status === "ready" && asset.lifecycle_status !== "trashed" && Boolean(asset.preview_url);
    return {
        id: item.id,
        title: asset.file_name || "未命名素材",
        category: item.category,
        kindLabel: mediaKind === "video" ? "视频" : mediaKind === "audio" ? "音频" : mediaKind === "image" ? "图片" : "文件",
        mediaKind,
        imageUrl: mediaKind === "image" ? asset.preview_url || undefined : undefined,
        imageFit: item.category === "character" ? "contain" : "cover",
        description: asset.type === "character_ref" ? "角色" : asset.type === "location_ref" ? "场景" : asset.type === "prop_ref" ? "道具" : asset.type === "style_ref" ? "画风" : undefined,
        searchText: [asset.file_name || "", asset.type].join(" "),
        disabledReason: usable ? undefined : asset.type === "document" ? "当前画布不支持文档素材" : "素材尚未就绪或已失效",
    };
}

export async function resolveNovaiPlatformInsertPayload(
    sourceAsset: NovaiPlatformAsset,
    targetProjectId: string,
    favoriteSourceAssetId?: string,
    reuseFavorite = reuseNovaiPlatformFavoriteAsset,
): Promise<InsertAssetPayload> {
    let asset = sourceAsset;
    if (favoriteSourceAssetId && asset.project_id !== targetProjectId) {
        const reused = await reuseFavorite(favoriteSourceAssetId, targetProjectId, reusableTargetType(asset.type));
        asset = reused.target_asset;
    }
    if (asset.project_id !== targetProjectId) throw new Error("收藏素材未能复用到当前画布项目");
    return novaiAssetToInsertPayload(asset);
}

export function novaiAssetToInsertPayload(asset: NovaiPlatformAsset): InsertAssetPayload {
    if (asset.status !== "ready" || asset.lifecycle_status === "trashed" || !asset.preview_url) throw new Error(`“${asset.file_name || "未命名素材"}”已失效，请刷新后重试`);
    if (asset.type === "document") throw new Error("当前画布不支持文档素材");
    const title = asset.file_name || "项目素材";
    const durationMs = typeof asset.duration === "number" ? Math.max(0, Math.round(asset.duration * 1000)) : undefined;
    const mediaKind = novaiAssetMediaKind(asset);
    if (mediaKind === "video") return { kind: "video", url: asset.preview_url, title, width: asset.width || undefined, height: asset.height || undefined, durationMs, bytes: asset.file_size, mimeType: asset.content_type || "video/mp4", assetId: asset.id };
    if (mediaKind === "audio") return { kind: "audio", url: asset.preview_url, title, durationMs, bytes: asset.file_size, mimeType: asset.content_type || "audio/mpeg", assetId: asset.id };
    return { kind: "image", dataUrl: asset.preview_url, url: asset.preview_url, title, width: asset.width || undefined, height: asset.height || undefined, bytes: asset.file_size, mimeType: asset.content_type || "image/png", assetId: asset.id };
}

function novaiAssetMediaKind(asset: NovaiPlatformAsset): AssetPickerMediaKind | undefined {
    if (asset.type === "video" || asset.content_type.startsWith("video/")) return "video";
    if (asset.type === "audio" || asset.content_type.startsWith("audio/")) return "audio";
    if (asset.type === "document") return undefined;
    return "image";
}

function novaiAssetCategory(type: NovaiPlatformAssetType) {
    if (type === "character_ref") return "character";
    if (type === "location_ref") return "environment";
    if (type === "prop_ref") return "prop";
    if (type === "style_ref") return "material";
    return "other";
}

function reusableTargetType(type: NovaiPlatformAssetType) {
    return type === "document" ? undefined : type;
}

function pickerMediaKind(value?: string): AssetPickerMediaKind {
    return value === "video" || value === "audio" || value === "text" ? value : "image";
}

function toInsertPayload(item: ProjectPickerItem): InsertAssetPayload {
    if (item.character?.character) {
        return projectCharacterToInsertPayload(item.character);
    }
    const asset = item.media;
    const project = item.project;
    if (!asset && project) {
        const resourceId = resourceIdFromStorageKey(project.storageKey);
        const remoteUrl = resourceId ? resourceFileUrl(resourceId) : "";
        if (project.mediaType === "text" && project.previewText) return { kind: "text", content: project.previewText, title: project.title, assetId: project.id };
        if (project.mediaType === "video" && remoteUrl) return { kind: "video", url: remoteUrl, storageKey: project.storageKey, title: project.title, assetId: project.id };
        if (project.mediaType === "audio" && remoteUrl) return { kind: "audio", url: remoteUrl, storageKey: project.storageKey, title: project.title, assetId: project.id };
        if (project.mediaType === "image" && remoteUrl) return { kind: "image", dataUrl: remoteUrl, storageKey: project.storageKey, title: project.title, assetId: project.id };
        throw new Error(`“${project.title}”缺少可读取的内容`);
    }
    if (!asset) throw new Error("项目资产不可用");
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title, assetId: asset.id };
    if (asset.kind === "video")
        return {
            kind: "video",
            url: projectAssetMediaUrl(asset.data.storageKey, asset.data.url),
            storageKey: asset.data.storageKey,
            title: asset.title,
            width: asset.data.width,
            height: asset.data.height,
            durationMs: asset.data.durationMs,
            bytes: asset.data.bytes,
            mimeType: asset.data.mimeType,
            assetId: asset.id,
        };
    if (asset.kind === "audio")
        return {
            kind: "audio",
            url: projectAssetMediaUrl(asset.data.storageKey, asset.data.url),
            storageKey: asset.data.storageKey,
            title: asset.title,
            durationMs: asset.data.durationMs,
            bytes: asset.data.bytes,
            mimeType: asset.data.mimeType,
            assetId: asset.id,
        };
    if (asset.kind === "image") return { kind: "image", dataUrl: projectAssetMediaUrl(asset.data.storageKey, asset.data.dataUrl), storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id };
    throw new Error("当前项目资产不能直接插入画布");
}

function projectAssetMediaUrl(storageKey?: string, fallback = "") {
    const resourceId = resourceIdFromStorageKey(storageKey);
    return resourceId ? resourceFileUrl(resourceId) : fallback;
}

export function projectCharacterToInsertPayload(asset: ProjectAsset): InsertAssetPayload {
    if (!asset.character) throw new Error("项目角色信息不完整");
    const card = asset.character;
    const definition = card.definition;
    const cover =
        card.representations.find((representation) => representation.role === "turnaround_sheet") ||
        card.representations.find((representation) => representation.role === "primary") ||
        card.representations.find((representation) => representation.role === "front");
    return {
        kind: "character",
        title: asset.title,
        assetId: asset.id,
        versionId: card.versionId,
        prompt: compileCharacterReferencePrompt(asset.title, definition),
        aliases: Array.isArray(definition.aliases) ? definition.aliases.filter((alias): alias is string => typeof alias === "string") : [],
        definition,
        coverUrl: cover ? resourceFileUrl(cover.resourceId) : undefined,
        visualStatus: card.visualStatus,
        voiceStatus: card.voiceStatus,
        voiceName: card.voice?.profile.name,
        voiceProfile: card.voice
            ? {
                  name: card.voice.profile.name,
                  provider: card.voice.profile.provider,
                  language: card.voice.profile.language,
                  timbre: card.voice.profile.timbre,
              }
            : undefined,
        voiceInstructions: card.voice?.instructions,
    };
}
