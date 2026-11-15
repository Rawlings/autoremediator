import { createConfig } from "bench-config";

const config = createConfig({ HOST: "Example.COM", PORT: "8080" });

export const host = (): string => config.get("HOST").toLowerCase();
export const port = (): number => Number(config.get("PORT"));
