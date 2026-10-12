import { http } from "@/services/api/request";

export type HovAIAPIAccount = {
    id: string;
    username?: string;
    display_name?: string;
    email?: string;
};

export type HovAIAPIConnectionState = "disconnected" | "pending" | "connected" | "expired" | "cancelled" | "rejected" | "store_error" | "catalog_failed" | "revoked";

export type HovAIAPIConnectionSummary = {
    state: HovAIAPIConnectionState | string;
    userCode?: string;
    verificationUri?: string;
    expiresAt?: string;
    account?: HovAIAPIAccount | null;
    keyName?: string;
    tokenId?: string;
    market?: string;
    walletUrl?: string;
    balance?: "unknown" | "zero" | "available" | string;
    catalogFailed?: boolean;
    errorReason?: string;
    connectedAt?: string;
    credentialRef?: string;
    hasCredential?: boolean;
};

export function getHovAIAPIConnection(signal?: AbortSignal) {
    return http.get<HovAIAPIConnectionSummary>("/hovaiapi/connection", { signal });
}

export function startHovAIAPIConnection(signal?: AbortSignal) {
    return http.post<HovAIAPIConnectionSummary>("/hovaiapi/connection/start", {}, { signal });
}

export function cancelHovAIAPIConnection(signal?: AbortSignal) {
    return http.post<HovAIAPIConnectionSummary>("/hovaiapi/connection/cancel", {}, { signal });
}

export function disconnectHovAIAPIConnection(signal?: AbortSignal) {
    return http.post<HovAIAPIConnectionSummary>("/hovaiapi/connection/disconnect", {}, { signal });
}

export function openHovAIAPIWallet(signal?: AbortSignal) {
    return http.post<{ opened: boolean }>("/hovaiapi/connection/open-wallet", {}, { signal });
}

export function hovAIAPIConnectionLabel(summary: HovAIAPIConnectionSummary | null | undefined) {
    const state = summary?.state || "disconnected";
    switch (state) {
        case "pending":
            return summary?.userCode ? `请在浏览器中确认 ${summary.userCode}` : "请在浏览器中确认授权";
        case "connected":
            return connectedAccountLabel(summary);
        case "expired":
            return "授权已过期，请重新连接";
        case "cancelled":
            return "已取消本次连接";
        case "rejected":
            return "授权被拒绝";
        case "store_error":
            return "保存连接失败，请重试";
        case "catalog_failed":
            return "模型列表读取失败，请重试";
        case "revoked":
            return "连接已失效，请重新连接";
        default:
            return "未连接";
    }
}

function connectedAccountLabel(summary: HovAIAPIConnectionSummary | null | undefined) {
    const account = summary?.account;
    const name = account?.display_name || account?.username || account?.email;
    if (name && summary?.balance === "zero") return `已连接 ${name}，余额为 0`;
    if (name) return `已连接 ${name}`;
    if (summary?.balance === "zero") return "已连接，余额为 0";
    return "已连接";
}
