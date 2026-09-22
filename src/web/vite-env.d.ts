/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  // Absent in builds that ship without the bot; PrefsScreen degrades to showing
  // the raw /start command instead of a deep link.
  readonly VITE_TELEGRAM_BOT?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
