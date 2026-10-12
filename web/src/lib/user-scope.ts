import { NOVAI_PLATFORM_ENABLED } from "@/lib/novai-platform";

const ACTIVE_USER_SCOPE_KEY = "infinite-canvas:active-user-scope";
const GUEST_SCOPE = "guest";
let activePlatformScope: string | undefined;

export function getActiveUserScope() {
    if (typeof window === "undefined") return GUEST_SCOPE;
    if (NOVAI_PLATFORM_ENABLED && activePlatformScope) return activePlatformScope;
    try {
        return window.localStorage?.getItem(ACTIVE_USER_SCOPE_KEY) || GUEST_SCOPE;
    } catch {
        // Desktop shells, privacy modes and test harnesses may expose a window
        // without a usable Storage implementation. Local data must still use a
        // deterministic guest namespace instead of breaking uploads/cache keys.
        return GUEST_SCOPE;
    }
}

export function setActiveUserScope(userId?: string | null) {
    if (typeof window === "undefined") return;
    // Platform identity remains bound to this document even if Storage is
    // blocked or another tab updates its persisted active-account pointer.
    if (NOVAI_PLATFORM_ENABLED) activePlatformScope = userId || GUEST_SCOPE;
    try {
        window.localStorage?.setItem(ACTIVE_USER_SCOPE_KEY, userId || GUEST_SCOPE);
    } catch {
        // Scope persistence is best effort; callers can continue in guest mode.
    }
}

export function scopedStorageKey(name: string, scope = getActiveUserScope()) {
    return `${name}:user:${scope}`;
}

export const scopedLocalStorage = {
    getItem: (name: string) => {
        if (typeof window === "undefined") return null;
        try {
            return window.localStorage?.getItem(scopedStorageKey(name)) ?? null;
        } catch {
            return null;
        }
    },
    setItem: (name: string, value: string) => {
        if (typeof window === "undefined") return;
        try {
            window.localStorage?.setItem(scopedStorageKey(name), value);
        } catch {
            // UI preferences are optional and must not block local creation.
        }
    },
    removeItem: (name: string) => {
        if (typeof window === "undefined") return;
        try {
            window.localStorage?.removeItem(scopedStorageKey(name));
        } catch {
            // Best effort cleanup when browser storage is unavailable.
        }
    },
};
