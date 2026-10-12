import { expect, test } from "bun:test";

async function source(path: string) {
    return Bun.file(new URL(path, import.meta.url)).text();
}

test("unfinished Skill marketplace routes stay unavailable in the public workspace", async () => {
    const [workspaceRoutes, sidebar] = await Promise.all([
        source("../src/workspace-routes.tsx"),
        source("../src/components/layout/workspace-sidebar-nav.tsx"),
    ]);
    expect(workspaceRoutes).toContain('{ path: "/skill", element: <Navigate to="/" replace /> }');
    expect(workspaceRoutes).toContain('{ path: "/skills", element: <Navigate to="/" replace /> }');
    expect(workspaceRoutes).not.toContain("SkillsReferencePage");
    expect(workspaceRoutes).not.toContain("SkillsPage");
    expect(sidebar).not.toContain('id: "skill", title: "Skill"');
});
