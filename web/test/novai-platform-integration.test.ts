import { describe, expect, test } from "bun:test";

import { initializeWorkspaceState } from "../src/components/workspace/workspace-bootstrap-hydrator";
import { audioSpeechProfile } from "../src/lib/audio-generation";
import { hasNovaiPlatformCredential, isNovaiPlatformChannel, NOVAI_PLATFORM_ENABLED, novaiWorkspaceScope } from "../src/lib/novai-platform";
import { getActiveUserScope, setActiveUserScope } from "../src/lib/user-scope";
import { localWorkspaceConfig } from "../src/lib/user-session";
import { mergeNovaiPlatformCatalog } from "../src/pages/settings/channel-settings-pane";
import { parseNovaiAuthStatus, type NovaiAuthStatus, novaiAuthApi } from "../src/services/api/novai-auth";
import { apiClient, http } from "../src/services/api/request";
import { backendProviderConfig, prepareBackendGenerationTask } from "../src/services/api/generation-task";
import { initializeNovaiSession } from "../src/services/novai-session-bootstrap";
import { channelHasGenerationCredential, createModelChannel, defaultConfig, modelDisplayName, type AiConfig } from "../src/stores/use-config-store";

const signedIn: NovaiAuthStatus = { enabled: true, authenticated: true, user: { id: "account-1", username: "creator", display_name: "创作者" } };

function sessionHarness(href = "https://workbench.example/canvas/project-1", status: NovaiAuthStatus = signedIn) {
    const calls: string[] = [];
    const api: typeof novaiAuthApi = {
        status: async () => { calls.push("status"); return status; },
        loginUrl: async () => { calls.push("login-url"); return { enabled: true, login_url: "https://platform.example/login" }; },
        ticketLogin: async (payload) => { calls.push(`ticket:${JSON.stringify(payload)}`); return status; },
        handoffLogin: async (payload) => { calls.push(`handoff:${JSON.stringify(payload)}`); return status; },
    };
    const location = {
        href,
        assign: (url: string) => { calls.push(`assign:${url}`); },
        replace: (url: string) => { calls.push(`replace:${url}`); },
        clearCallback: () => { calls.push("clear-callback"); },
    };
    return { api, location, calls };
}

describe("Novai session before HovAI workspace startup", () => {
    test("platform login stays on its original API when the canvas namespace changes", async () => {
        const adapter = apiClient.defaults.adapter;
        const baseURL = apiClient.defaults.baseURL;
        const urls: string[] = [];
        try {
            apiClient.defaults.baseURL = "/api/v1/novtv/workspace";
            apiClient.defaults.adapter = async (config) => {
                urls.push(apiClient.getUri(config));
                return { data: { code: 0, data: signedIn }, status: 200, statusText: "OK", headers: {}, config };
            };
            expect(await novaiAuthApi.status()).toEqual(signedIn);
            await http.get("/workspace/bootstrap");
            expect(urls).toEqual(["/api/v1/auth/status", "/api/v1/novtv/workspace/workspace/bootstrap"]);
            expect(apiClient.defaults.baseURL).toBe("/api/v1/novtv/workspace");
        } finally {
            apiClient.defaults.adapter = adapter;
            apiClient.defaults.baseURL = baseURL;
        }
    });
    test("browser cache scope binds both the platform account and original HovAI workspace", () => {
        expect(novaiWorkspaceScope("account-1", "workspace-1", "workspace-1")).toBe("novai:account-1:workspace-1");
        expect(novaiWorkspaceScope("account-2", "workspace-1", "workspace-1")).not.toBe(novaiWorkspaceScope("account-1", "workspace-1", "workspace-1"));
        expect(() => novaiWorkspaceScope("", "workspace-1", "workspace-1")).toThrow("身份未就绪");
        expect(() => novaiWorkspaceScope("account-1", "workspace-1", "foreign-principal")).toThrow("身份未就绪");
    });

    test("platform cache identity stays isolated when browser Storage is unavailable", () => {
        if (!NOVAI_PLATFORM_ENABLED) return;
        const originalWindow = globalThis.window;
        const previousScope = getActiveUserScope();
        try {
            globalThis.window = { localStorage: { getItem: () => { throw new Error("Storage denied"); }, setItem: () => { throw new Error("Storage denied"); } } } as unknown as Window & typeof globalThis;
            setActiveUserScope("novai:account-1:workspace-1");
            expect(getActiveUserScope()).toBe("novai:account-1:workspace-1");
            setActiveUserScope("novai:account-2:workspace-2");
            expect(getActiveUserScope()).toBe("novai:account-2:workspace-2");
        } finally {
            setActiveUserScope(previousScope);
            if (originalWindow) globalThis.window = originalWindow;
            else Reflect.deleteProperty(globalThis, "window");
        }
    });
    test("parsing rejects malformed sessions and does not authenticate a missing account", () => {
        expect(() => parseNovaiAuthStatus({})).toThrow("无效的账号状态");
        expect(parseNovaiAuthStatus({ enabled: true, authenticated: true, user: null }).authenticated).toBe(false);
    });

    test("signed-in users keep the original deep route", async () => {
        const harness = sessionHarness();
        expect(await initializeNovaiSession(harness.api, harness.location)).toEqual({ status: "ready", userId: "account-1" });
        expect(harness.calls).toEqual(["status"]);
    });

    test("signed-out users use the existing platform login URL", async () => {
        const harness = sessionHarness(undefined, { enabled: true, authenticated: false, user: null });
        expect(await initializeNovaiSession(harness.api, harness.location)).toEqual({ status: "redirecting" });
        expect(harness.calls).toEqual(["status", "login-url", "assign:https://platform.example/login"]);
    });

    test("disabled auth and denied model access never open an anonymous workspace", async () => {
        const disabled = sessionHarness(undefined, { enabled: false, authenticated: false, user: null });
        await expect(initializeNovaiSession(disabled.api, disabled.location)).rejects.toThrow("登录服务未启用");
        const denied = sessionHarness(undefined, { ...signedIn, model_access_enabled: false, model_access_reason: "模型权限已到期" });
        await expect(initializeNovaiSession(denied.api, denied.location)).rejects.toThrow("模型权限已到期");
        expect(denied.calls).toEqual(["status"]);
    });

    test("ticket callback preserves the platform auth payload and strips its URL", async () => {
        const harness = sessionHarness("https://workbench.example/sso/callback?ticket=one-use&app_id=novai&state=csrf");
        expect(await initializeNovaiSession(harness.api, harness.location)).toEqual({ status: "ready", userId: "account-1" });
        expect(harness.calls).toEqual(['ticket:{"ticket":"one-use","app_id":"novai","state":"csrf"}', "clear-callback"]);
    });

    test("local handoff secrets are cleared before the login request", async () => {
        const harness = sessionHarness("https://workbench.example/sso/callback#handoff_code=local-code&state=csrf");
        await initializeNovaiSession(harness.api, harness.location);
        expect(harness.calls).toEqual(["clear-callback", 'handoff:{"code":"local-code","state":"csrf"}', "clear-callback"]);
    });

    test("platform handoff redirects before the original workspace is mounted", async () => {
        const harness = sessionHarness("https://workbench.example/sso/callback?ticket=ticket&app_id=novai", { ...signedIn, handoff_url: "https://local.example/sso/callback#handoff_code=next&state=csrf" });
        expect(await initializeNovaiSession(harness.api, harness.location)).toEqual({ status: "redirecting" });
        expect(harness.calls.at(-1)).toBe("replace:https://local.example/sso/callback#handoff_code=next&state=csrf");
    });

    test("incomplete callbacks and unsafe login destinations fail visibly", async () => {
        const missing = sessionHarness("https://workbench.example/sso/callback?ticket=incomplete");
        await expect(initializeNovaiSession(missing.api, missing.location)).rejects.toThrow("登录回调信息不完整");
        expect(missing.calls).toEqual([]);
        const unsafe = sessionHarness(undefined, { enabled: true, authenticated: false, user: null });
        unsafe.api.loginUrl = async () => ({ enabled: true, login_url: "javascript:alert(1)" });
        await expect(initializeNovaiSession(unsafe.api, unsafe.location)).rejects.toThrow("平台登录地址无效");
    });

    test("platform bootstrap failures do not run local fallback or hydrate stale models", async () => {
        const calls: string[] = [];
        await expect(initializeWorkspaceState({
            allowLocalFallback: false,
            loadWorkspace: async () => { throw new Error("gateway unavailable"); },
            createLocalWorkspace: () => { calls.push("anonymous"); return {}; },
            applySession: async () => { calls.push("session"); },
            restoreModelConfig: async () => { calls.push("model-config"); },
        })).rejects.toThrow("gateway unavailable");
        expect(calls).toEqual([]);
    });

    test("platform models hydrate only after the authenticated workspace scope", async () => {
        const calls: string[] = [];
        await initializeWorkspaceState({
            allowLocalFallback: false,
            loadWorkspace: async () => { calls.push("workspace"); return { id: "account-1" }; },
            createLocalWorkspace: () => { throw new Error("unexpected fallback"); },
            applySession: async () => { calls.push("session"); },
            restoreModelConfig: async () => { calls.push("model-config"); },
        });
        expect(calls).toEqual(["workspace", "session", "model-config"]);
    });
});

function platformChannel() {
    return createModelChannel({
        id: "novai-platform", name: "NovAI 平台模型", scope: "system", pinned: true,
        baseUrl: "/api/ai/system/novai", apiKey: "", credentialRef: "novai-hovaitv:opaque-account-version", hasApiKey: true,
        models: ["novai-text", "novai-image", "novai-video", "novai-audio"],
        modelProfiles: [
            { model: "novai-text", displayName: "平台文本模型", capability: "text", protocol: "openai-chat" },
            { model: "novai-image", displayName: "平台图片模型", capability: "image", protocol: "openai-image" },
            { model: "novai-video", displayName: "平台视频模型", capability: "video", protocol: "volcengine-ark-video" },
            { model: "novai-audio", displayName: "平台音频模型", capability: "audio", protocol: "openai-audio", defaultOptions: { voice: "alloy", response_format: "wav", speed: 1 } },
        ],
    });
}

describe("Novai platform model projection", () => {
    test("opaque managed credentials require the exact platform channel and active permission", () => {
        const channel = platformChannel();
        expect(isNovaiPlatformChannel(channel)).toBe(true);
        expect(hasNovaiPlatformCredential(channel)).toBe(true);
        expect(channelHasGenerationCredential(channel, true)).toBe(true);
        expect(channelHasGenerationCredential(channel, false)).toBe(false);
        expect(hasNovaiPlatformCredential({ ...channel, hasApiKey: false })).toBe(false);
        expect(isNovaiPlatformChannel({ ...channel, id: "user-defined" })).toBe(false);
        expect(isNovaiPlatformChannel({ ...channel, credentialRef: "novai-hovaitv:" })).toBe(false);
    });

    test("platform config keeps projected models and personal channels while removing HovAIAPI defaults", () => {
        const config = localWorkspaceConfig({ ...defaultConfig, channels: [platformChannel(), createModelChannel({ id: "hovaiapi", pinned: true }), createModelChannel({ id: "personal", models: ["custom"] })] }, true);
        expect(config.channels.map((channel) => channel.id)).toEqual(["novai-platform", "personal"]);
        expect(config.textModels).toContain("novai-platform::novai-text");
        expect(config.imageModels).toContain("novai-platform::novai-image");
        expect(config.videoModels).toContain("novai-platform::novai-video");
        expect(config.audioModels).toContain("novai-platform::novai-audio");
        expect(modelDisplayName(config, "novai-platform::novai-audio")).toBe("平台音频模型");
        expect(config.channels[0]?.apiKey).toBe("");
    });

    test("original task input carries the scoped ref with no upstream key", () => {
        const config: AiConfig = { ...defaultConfig, channels: [platformChannel()], model: "novai-platform::novai-audio", audioFormat: "wav" };
        expect(backendProviderConfig(config, "audio")).toMatchObject({ channelId: "novai-platform", credentialRef: "novai-hovaitv:opaque-account-version", apiKey: "", secretKey: "", model: "novai-audio", audioFormat: "wav" });
    });

    test("original complete task snapshots preserve text history and platform selection for every capability", async () => {
        const history = [{ role: "user" as const, content: "请解释镜头景别，不要生成剧本" }];
        for (const mode of ["text", "image", "video", "audio"] as const) {
            const config: AiConfig = { ...defaultConfig, channels: [platformChannel()], model: `novai-platform::novai-${mode}`, audioFormat: "wav" };
            const task = await prepareBackendGenerationTask({ projectId: "canvas-owned", mode, prompt: "保留用户原始输入", config, textHistory: history });
            expect(task).toMatchObject({ projectId: "canvas-owned", type: `canvas_${mode}`, prompt: "保留用户原始输入", model: `novai-platform::novai-${mode}` });
            expect(task.input).toMatchObject({ mode, prompt: "保留用户原始输入", textHistory: history, config: { channelId: "novai-platform", model: `novai-${mode}`, credentialRef: "novai-hovaitv:opaque-account-version", apiKey: "", secretKey: "" } });
        }
    });

    test("catalog refresh replaces platform ref and preserves in-progress personal edits", () => {
        const current: AiConfig = { ...defaultConfig, imageModel: "personal::custom", channels: [platformChannel(), createModelChannel({ id: "personal", name: "工作室", models: ["custom"], modelProfiles: [{ model: "custom", capability: "image" }], apiKey: "personal-key" })] };
        const server: AiConfig = { ...defaultConfig, channels: [{ ...platformChannel(), credentialRef: "novai-hovaitv:new-version" }] };
        const merged = mergeNovaiPlatformCatalog(current, server);
        expect(merged.channels[0]?.credentialRef).toBe("novai-hovaitv:new-version");
        expect(merged.channels[1]?.name).toBe("工作室");
        expect(merged.channels[1]?.apiKey).toBe("personal-key");
        expect(merged.imageModel).toBe("personal::custom");
    });

    test("platform speech UI exposes only the currently supported options", () => {
        const profile = audioSpeechProfile("novai-platform::novai-audio", true);
        expect(profile.voices.map((voice) => voice.value)).toEqual(["alloy"]);
        expect(profile.formats.map((format) => format.value)).toEqual(["wav"]);
        expect(profile.speedMin).toBe(1);
        expect(profile.speedMax).toBe(1);
        expect(profile.showInstructions).toBe(false);
        expect(audioSpeechProfile("personal::gpt-4o-mini-tts", false).formats.some((format) => format.value === "mp3")).toBe(true);
    });
});
