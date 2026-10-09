import { z } from "zod";

export const SettingsSchema = z.object({ clefEnabled: z.boolean() }).strict();
export type AppSettings = z.infer<typeof SettingsSchema>;
export const defaultSettings: AppSettings = { clefEnabled: false };
export type ModelMode = "live" | "offline";
export type SettingsView = AppSettings & {
  aiAvailable: boolean;
  mode: ModelMode;
};
