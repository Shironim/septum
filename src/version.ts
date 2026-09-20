import packageJson from "../package.json" with { type: "json" };

export const SEPTUM_VERSION: string = packageJson.version;
