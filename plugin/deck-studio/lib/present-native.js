/**
 * Declare native tool presentation, when the host still has that API.
 *
 * DSH `0.2.1-rc.2` exposes `ctx.tools.presentAs()` and a preset must declare its
 * presentation there; DSH `0.2.2-rc.1` removed the method and mounts
 * `@deepseek-ai/dsh-tool-executor-native` at the base layer instead. Calling it
 * unconditionally on `0.2.2` throws `ctx.tools.presentAs is not a function`
 * while the preset mounts, which surfaces as `agent-preset/invalid` and blocks
 * every new deck session. Feature-detect instead of version-sniffing: native
 * execution is the only shape this plugin supports, so declaring it is a no-op
 * on hosts that already default to it.
 */

/** @param {{ presentAs?: (mode: "native") => void } | undefined} tools */
export function presentNative(tools) {
  if (typeof tools?.presentAs === "function") tools.presentAs("native");
}
