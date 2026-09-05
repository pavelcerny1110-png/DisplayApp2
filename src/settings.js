// Repository-controlled defaults. Updating this file changes defaults on deploy;
// redeploying never resets orders, logs, revisions or command deduplication.
export const VERSION = '17.0';
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',
  poll_seconds: 3,
  completed_visibility_seconds: 60,
  sound_enabled: true,
  active_channel: 'main'
});
