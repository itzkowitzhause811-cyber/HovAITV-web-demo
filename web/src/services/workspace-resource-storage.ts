import { isLocalRuntimeMode, isNativeDesktopRuntime } from "@/lib/runtime-mode";
import { NOVAI_PLATFORM_ENABLED } from "@/lib/novai-platform";

/**
 * Resource storage policy for the two local runtimes:
 * - native desktop: Go resource service is the durable local store;
 * - browser local: IndexedDB is the durable local store.
 * Hosted mode always attempts the remote resource API first.
 */
export function usesBrowserLocalResourceStore() {
    return !NOVAI_PLATFORM_ENABLED && isLocalRuntimeMode() && !isNativeDesktopRuntime();
}

export function usesNativeLocalResourceStore() {
    return isLocalRuntimeMode() && isNativeDesktopRuntime();
}
