import { createBrowserRouter } from "react-router";

import { NOVAI_PLATFORM_ENABLED } from "@/lib/novai-platform";
import { workspaceRoutes } from "@/workspace-routes";

export const router = createBrowserRouter(workspaceRoutes(NOVAI_PLATFORM_ENABLED), { basename: import.meta.env.BASE_URL });
