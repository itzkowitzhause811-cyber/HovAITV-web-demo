import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { bootstrapAppearance } from "@/services/appearance-bootstrap";
import { bootstrapDesktopRuntime } from "@/services/desktop-runtime";
import { hydrateLocalCanvasProjectsFromBackend } from "@/services/local-workspace-repository";
import { NOVAI_PLATFORM_ENABLED } from "@/lib/novai-platform";

async function startApplication() {
    await bootstrapDesktopRuntime();
    if (!NOVAI_PLATFORM_ENABLED) await hydrateLocalCanvasProjectsFromBackend();
    await bootstrapAppearance().finally(() => import("./application"));
}

void startApplication();
