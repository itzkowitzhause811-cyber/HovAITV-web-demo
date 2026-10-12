import { useEffect, useState, type ReactNode } from "react";

import { WorkspaceErrorState } from "@/components/layout/workspace-state";
import { FullScreenLoader } from "@/components/ui/aceternity/full-screen-loader";
import { apiClient } from "@/services/api/request";
import { bootstrapNovaiSession, resetNovaiSessionBootstrap } from "@/services/novai-session-bootstrap";

export function NovaiSessionBoundary({ children }: { children: ReactNode }) {
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setError("");
        void bootstrapNovaiSession().then((result) => {
            if (!cancelled && result.status === "ready") setReady(true);
        }).catch((reason: unknown) => {
            if (!cancelled) setError(reason instanceof Error ? reason.message : "无法检查登录状态，请重试");
        });
        return () => { cancelled = true; };
    }, [attempt]);

    useEffect(() => {
        if (!ready) return;
        const interceptor = apiClient.interceptors.response.use(undefined, (reason: unknown) => {
            if ((reason as { response?: { status?: number } })?.response?.status === 401) {
                // A fresh document discards in-memory stores before a new account can hydrate.
                resetNovaiSessionBootstrap();
                window.location.reload();
            }
            return Promise.reject(reason);
        });
        return () => { apiClient.interceptors.response.eject(interceptor); };
    }, [ready]);

    if (error) return <div className="flex min-h-screen items-center justify-center"><WorkspaceErrorState title="无法进入工作区" description={error} onRetry={() => setAttempt((value) => value + 1)} /></div>;
    return ready ? children : <FullScreenLoader label="正在检查平台登录" detail="确认账号与模型权限" />;
}
