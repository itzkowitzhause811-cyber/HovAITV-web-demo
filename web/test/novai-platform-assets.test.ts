import { afterEach, describe, expect, test } from "bun:test";
import type { InternalAxiosRequestConfig } from "axios";

import { ensureNovaiPlatformCanvasAsset, loadNovaiPlatformAssetSources, reuseNovaiPlatformFavoriteAsset, type NovaiPlatformAsset } from "@/services/api/novai-platform-assets";
import { novaiAssetToInsertPayload, resolveNovaiPlatformInsertPayload } from "@/components/canvas/canvas-project-asset-modal";
import { apiClient } from "@/services/api/request";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const originalAdapter = apiClient.defaults.adapter;
const originalBaseURL = apiClient.defaults.baseURL;
const originalFetch = globalThis.fetch;

afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    apiClient.defaults.baseURL = originalBaseURL;
    globalThis.fetch = originalFetch;
});

function readyAsset(overrides: Partial<NovaiPlatformAsset> = {}): NovaiPlatformAsset {
    return {
        id: "asset-1",
        project_id: "project-1",
        type: "image",
        source_type: "upload",
        status: "ready",
        lifecycle_status: "active",
        content_type: "image/png",
        file_name: "默认学生形象.jpg",
        file_size: 128,
        width: 1024,
        height: 1024,
        preview_url: "/api/v1/assets/asset-1/content",
        ...overrides,
    };
}

function response<T>(config: InternalAxiosRequestConfig, data: T) {
    return { data: { code: 0, data, message: "ok" }, status: 200, statusText: "OK", headers: {}, config };
}

describe("NovAI platform asset bridge", () => {
    test("loads the current project and account favorites from the original NovAI API", async () => {
        const urls: string[] = [];
        apiClient.defaults.baseURL = "/api/v1/novtv/workspace";
        apiClient.defaults.adapter = async (config) => {
            const url = apiClient.getUri(config);
            urls.push(url);
            if (url.includes("/asset-library/assets")) {
                return response(config, { items: [{ id: "favorite-1", asset_id: "asset-2", source_project: { id: "project-2", title: "来源项目" }, asset: readyAsset({ id: "asset-2", project_id: "project-2" }), favorited_at: "2026-10-12T00:00:00Z" }], page: 1, page_size: 100, total: 1 });
            }
            return response(config, { items: [readyAsset()], page: 1, page_size: 100, total: 1 });
        };

        const result = await loadNovaiPlatformAssetSources("project-1");

        expect(result.projectAssets.map((asset) => asset.id)).toEqual(["asset-1"]);
        expect(result.favoriteAssets.map((item) => item.asset_id)).toEqual(["asset-2"]);
        expect(urls).toContain("/api/v1/projects/project-1/assets?status=ready&page=1&page_size=100");
        expect(urls).toContain("/api/v1/asset-library/assets?page=1&page_size=100");
        expect(apiClient.defaults.baseURL).toBe("/api/v1/novtv/workspace");
    });

    test("reuses a favorite into the target project with a stable idempotency key", async () => {
        const requests: InternalAxiosRequestConfig[] = [];
        apiClient.defaults.adapter = async (config) => {
            requests.push(config);
            return response(config, { target_asset: readyAsset({ id: "target-asset", project_id: "target-project", type: "character_ref" }) });
        };

        const first = await reuseNovaiPlatformFavoriteAsset("source-asset", "target-project", "character_ref");
        await reuseNovaiPlatformFavoriteAsset("source-asset", "target-project", "character_ref");

        expect(first.target_asset.id).toBe("target-asset");
        expect(apiClient.getUri(requests[0]!)).toBe("/api/v1/asset-library/assets/source-asset/reuse");
        expect(requests[0]!.data).toBe('{"target_project_id":"target-project","target_type":"character_ref"}');
        expect(requests[0]!.headers.get("Idempotency-Key")).toMatch(/^novtv_reuse_[0-9a-f]{16}$/);
        expect(requests[1]!.headers.get("Idempotency-Key")).toBe(requests[0]!.headers.get("Idempotency-Key"));
    });

    test("keeps an existing ready target asset and rejects cross-project binding", async () => {
        let projectId = "project-1";
        apiClient.defaults.adapter = async (config) => response(config, readyAsset({ project_id: projectId }));
        const node = imageNode({ assetId: "asset-1", content: "/api/v1/assets/asset-1/content" });

        await expect(ensureNovaiPlatformCanvasAsset({ projectId: "project-1", canvasId: "canvas-1", node })).resolves.toMatchObject({ created: false, asset: { id: "asset-1" } });
        projectId = "project-2";
        await expect(ensureNovaiPlatformCanvasAsset({ projectId: "project-1", canvasId: "canvas-1", node })).rejects.toThrow("尚未复用到当前画布项目");
    });

    test("does not resurrect a deleted main asset from its cached resource", async () => {
        let uploads = 0;
        apiClient.defaults.adapter = async (config) => {
            if (config.url === "/assets/deleted-main-asset") return response(config, { asset: { id: "deleted-main-asset", metadata: { novaiAssetId: "deleted-main-asset" } } });
            if (config.method === "post") uploads++;
            const error = new Error("missing") as Error & { isAxiosError: boolean; response: object; config: InternalAxiosRequestConfig };
            error.isAxiosError = true;
            error.config = config;
            error.response = { status: 404, data: { code: 404001, message: "not found" }, headers: {} };
            throw error;
        };
        const node = imageNode({ assetId: "deleted-main-asset", content: "/api/v1/novtv/workspace/resources/cached/file", storageKey: "resource:cached" });
        await expect(ensureNovaiPlatformCanvasAsset({ projectId: "project-1", canvasId: "canvas-1", node })).rejects.toThrow("已删除或归档");
        expect(uploads).toBe(0);
    });

    test("uploads a newly generated resource to the target NovAI project", async () => {
        const requests: InternalAxiosRequestConfig[] = [];
        apiClient.defaults.adapter = async (config) => {
            requests.push(config);
            if (config.method === "get") {
                const error = new Error("missing") as Error & { isAxiosError: boolean; response: { status: number; data: { code: number; message: string }; headers: object }; config: InternalAxiosRequestConfig };
                error.isAxiosError = true;
                error.config = config;
                error.response = { status: 404, data: { code: 404001, message: "not found" }, headers: {} };
                throw error;
            }
            return response(config, readyAsset({ id: "uploaded-asset", project_id: "project-1", file_name: "生成图片.png" }));
        };
        globalThis.fetch = async () => new Response(new Blob(["image"], { type: "image/png" }), { status: 200 });
        const node = imageNode({ assetId: "novtv-local-asset", content: "/api/v1/novtv/workspace/resources/result/file", taskId: "task-1" });

        const result = await ensureNovaiPlatformCanvasAsset({ projectId: "project-1", canvasId: "canvas-1", node, taskId: "task-1" });

        expect(result).toMatchObject({ created: true, asset: { id: "uploaded-asset", project_id: "project-1" } });
        const upload = requests.find((request) => request.method === "post");
        expect(upload && apiClient.getUri(upload)).toBe("/api/v1/projects/project-1/assets/uploads");
        expect(upload?.headers.get("Idempotency-Key")).toMatch(/^novtv_asset_[0-9a-f]{16}$/);
        expect(upload?.data).toBeInstanceOf(FormData);
    });

    test("materialized generation IDs bypass main UUID lookup but retain the deleted-asset guard", async () => {
        const assetId = `generation_${"a".repeat(64)}`;
        let linked = false;
        let uploads = 0;
        apiClient.defaults.adapter = async (config) => {
            if (config.url === `/v1/assets/${assetId}`) throw new Error("main API rejects non-UUID IDs");
            if (config.url === `/assets/${assetId}`) return response(config, { asset: { id: assetId, metadata: linked ? { novaiAssetId: "deleted-main-asset" } : {} } });
            uploads++;
            return response(config, readyAsset({ id: "main-result" }));
        };
        globalThis.fetch = async () => new Response(new Blob(["image"], { type: "image/png" }));
        const input = { projectId: "project-1", canvasId: "canvas-1", node: imageNode({ assetId, storageKey: "resource:result", taskId: "task-1" }) };
        await expect(ensureNovaiPlatformCanvasAsset(input)).resolves.toMatchObject({ created: true, asset: { id: "main-result" } });
        linked = true;
        await expect(ensureNovaiPlatformCanvasAsset(input)).rejects.toThrow("已删除或归档");
        expect(uploads).toBe(1);
    });

    test("binds a same-project asset without reuse and keeps the target asset id", async () => {
        let reuseCalls = 0;
        const source = readyAsset({ id: "target-asset", project_id: "target-project", preview_url: "/api/v1/assets/target-asset/content" });

        const payload = await resolveNovaiPlatformInsertPayload(source, "target-project", undefined, async () => {
            reuseCalls += 1;
            return { target_asset: source };
        });

        expect(reuseCalls).toBe(0);
        expect(payload).toMatchObject({ kind: "image", assetId: "target-asset", dataUrl: "/api/v1/assets/target-asset/content" });
    });

    for (const sample of [
        { nodeType: CanvasNodeType.Image, assetType: "image" as const, mime: "image/png", extension: "png" },
        { nodeType: CanvasNodeType.Video, assetType: "video" as const, mime: "video/mp4", extension: "mp4" },
        { nodeType: CanvasNodeType.Audio, assetType: "audio" as const, mime: "audio/wav", extension: "wav" },
    ]) {
        test(`${sample.assetType} writeback preserves bytes/type and retries with the same idempotency key`, async () => {
            const bytes = new Uint8Array([0, 1, 2, 128, 255]);
            const uploads: InternalAxiosRequestConfig[] = [];
            globalThis.fetch = async (url, options) => {
                expect(String(url)).toContain("/resources/result/file");
                expect(options?.credentials).toBe("include");
                return new Response(new Blob([bytes], { type: sample.mime }));
            };
            apiClient.defaults.adapter = async (config) => {
                uploads.push(config);
                return response(config, readyAsset({ id: "written-back", type: sample.assetType, content_type: sample.mime }));
            };
            const node = { ...imageNode({ storageKey: "resource:result", taskId: "task-media" }), type: sample.nodeType, title: "验收素材" };
            const request = { projectId: "project-1", canvasId: "canvas-1", node };
            await ensureNovaiPlatformCanvasAsset(request);
            await ensureNovaiPlatformCanvasAsset(request);
            expect(uploads).toHaveLength(2);
            expect(uploads[0]!.headers.get("Idempotency-Key")).toBe(uploads[1]!.headers.get("Idempotency-Key"));
            const form = uploads[0]!.data as FormData;
            const file = form.get("file") as File;
            expect(form.get("type")).toBe(sample.assetType);
            expect(file.name).toBe(`验收素材.${sample.extension}`);
            expect(file.type).toBe(sample.mime);
            expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
            // A later task on the same node must create a separate candidate.
            await ensureNovaiPlatformCanvasAsset({ ...request, taskId: "next-task" });
            expect(uploads[2]!.headers.get("Idempotency-Key")).not.toBe(uploads[0]!.headers.get("Idempotency-Key"));
        });
    }

    test("failed media reads never report a successful main asset writeback", async () => {
        let uploads = 0;
        apiClient.defaults.adapter = async (config) => { uploads++; return response(config, readyAsset()); };
        globalThis.fetch = async () => new Response(null, { status: 404 });
        await expect(ensureNovaiPlatformCanvasAsset({ projectId: "project-1", canvasId: "canvas-1", node: imageNode({ storageKey: "resource:missing" }) })).rejects.toThrow("HTTP 404");
        expect(uploads).toBe(0);
    });

    test("reuses a cross-project favorite before returning the target asset id", async () => {
        const calls: unknown[][] = [];
        const target = readyAsset({ id: "reused-target", project_id: "target-project", type: "character_ref", preview_url: "/api/v1/assets/reused-target/content" });

        const payload = await resolveNovaiPlatformInsertPayload(readyAsset({ id: "source-asset", project_id: "source-project", type: "character_ref" }), "target-project", "source-asset", async (...args) => {
            calls.push(args);
            return { target_asset: target };
        });

        expect(calls).toEqual([["source-asset", "target-project", "character_ref"]]);
        expect(payload).toMatchObject({ kind: "image", assetId: "reused-target", dataUrl: "/api/v1/assets/reused-target/content" });
    });

    test("rejects stale and unsupported platform assets before node insertion", () => {
        expect(() => novaiAssetToInsertPayload(readyAsset({ lifecycle_status: "trashed" }))).toThrow("已失效");
        expect(() => novaiAssetToInsertPayload(readyAsset({ type: "document", content_type: "application/pdf" }))).toThrow("不支持文档素材");
    });
});

function imageNode(metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return {
        id: "node-1",
        type: CanvasNodeType.Image,
        title: "生成图片",
        position: { x: 0, y: 0 },
        width: 320,
        height: 320,
        metadata,
    };
}
