import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const noop = () => {};
const node: CanvasNodeData = {
    id: "text-1",
    type: CanvasNodeType.Text,
    title: "文本节点",
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    metadata: { content: "测试内容" },
};

function renderMenu(onSendToAgent?: () => void) {
    return renderToStaticMarkup(
        <CanvasNodeContextMenu
            menu={{ type: "node", nodeId: node.id, x: 12, y: 80 }}
            node={node}
            canUndo
            canRedo
            canPaste
            onClose={noop}
            onAddNode={noop}
            onAddFolder={noop}
            onChooseStyle={noop}
            onOpenDirector={noop}
            onUpload={noop}
            onOpenAssets={noop}
            onOpenProjectCharacters={noop}
            onOpenGenerationHistory={noop}
            onUndo={noop}
            onRedo={noop}
            onPaste={noop}
            onCopyNode={noop}
            onCreateGenerationCopy={noop}
            onDuplicate={noop}
            onDelete={noop}
            onSaveAsset={noop}
            onViewMedia={noop}
            onEditText={noop}
            onOpenDrawing={noop}
            onGenerateImage={noop}
            onCopyContent={noop}
            onCopyMediaUrl={noop}
            onUploadToArkPrivateAsset={noop}
            onSetAssetCategory={noop}
            onToggleFrame={noop}
            onSendToAgent={onSendToAgent}
        />,
    );
}

describe("canvas context menu Agent capability", () => {
    test("omits the Agent action when the host workspace does not expose it", () => {
        expect(renderMenu()).not.toContain("发送到 Agent");
    });

    test("keeps the standalone Agent action when a handler is provided", () => {
        expect(renderMenu(noop)).toContain("发送到 Agent");
    });
});
