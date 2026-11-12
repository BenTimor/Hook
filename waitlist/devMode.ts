// The flag is enabled only by the Vite dev server, and only on loopback hosts.
export const developmentPreview =
  import.meta.env.DEV &&
  import.meta.env.VITE_WAITLIST_DEV_MODE === true &&
  ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
