import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");

describe("NovAI platform asset entry", () => {
    test("opens the unified project asset library from the canvas asset dock", () => {
        const tray = read("../src/components/canvas/canvas-asset-tray.tsx");
        const project = read("../src/pages/canvas/project.tsx");

        expect(tray).toContain("onOpenAssetLibrary?: () => void");
        expect(tray).toContain("if (onOpenAssetLibrary)");
        expect(tray).toContain("onOpenAssetLibrary();");
        expect(project).toContain("onOpenAssetLibrary={NOVAI_PLATFORM_ENABLED ? () => openUnifiedAssetLibrary() : undefined}");
        expect(project).not.toContain("onOpenAssetLibrary={currentProject?.projectId");
    });

    test("keeps the standalone asset tray toggle when no external library is supplied", () => {
        const tray = read("../src/components/canvas/canvas-asset-tray.tsx");

        expect(tray).toContain("setOpen((value) => !value)");
    });
});
