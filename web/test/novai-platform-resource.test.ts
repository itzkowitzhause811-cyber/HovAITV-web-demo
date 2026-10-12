import { afterEach, expect, test } from "bun:test";
import type { InternalAxiosRequestConfig } from "axios";
import { apiClient } from "@/services/api/request";
import { prepareNovaiPlatformResource, registerNovaiPlatformResource } from "@/services/novai-platform-resource";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => { apiClient.defaults.adapter = originalAdapter; });
const asset = { id: "main-asset", project_id: "target", type: "image" as const, source_type: "reuse", status: "ready", lifecycle_status: "active", content_type: "image/png", file_name: "角色.png", file_size: 4, width: 2, height: 2 };
function ok(config: InternalAxiosRequestConfig, data: unknown) {
    return { config, data: { code: 0, data }, status: 200, statusText: "OK", headers: {} };
}
function missing(config: InternalAxiosRequestConfig) {
    return Object.assign(new Error("missing"), { isAxiosError: true, config, response: { status: 404, headers: {}, data: { code: 404001, message: "missing" } } });
}

test("imports authenticated main asset bytes and registers the same ID before canvas insertion", async () => {
    const calls: string[] = [];
    let mapped: Record<string, any> | undefined;
    apiClient.defaults.adapter = async (config) => {
        calls.push(`${config.method} ${config.url}`);
        if (config.url === "/v1/assets/main-asset") return ok(config, asset);
        if (config.url === "/assets/main-asset" && config.method === "get") throw missing(config);
        if (config.url === "/v1/novtv/assets/main-asset/content") {
            expect(config.baseURL).toBe("/api");
            return { config, data: new Blob(["data"], { type: "image/png" }), status: 200, statusText: "OK", headers: {} };
        }
        if (config.url === "/resources") {
            expect(config.data).toBeInstanceOf(FormData);
            expect(config.headers.get("X-Idempotency-Key")).toBe("novai-asset-main-asset");
            return ok(config, { resource: { id: "execution-resource", status: "ready" } });
        }
        mapped = JSON.parse(config.data).asset;
        return ok(config, { asset: mapped });
    };
    const result = await prepareNovaiPlatformResource("main-asset", "target");
    expect(result.storageKey).toBe("resource:execution-resource");
    expect(mapped).toMatchObject({ id: "main-asset", kind: "image", metadata: { novaiProjectId: "target", novaiAssetId: "main-asset" }, data: { storageKey: result.storageKey } });
    expect(calls).toEqual(["get /v1/assets/main-asset", "get /assets/main-asset", "get /v1/novtv/assets/main-asset/content", "post /resources", "put /assets/main-asset"]);
});

test("revalidates ownership and lifecycle even when an execution copy is already present", async () => {
    let current = { ...asset };
    const calls: string[] = [];
    apiClient.defaults.adapter = async (config) => { calls.push(config.url!); return ok(config, current); };
    await expect(prepareNovaiPlatformResource("main-asset", "another-project")).rejects.toThrow("不属于当前画布项目");
    current = { ...asset, lifecycle_status: "trashed" };
    await expect(prepareNovaiPlatformResource("main-asset", "target")).rejects.toThrow("失效");
    expect(calls).toEqual(["/v1/assets/main-asset", "/v1/assets/main-asset"]);
});

test("reuses a validated resource without transferring the same bytes again", async () => {
    const calls: string[] = [];
    apiClient.defaults.adapter = async (config) => {
        calls.push(config.url!);
        if (config.url === "/v1/assets/main-asset") return ok(config, asset);
        if (config.url === "/assets/main-asset") return ok(config, { asset: { metadata: { novaiProjectId: "target" }, data: { storageKey: "resource:cached-execution" } } });
        return ok(config, { resource: { id: "cached-execution", status: "ready" } });
    };
    expect(await prepareNovaiPlatformResource("main-asset", "target")).toMatchObject({ storageKey: "resource:cached-execution" });
    expect(calls).toEqual(["/v1/assets/main-asset", "/assets/main-asset", "/resources/cached-execution"]);
});

test("registers generated video and audio under their main project IDs", async () => {
    const records: any[] = [];
    apiClient.defaults.adapter = async (config) => { records.push(JSON.parse(config.data).asset); return ok(config, {}); };
    await registerNovaiPlatformResource({ ...asset, type: "video", content_type: "video/mp4", duration: 2.5 }, "resource:video-output");
    await registerNovaiPlatformResource({ ...asset, id: "audio-asset", type: "audio", content_type: "audio/mpeg", duration: 3 }, "resource:audio-output");
    expect(records[0]).toMatchObject({ id: "main-asset", kind: "video", data: { durationMs: 2500, storageKey: "resource:video-output" } });
    expect(records[1]).toMatchObject({ id: "audio-asset", kind: "audio", data: { durationMs: 3000, storageKey: "resource:audio-output" } });
});
