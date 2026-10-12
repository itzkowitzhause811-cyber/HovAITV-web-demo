export const NOVAI_PLATFORM_ENABLED = import.meta.env.VITE_NOVAI_PLATFORM === "true";
export const NOVAI_PLATFORM_CHANNEL_ID = "novai-platform";
export const NOVAI_PLATFORM_CREDENTIAL_PREFIX = "novai-hovaitv:";

type PlatformChannel = {
    id: string;
    scope?: string;
    pinned?: boolean;
    credentialRef?: string;
    hasApiKey?: boolean;
};

export function isNovaiPlatformChannel(channel: PlatformChannel) {
    return channel.id === NOVAI_PLATFORM_CHANNEL_ID
        && channel.scope === "system"
        && channel.pinned === true
        && Boolean(channel.credentialRef?.startsWith(NOVAI_PLATFORM_CREDENTIAL_PREFIX)
            && channel.credentialRef.length > NOVAI_PLATFORM_CREDENTIAL_PREFIX.length);
}

export function hasNovaiPlatformCredential(channel: PlatformChannel) {
    return isNovaiPlatformChannel(channel) && channel.hasApiKey === true;
}

export function novaiWorkspaceScope(accountId: string, workspaceId: string, principalId: string) {
    if (!accountId.trim() || !workspaceId.trim() || principalId !== workspaceId) throw new Error("平台账号与工作区身份未就绪，请重新加载");
    return `novai:${encodeURIComponent(accountId)}:${encodeURIComponent(workspaceId)}`;
}
