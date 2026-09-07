import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bench.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
});
