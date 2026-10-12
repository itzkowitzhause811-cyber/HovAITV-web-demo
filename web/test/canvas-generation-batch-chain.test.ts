import { describe, expect, test } from "bun:test";

import { generationBatchStatus, generationModeForBatchMode } from "../src/lib/canvas/canvas-generation-batch";
import type { CanvasGenerationBatch } from "../src/types/canvas";

function batch(items: CanvasGenerationBatch["items"], continuation?: CanvasGenerationBatch["continuation"]): CanvasGenerationBatch {
    return {
        id: "batch",
        projectId: "project",
        sourceNodeId: "script",
        mode: "storyboard_image",
        status: "queued",
        items,
        continuation,
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
    };
}

describe("canvas generation batch chain", () => {
    test("批次模式映射到对应的生成模式", () => {
        expect(generationModeForBatchMode("storyboard_image")).toBe("image");
        expect(generationModeForBatchMode("action_board")).toBe("image");
        expect(generationModeForBatchMode("batch_image")).toBe("image");
        expect(generationModeForBatchMode("storyboard_video")).toBe("video");
        expect(generationModeForBatchMode("storyboard_audio")).toBe("audio");
    });

    test("全部成功才算完成，携带接续配置不影响批次状态", () => {
        const completed = batch([{ id: "a", rowId: "r1", nodeId: "n1", status: "succeeded", retryCount: 0 }], { nextMode: "storyboard_video" });
        expect(generationBatchStatus(completed)).toBe("completed");
    });

    test("上游部分失败不会触发下游接续", () => {
        const partial = batch(
            [
                { id: "a", rowId: "r1", nodeId: "n1", status: "succeeded", retryCount: 0 },
                { id: "b", rowId: "r2", nodeId: "n2", status: "failed", retryCount: 0, errorDetails: "生成失败" },
            ],
            { nextMode: "storyboard_video" },
        );
        expect(generationBatchStatus(partial)).toBe("partial_failed");
    });

    test("含排队项的视频批次仍处于运行态，配音批次只在全部成功后接续", () => {
        const running = batch(
            [
                { id: "a", rowId: "r1", nodeId: "v1", status: "succeeded", retryCount: 0 },
                { id: "b", rowId: "r2", nodeId: "v2", status: "running", retryCount: 0 },
            ],
            { nextMode: "storyboard_audio" },
        );
        expect(generationBatchStatus(running)).toBe("running");
    });
});
