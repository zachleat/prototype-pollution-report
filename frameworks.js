import { faAngular, faBuildAwesome, faSvelte } from "@fortawesome/free-brands-svg-icons";
import { faAstro, faGatsby, faNextjs, faNuxt, faTanstack } from "./logos.js";

// Each ecosystem is every package owned by its npm orgs (narrowed by `match`), plus `include`, minus `exclude`; `core` is also audited alone, labeled `coreName` when set.
// `static` and `requestTime` say whether a framework can build static output or run code per request ("no", "yes" or "default").
// `mpa` and `spa` say whether pages can navigate with full page loads or a client-side router, in the same terms.
// Brand colors, stepped per mode where needed for contrast; brand icons carry identity where hues are close.
export default [
	{ id: "11ty", mpa: "default", spa: "no", static: "default", requestTime: "no", name: "Build Awesome (11ty)", orgs: ["11ty"], core: "@11ty/eleventy", icon: faBuildAwesome, color: { light: "#00a776", dark: "#00a776" } },
	{ id: "svelte", mpa: "yes", spa: "default", static: "yes", requestTime: "default", name: "Svelte", orgs: ["sveltejs"], core: "@sveltejs/kit", coreName: "SvelteKit", include: ["svelte", "sv", "svelte-check", "svelte2tsx", "svelte-language-server", "typescript-svelte-plugin", "svelte-preprocess", "eslint-plugin-svelte", "svelte-eslint-parser", "prettier-plugin-svelte", "svelte-hmr"], icon: faSvelte, color: { light: "#ff3e00", dark: "#ff3e00" } },
	{ id: "nuxt", mpa: "yes", spa: "default", static: "yes", requestTime: "default", name: "Nuxt", orgs: ["nuxt"], core: "nuxt", icon: faNuxt, color: { light: "#00a35c", dark: "#00dc82" } },
	{
		id: "next", mpa: "no", spa: "default", static: "yes", requestTime: "default",
		name: "Next.js",
		orgs: ["next"],
		include: ["create-next-app", "eslint-config-next"],
		core: "next",
		icon: faNextjs,
		color: { light: "#000000", dark: "#f0efec" },
		// Audit precompiled deps in dist/compiled as if they were regular dependencies.
		vendored: {
			next: {
				dir: "dist/compiled",
				manifests: v => ["", "packages/next/"].map(path => `https://raw.githubusercontent.com/vercel/next.js/v${v}/${path}package.json`),
			},
		},
	},
	{ id: "astro", mpa: "default", spa: "yes", static: "default", requestTime: "yes", name: "Astro", orgs: ["astrojs"], include: ["create-astro"], core: "astro", exclude: ["@astrojs/astro-test-builtins-dep", "@astrojs/test-static-build-pkg"], icon: faAstro, color: { light: "#a93fdb", dark: "#bc52ee" } },
	{ id: "gatsby", mpa: "no", spa: "default", static: "default", requestTime: "yes", name: "Gatsby", orgs: ["gatsbyjs"], core: "gatsby", icon: faGatsby, color: { light: "#663399", dark: "#9d6fd0" } },
	// The angular org also owns AngularJS and Angular 2-era packages.
	{ id: "angular", mpa: "no", spa: "default", static: "default", requestTime: "yes", name: "Angular", orgs: ["angular"], match: /^(@angular\/|@angular-devkit\/|@schematics\/angular$|zone\.js$|angular-in-memory-web-api$)/, core: "@angular/core", icon: faAngular, color: { light: "#dd0031", dark: "#dd0031" } },
	// The tanstack org also owns Query, Table, AI and other libraries.
	{ id: "tanstack-start", mpa: "no", spa: "default", static: "yes", requestTime: "default", name: "TanStack Start", orgs: ["tanstack"], match: /^@tanstack\/(.*\b(start|router)\b.*|history|virtual-file-routes|directive-functions-plugin|server-functions-plugin|nitro-v2-vite-plugin)$/, include: ["create-start-app", "create-tsrouter-app", "create-tanstack", "create-tanstack-app"], core: "@tanstack/react-start", icon: faTanstack, color: { light: "#7a6a45", dark: "#cdbf8f" } },
];
