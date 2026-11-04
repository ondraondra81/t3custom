declare const __T3CUSTOM_DESKTOP__: boolean;

export const customDesktopBuild =
  typeof __T3CUSTOM_DESKTOP__ !== "undefined" && __T3CUSTOM_DESKTOP__;
export const customDesktopIdentity = {
  name: "T3 Custom",
  appId: "dev.ondraondra81.t3custom",
  home: ".t3custom",
  profile: "t3custom",
} as const;
