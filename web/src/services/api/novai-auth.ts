import { ApiError, http } from "@/services/api/request";

export type NovaiAuthUser = { id: string; username: string; display_name: string };
export type NovaiAuthStatus = {
    enabled: boolean;
    authenticated: boolean;
    user: NovaiAuthUser | null;
    model_access_enabled?: boolean;
    model_access_reason?: string;
    handoff_url?: string;
};

type NovaiEnvelope<T> = { code: number; data: T; message?: string; msg?: string };

function objectValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseNovaiAuthStatus(value: unknown): NovaiAuthStatus {
    const status = objectValue(value);
    if (!status || typeof status.enabled !== "boolean" || typeof status.authenticated !== "boolean") {
        throw new ApiError("登录服务返回了无效的账号状态");
    }
    const candidate = objectValue(status.user);
    const user = typeof candidate?.id === "string" && candidate.id.trim()
        ? { id: candidate.id, username: typeof candidate.username === "string" ? candidate.username : "", display_name: typeof candidate.display_name === "string" ? candidate.display_name : "" }
        : null;
    return {
        enabled: status.enabled,
        authenticated: status.authenticated && user !== null,
        user,
        ...(typeof status.model_access_enabled === "boolean" ? { model_access_enabled: status.model_access_enabled } : {}),
        ...(typeof status.model_access_reason === "string" ? { model_access_reason: status.model_access_reason } : {}),
        ...(typeof status.handoff_url === "string" && status.handoff_url ? { handoff_url: status.handoff_url } : {}),
    };
}

async function novaiAuthRequest<T>(path: string, data?: unknown) {
    // Platform accounts use their own API, independently of the canvas namespace.
    const response = await http.raw<NovaiEnvelope<T>>({ baseURL: "/api", url: `/v1/auth/${path}`, method: data === undefined ? "get" : "post", data });
    if (response.data.code !== 0) throw new ApiError(response.data.message || response.data.msg || "平台登录失败", { code: response.data.code, status: response.status });
    return response.data.data;
}

export const novaiAuthApi = {
    status: () => novaiAuthRequest<unknown>("status").then(parseNovaiAuthStatus),
    loginUrl: () => novaiAuthRequest<{ enabled: boolean; login_url: string }>("login-url"),
    ticketLogin: (payload: { ticket: string; app_id: string; state?: string }) => novaiAuthRequest<unknown>("ticket-login", payload).then(parseNovaiAuthStatus),
    handoffLogin: (payload: { code: string; state: string }) => novaiAuthRequest<unknown>("local-handoff/login", payload).then(parseNovaiAuthStatus),
};
