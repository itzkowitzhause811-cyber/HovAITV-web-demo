import { expect, test } from "bun:test";

test("platform uploads use server resources even when the local workspace flag is enabled", async () => {
    for (const platform of ["true", "false"]) {
        const child = Bun.spawn([process.execPath, "-e", `
            const { usesBrowserLocalResourceStore } = await import('./src/services/workspace-resource-storage');
            process.stdout.write(String(usesBrowserLocalResourceStore()));
        `], {
            cwd: new URL("..", import.meta.url).pathname,
            env: { ...process.env, VITE_NOVAI_PLATFORM: platform, VITE_CANVAS_LOCAL_MODE: "true" },
            stdout: "pipe", stderr: "pipe",
        });
        const output = await new Response(child.stdout).text();
        const error = await new Response(child.stderr).text();
        expect(await child.exited, error).toBe(0);
        expect(output).toBe(platform === "true" ? "false" : "true");
    }
});
