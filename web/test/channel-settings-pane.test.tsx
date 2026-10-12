import { expect, test } from "bun:test";
import { mergeManagedHovAIAPICatalog, modelConfigChannelPresentation, modelConfigChannelStatusLabel, shouldRefreshHovAIAPICatalog } from "../src/pages/settings/channel-settings-pane";
import { createModelChannel, defaultConfig } from "../src/stores/use-config-store";

test("pinned HovAIAPI is visible and cannot be deleted before models are fetched", () => {
    const channel = createModelChannel({
        id: "hovaiapi",
        name: "HovAIAPI",
        baseUrl: "https://enterprise.hovaiapi.com",
        apiKey: "",
        models: [],
        pinned: true,
        presetVersion: 1,
    });
    expect(modelConfigChannelPresentation(channel)).toEqual({ builtin: true, deletable: false, adapterLabel: "应用内置适配 · v1" });
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 0, dirty: false, error: "" })).toBe("未连接");
});

test("HovAIAPI status copy reflects enterprise connection state", () => {
    const channel = createModelChannel({ id: "hovaiapi", apiKey: "", pinned: true, presetVersion: 1 });
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 1, dirty: false, error: "" }, { state: "pending", userCode: "ABCD-EFGH", hasCredential: false })).toBe("请在浏览器中确认 ABCD-EFGH");
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 2, dirty: false, error: "" }, { state: "connected", account: { id: "acct-1", display_name: "Ender" }, hasCredential: true })).toBe("已连接 Ender");
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 2, dirty: false, error: "" }, { state: "revoked", hasCredential: true })).toBe("连接已失效，请重新连接");
});

test("HovAIAPI connected transition refreshes the managed catalog", () => {
    expect(shouldRefreshHovAIAPICatalog("pending", "connected")).toBe(true);
    expect(shouldRefreshHovAIAPICatalog(undefined, "connected")).toBe(true);
    expect(shouldRefreshHovAIAPICatalog("connected", "connected")).toBe(false);
    expect(shouldRefreshHovAIAPICatalog("connected", "disconnected")).toBe(true);
    expect(shouldRefreshHovAIAPICatalog("catalog_failed", "disconnected")).toBe(true);
    expect(shouldRefreshHovAIAPICatalog("pending", "pending")).toBe(false);
    expect(shouldRefreshHovAIAPICatalog(undefined, "disconnected")).toBe(false);
});

test("HovAIAPI catalog merge keeps manual providers and user-owned HovAIAPI fields", () => {
    const current = {
        ...defaultConfig,
        imageModel: "manual::local-image",
        channels: [
            createModelChannel({
                id: "hovaiapi",
                name: "HovAIAPI",
                pinned: true,
                enabled: false,
                models: ["stale-image"],
                modelProfiles: [{ model: "stale-image", capability: "image" }],
            }),
            createModelChannel({ id: "manual", name: "工作室渠道", apiKey: "manual-key", models: ["local-image"], modelProfiles: [{ model: "local-image", capability: "image" }] }),
        ],
    };
    const server = {
        ...defaultConfig,
        channels: [
            createModelChannel({
                id: "hovaiapi",
                name: "HovAIAPI",
                pinned: true,
                credentialRef: "hovaiapi-enterprise",
                hasApiKey: true,
                models: ["enterprise-image"],
                modelProfiles: [{ model: "enterprise-image", capability: "image", protocol: "openai-image" }],
            }),
            createModelChannel({ id: "manual", name: "旧名称", apiKey: "old-key", models: ["old-image"] }),
        ],
    };
    const merged = mergeManagedHovAIAPICatalog(current, server);
    const hovai = merged.channels.find((channel) => channel.id === "hovaiapi");
    const manual = merged.channels.find((channel) => channel.id === "manual");
    expect(hovai?.models).toEqual(["enterprise-image"]);
    expect(hovai?.modelProfiles?.[0]?.protocol).toBe("openai-image");
    expect(hovai?.credentialRef).toBe("hovaiapi-enterprise");
    expect(hovai?.enabled).toBe(false);
    expect(hovai?.apiKey).toBe("");
    expect(manual?.name).toBe("工作室渠道");
    expect(manual?.apiKey).toBe("manual-key");
    expect(manual?.models).toEqual(["local-image"]);
    expect(merged.imageModel).toBe("manual::local-image");
});
