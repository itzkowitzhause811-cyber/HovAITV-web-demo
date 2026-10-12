import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const source = (name: string) => readFileSync(resolve(import.meta.dir, `../src/pages/canvas/${name}`), "utf8");

describe("storyboard chain wiring boundaries", () => {
    test("project 将批次完成事件接到视频续链与配音续链", () => {
        const project = source("project.tsx");
        expect(project).toContain("onBatchCompleted: handleBatchCompleted");
        expect(project).toContain('nextMode === "storyboard_video"');
        expect(project).toContain('continuation: { nextMode: "storyboard_audio" }');
        expect(project).toContain("createAndGenerateScriptAudios(sourceNodeId, undefined, { skipConfirmation: true })");
    });

    test("storyboard hook 提供三镜链入口与配音节点创建", () => {
        const hook = source("use-canvas-storyboard.ts");
        expect(hook).toContain('enqueueGenerationBatch(nodeId, "storyboard_audio"');
        expect(hook).toContain("generateScriptChain");
        expect(hook).toContain("createScriptAudioNodes");
        expect(hook).toContain('continuation: { nextMode: "storyboard_video" }');
    });

    test("批次完成 effect 先持久化 triggered 再触发回调，刷新后不重复续链", () => {
        const batches = source("use-canvas-generation-batches.ts");
        expect(batches).toContain("batch.continuation.triggered");
        expect(batches).toContain("onBatchCompletedRef");
        expect(batches).toContain('continuation: { ...batch.continuation, triggered: true }');
        expect(batches).toContain("window.setTimeout");
    });

    test("分镜面板暴露三镜链与配音入口", () => {
        const panel = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-script-node.tsx"), "utf8");
        expect(panel).toContain("一键生成三镜链（图 → 视频 → 配音）");
        expect(panel).toContain("生成未完成配音");
        expect(panel).toContain("storyboard_audio");
    });
});
