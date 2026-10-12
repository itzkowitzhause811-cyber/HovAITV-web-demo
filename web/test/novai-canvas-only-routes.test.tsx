import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import { matchRoutes, type RouteObject } from "react-router";

import { NovaiProjectLibrary, workspaceRoutes } from "../src/workspace-routes";

function matchedLeaf(routes: RouteObject[], pathname: string) {
    const matches = matchRoutes(routes, pathname);
    expect(matches, `no route matched ${pathname}`).not.toBeNull();
    const route = matches?.at(-1)?.route;
    const element = route?.element;
    if (!isValidElement(element)) throw new Error(`route ${pathname} has no React element`);
    return element;
}

describe("NovAI canvas-only workspace routes", () => {
    test("platform workspace keeps a real canvas route and sends all standalone pages back to the host project library", () => {
        const routes = workspaceRoutes(true);
        const canvas = matchedLeaf(routes, "/canvas/canvas-1");
        expect(canvas?.type).not.toBe(NovaiProjectLibrary);

        for (const pathname of [
            "/",
            "/canvas",
            "/projects",
            "/project",
            "/create",
            "/assets",
            "/settings",
            "/plugins",
            "/plugins/eagle",
            "/test-voice-recording",
            "/projects/project-1",
            "/projects/project-1/chapters/chapter-1",
            "/projects/project-1/workflow/unit-1/stage-1",
            "/project/project-1",
            "/unknown-hovai-page",
        ]) {
            expect(matchedLeaf(routes, pathname)?.type, pathname).toBe(NovaiProjectLibrary);
        }
    });

    test("standalone HovAI workspace remains available when platform integration is disabled", () => {
        const localRoutes = workspaceRoutes(false);
        for (const pathname of [
            "/",
            "/create",
            "/assets",
            "/settings",
            "/plugins",
            "/plugins/eagle",
            "/test-voice-recording",
            "/projects",
            "/projects/project-1",
            "/canvas",
            "/canvas/canvas-1",
        ]) {
            expect(matchedLeaf(localRoutes, pathname)?.type, pathname).not.toBe(NovaiProjectLibrary);
        }
        expect(matchedLeaf(localRoutes, "/unknown-hovai-page")?.type).not.toBe(NovaiProjectLibrary);
    });
});
