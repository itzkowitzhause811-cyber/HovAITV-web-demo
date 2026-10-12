import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Outlet, useLocation, useParams, type RouteObject } from "react-router";

import { FullScreenLoader, WorkspaceRouteLoader } from "@/components/ui/aceternity/full-screen-loader";
import { loadAssetsPage, loadCanvasPage, loadCanvasProjectPage, loadCreatePage, loadHomePage, loadProjectDetailPage } from "@/lib/workspace-route-modules";
import { CanvasRefreshShell } from "@/pages/canvas/canvas-refresh-shell";
import RouteErrorPage from "@/pages/route-error";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";

export function NovaiProjectLibrary() {
    useEffect(() => { window.location.replace("/projects"); }, []);
    return <FullScreenLoader label="正在返回项目" detail="打开 NovAI 项目列表" />;
}

const AssetsPage = lazy(loadAssetsPage);
const HomePage = lazy(loadHomePage);
const CanvasPage = lazy(loadCanvasPage);
const CanvasProjectPage = lazy(loadCanvasProjectPage);
const CreatePage = lazy(loadCreatePage);
const NotFound = lazy(() => import("@/pages/not-found"));
const PluginsPage = lazy(() => import("@/pages/plugins"));
const EagleLibraryPage = lazy(() => import("@/pages/plugins/eagle"));
const ProjectDetailPage = lazy(loadProjectDetailPage);
const SettingsPage = lazy(() => import("@/pages/settings"));
const TestVoiceRecording = lazy(() => import("@/pages/test-voice-recording"));
const UserLayout = lazy(() => import("@/layouts/user-layout"));
const RequireFeature = lazy(() => import("@/components/workspace/require-feature").then((module) => ({ default: module.RequireFeature })));

function deferred(element: ReactNode) {
    return <Suspense fallback={<WorkspaceRouteLoader />}>{element}</Suspense>;
}

function fullScreenDeferred(element: ReactNode) {
    return <Suspense fallback={<FullScreenLoader label="正在打开创作空间" detail="准备当前页面" />}>{element}</Suspense>;
}

function WorkspaceLayout() {
    const { pathname } = useLocation();
    const isCanvasProjectRoute = pathname.startsWith("/canvas/");
    const fallback = isCanvasProjectRoute ? <CanvasRefreshShell /> : <FullScreenLoader label="正在打开创作空间" detail="准备当前页面" />;
    return <Suspense fallback={fallback}><UserLayout><Outlet /></UserLayout></Suspense>;
}

function LocalAwareProjectRoute() {
    const { projectId } = useParams();
    const localMode = isLocalWorkspaceMode();
    if (localMode && projectId) return <Navigate to={`/canvas/${projectId}`} replace />;
    return deferred(<ProjectDetailPage />);
}

function LegacyProjectAliasRoute() {
    const { projectId, "*": rest } = useParams();
    return <Navigate to={`/projects/${projectId}${rest ? `/${rest}` : ""}`} replace />;
}

/** DEV 专用实验室路由。动态 import 留在函数体内，生产构建能删除实验室代码。 */
function devRoutes(): RouteObject[] {
    const FolderPreviewLab = lazy(() => import("@/pages/dev/folder-preview-lab"));
    const DirectorReproLab = lazy(() => import("@/pages/dev/director-repro-lab"));
    return [
        { path: "/dev/folders", element: fullScreenDeferred(<FolderPreviewLab />), errorElement: <RouteErrorPage /> },
        { path: "/dev/director-repro", element: fullScreenDeferred(<DirectorReproLab />), errorElement: <RouteErrorPage /> },
    ];
}

/** NovTV 借用主站项目列表，只开放画布编辑器，不挂载 HovAITV 的站点页面。 */
export function workspaceRoutes(platformEnabled: boolean): RouteObject[] {
    if (platformEnabled) {
        return [
            {
                element: <WorkspaceLayout />,
                errorElement: <RouteErrorPage />,
                children: [{ path: "/canvas/:id", element: <CanvasProjectPage /> }],
            },
            { path: "*", element: <NovaiProjectLibrary /> },
        ];
    }

    return [
        ...(import.meta.env.DEV ? devRoutes() : []),
        {
            element: <WorkspaceLayout />,
            errorElement: <RouteErrorPage />,
            children: [
                { path: "/", element: deferred(<HomePage />) },
                { path: "/create", element: deferred(<CreatePage />) },
                { path: "/tasks", element: <Navigate to="/" replace /> },
                { path: "/assets", element: deferred(<AssetsPage />) },
                { path: "/skills", element: <Navigate to="/" replace /> },
                { path: "/skill", element: <Navigate to="/" replace /> },
                { path: "/skills/reference", element: <Navigate to="/" replace /> },
                {
                    path: "/plugins",
                    element: <RequireFeature feature="pluginCenterEnabled">{deferred(<PluginsPage />)}</RequireFeature>,
                },
                {
                    path: "/plugins/eagle",
                    element: <RequireFeature feature="pluginCenterEnabled">{deferred(<EagleLibraryPage />)}</RequireFeature>,
                },
                { path: "/settings", element: deferred(<SettingsPage />) },
                { path: "/test-voice-recording", element: deferred(<TestVoiceRecording />) },
                { path: "/projects", element: deferred(<CanvasPage />) },
                { path: "/project", element: deferred(<CanvasPage />) },
                { path: "/projects/:projectId", element: <LocalAwareProjectRoute /> },
                { path: "/project/:projectId", element: <LegacyProjectAliasRoute /> },
                { path: "/project/:projectId/*", element: <LegacyProjectAliasRoute /> },
                { path: "/projects/:projectId/:view", element: <LocalAwareProjectRoute /> },
                { path: "/projects/:projectId/chapters/:chapterId", element: <LocalAwareProjectRoute /> },
                { path: "/projects/:projectId/workflow/:unitId/:stage", element: <LocalAwareProjectRoute /> },
                { path: "/canvas", element: deferred(<CanvasPage />) },
                { path: "/canvas/:id", element: <CanvasProjectPage /> },
            ],
        },
        { path: "*", element: fullScreenDeferred(<NotFound />) },
    ];
}
