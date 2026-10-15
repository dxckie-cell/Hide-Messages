import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import esbuild from "rollup-plugin-esbuild";

const manifest = JSON.parse(readFileSync("./manifest.json", "utf8"));

/**
 * The Vendetta/Revenge loader evaluates `vendetta=>{return <plugin.js>}` itself,
 * so the bundle must be a single *expression* that evaluates to the plugin's
 * exports and uses the free variable `vendetta`. Rollup's IIFE output is
 * `var plugin = (function(exports, ...){...})({}, vendetta.x, ...);`, so we strip
 * the `var plugin =` prefix and trailing semicolon to leave just the expression.
 */
const vendettaPlugin = () => ({
    name: "vendetta",
    renderChunk(code) {
        return code
            .replace(/^\s*var\s+plugin\s*=\s*/, "")
            .replace(/;\s*$/, "");
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
        globals(id) {
            if (id.startsWith("@vendetta")) return id.substring(1).replace(/\//g, ".");
            return { react: "window.React" }[id] ?? null;
        },
    },
    external: [/^@vendetta/, "react"],
    plugins: [
        nodeResolve(),
        commonjs(),
        // No minify: esbuild would re-wrap the IIFE and break the expression above.
        esbuild({ minify: false, target: "es2017" }),
        vendettaPlugin(),
    ],
};
