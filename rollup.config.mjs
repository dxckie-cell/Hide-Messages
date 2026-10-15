import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import esbuild from "rollup-plugin-esbuild";

const manifest = JSON.parse(readFileSync("./manifest.json", "utf8"));

/** Wraps the bundle in `vendetta=>{...}` and writes dist/manifest.json with the bundle hash. */
const vendettaPlugin = () => ({
    name: "vendetta",
    renderChunk(code) {
        return `vendetta=>{${code}\nreturn plugin}`;
    },
    writeBundle() {
        const bundle = readFileSync("./dist/index.js");
        const hash = createHash("sha256").update(bundle).digest("hex");
        mkdirSync("./dist", { recursive: true });
        writeFileSync(
            "./dist/manifest.json",
            JSON.stringify({ ...manifest, main: "index.js", hash }, null, 4)
        );
        console.log(`Built ${manifest.name} (sha256 ${hash.slice(0, 12)}…)`);
    },
});

export default {
    input: manifest.main,
    output: {
        file: "dist/index.js",
        format: "iife",
        name: "plugin",
        exports: "named",
        compact: true,
        globals(id) {
            if (id.startsWith("@vendetta")) return id.substring(1).replace(/\//g, ".");
            return { react: "window.React" }[id] ?? null;
        },
    },
    external: [/^@vendetta/, "react"],
    plugins: [
        nodeResolve(),
        commonjs(),
        esbuild({ minify: true, target: "es2017" }),
        vendettaPlugin(),
    ],
};
