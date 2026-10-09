import type { Env } from "./index";
import type { AppSettings, ModelMode, SettingsView } from "../shared/settings";

// Bindings establish capability. The session setting alone selects the mode.
export type ModelEnv = Env & { modelMode: ModelMode };
export const aiAvailable = (env: Env) => Boolean(env.AI && env.AI_GATEWAY_ID);
export function settingsView(env: Env, settings: AppSettings): SettingsView {
  return {
    ...settings,
    aiAvailable: aiAvailable(env),
    mode: settings.clefEnabled && aiAvailable(env) ? "live" : "offline",
  };
}
export function withSettings(env: Env, settings: AppSettings): ModelEnv {
  return { ...env, modelMode: settingsView(env, settings).mode };
}
