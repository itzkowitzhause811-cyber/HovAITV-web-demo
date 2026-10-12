import { novaiAuthApi, type NovaiAuthStatus } from "@/services/api/novai-auth";

export type NovaiSessionResult = { status: "ready"; userId: string } | { status: "redirecting" };

type SessionLocation = {
    href: string;
    assign: (url: string) => void;
    replace: (url: string) => void;
    clearCallback: () => void;
};

function loginDestination(value: string, base: string) {
    const url = new URL(value, base);
    if (!value || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("平台登录地址无效");
    return url.toString();
}

export async function initializeNovaiSession(api: typeof novaiAuthApi, location: SessionLocation): Promise<NovaiSessionResult> {
    const url = new URL(location.href);
    let status: NovaiAuthStatus;
    if (url.pathname === "/sso/callback") {
        const handoff = new URLSearchParams(url.hash.slice(1));
        const code = handoff.get("handoff_code") || "";
        const handoffState = handoff.get("state") || "";
        const ticket = url.searchParams.get("ticket") || "";
        const appId = url.searchParams.get("app_id") || "";
        if (code && handoffState) {
            // Clear one-use handoff secrets before rendering or diagnostics.
            location.clearCallback();
            status = await api.handoffLogin({ code, state: handoffState });
        } else if (ticket && appId) {
            status = await api.ticketLogin({ ticket, app_id: appId, state: url.searchParams.get("state") || undefined });
        } else {
            throw new Error("登录回调信息不完整，请重新登录");
        }
        if (status.handoff_url) {
            location.replace(loginDestination(status.handoff_url, location.href));
            return { status: "redirecting" };
        }
        location.clearCallback();
    } else {
        status = await api.status();
    }
    if (!status.enabled) throw new Error("登录服务未启用，请联系管理员检查部署配置");
    if (!status.authenticated || !status.user) {
        const login = await api.loginUrl();
        if (!login.enabled) throw new Error("登录服务未启用，请联系管理员检查部署配置");
        location.assign(loginDestination(login.login_url, location.href));
        return { status: "redirecting" };
    }
    if (status.model_access_enabled === false) throw new Error(status.model_access_reason || "当前账号暂时无法使用模型服务，请重新登录或联系管理员");
    return { status: "ready", userId: status.user.id };
}

let sessionBootstrap: Promise<NovaiSessionResult> | undefined;
let sessionUserId = "";

export function getNovaiSessionUserId() {
    return sessionUserId;
}

export function bootstrapNovaiSession() {
    if (!sessionBootstrap) {
        sessionBootstrap = initializeNovaiSession(novaiAuthApi, {
            href: window.location.href,
            assign: (url) => window.location.assign(url),
            replace: (url) => window.location.replace(url),
            clearCallback: () => window.history.replaceState(null, "", "/"),
        }).then((result) => {
            sessionUserId = result.status === "ready" ? result.userId : "";
            return result;
        }).catch((error: unknown) => {
            sessionBootstrap = undefined;
            sessionUserId = "";
            throw error;
        });
    }
    return sessionBootstrap;
}

export function resetNovaiSessionBootstrap() {
    sessionBootstrap = undefined;
    sessionUserId = "";
}
