import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import frameworks from "./frameworks.js";

const REGISTRY = "https://registry.npmjs.org";
const OSV = "https://api.osv.dev/v1/vulns";
const JSDELIVR = "https://data.jsdelivr.com/v1/packages/npm";
const CDN = "https://cdn.jsdelivr.net/npm";
const GITHUB = "https://raw.githubusercontent.com";
const DATA_FILE = new URL("./data/snapshots.json", import.meta.url);
const ADVISORIES_FILE = new URL("./data/advisories.json", import.meta.url);
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

const run = promisify(execFile);

// Usage: `node collect.js` (today), `node collect.js 2025-06-01 2026-01-01`, or `node collect.js --months 12`.
const { values: flags, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		months: { type: "string" },
		only: { type: "string" },
	},
});

const today = new Date().toISOString().slice(0, 10);
let dates = positionals.length ? positionals : [today];
if (flags.months) {
	let now = new Date();
	dates = [];
	for (let i = Number(flags.months); i > 0; i--) {
		dates.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1)).toISOString().slice(0, 10));
	}
	dates.push(today);
}
dates = [...new Set(dates)].sort();

let selected = flags.only ? frameworks.filter(f => flags.only.split(",").includes(f.id)) : frameworks;

async function request(url) {
	for (let attempt = 1; ; attempt++) {
		let res = await fetch(url);
		if (res.ok) {
			return res;
		}
		if (res.status === 404 || attempt === 3) {
			throw new Error(`${res.status} ${url}`);
		}
		if (res.status === 429) {
			await sleep(2 ** attempt * 1000);
		}
	}
}

const getJson = async url => (await request(url)).json();
const getText = async url => (await request(url)).text();

async function mapLimit(items, limit, fn) {
	let results = new Array(items.length);
	let index = 0;
	await Promise.all(Array.from({ length: limit }, async () => {
		while (index < items.length) {
			let i = index++;
			results[i] = await fn(items[i]);
		}
	}));
	return results;
}

function parseVersion(v) {
	let [, major, minor, patch, pre] = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/) || [];
	return { nums: [major, minor, patch].map(Number), pre };
}

function compareVersions(a, b) {
	let pa = parseVersion(a);
	let pb = parseVersion(b);
	for (let i = 0; i < 3; i++) {
		if (pa.nums[i] !== pb.nums[i]) {
			return pa.nums[i] - pb.nums[i];
		}
	}
	return 0;
}

// Skips deprecated, placeholder, prerelease-channel, platform-binary (binaries ride along as optional deps) and uninstallable packages.
function isEligible(packument) {
	let latest = packument.versions?.[packument["dist-tags"]?.latest];
	return Boolean(latest)
		&& !latest.deprecated
		&& !latest.os
		&& !latest.cpu
		&& !latest.version.startsWith("0.0.0")
		&& !/-(edge|nightly|canary)$/.test(packument.name)
		// Publishing without pnpm can leave `catalog:` and `workspace:` specs that npm can't resolve.
		&& !Object.values({ ...latest.dependencies, ...latest.optionalDependencies, ...latest.peerDependencies }).some(spec => /^(catalog|workspace):/.test(spec));
}

// Current `latest` if it existed on that date, otherwise the highest stable version published by then.
function versionAt(packument, date) {
	let latest = packument["dist-tags"].latest;
	if (date === today) {
		return latest;
	}
	let cutoff = new Date(date).getTime();
	let publishedBy = v => new Date(packument.time[v]).getTime() < cutoff;
	if (publishedBy(latest)) {
		return latest;
	}
	return Object.keys(packument.versions)
		.filter(v => !parseVersion(v).pre && packument.time[v] && publishedBy(v))
		.sort(compareVersions)
		.pop();
}

async function getEcosystem(framework) {
	let names = new Set(framework.include);
	for (let org of framework.orgs) {
		for (let name of Object.keys(await getJson(`${REGISTRY}/-/org/${org}/package`))) {
			if (!framework.match || framework.match.test(name)) {
				names.add(name);
			}
		}
	}
	for (let name of framework.exclude || []) {
		names.delete(name);
	}

	let packuments = await mapLimit([...names].sort(), 6, name => getJson(`${REGISTRY}/${name.replace("/", "%2f")}`));
	return { owned: names, packuments: packuments.filter(isEligible) };
}

// Parses the block-style YAML in pnpm lockfiles into nested objects, keeping flow values as strings and skipping list items.
function parseLockfile(text) {
	let root = {};
	let stack = [{ indent: -1, obj: root }];
	let unquote = s => s.replace(/^(['"])(.*)\1$/, "$2");
	for (let line of text.split("\n")) {
		let [, indent, key, value] = line.match(/^( *)([^\s#-].*?):(?: (.*))?$/) || [];
		if (key === undefined) {
			continue;
		}
		while (stack.at(-1).indent >= indent.length) {
			stack.pop();
		}
		let parent = stack.at(-1).obj;
		if (value) {
			parent[unquote(key)] = unquote(value);
		} else {
			parent[unquote(key)] = {};
			stack.push({ indent: indent.length, obj: parent[unquote(key)] });
		}
	}
	return root;
}

// Packages that bundle dependencies npm audit can't see, each resolving a version to its bundled `{ dir, name, version }` list.
const VENDORED = {
	// Next.js precompiles them into dist/compiled; published manifests strip devDependencies, so versions come from the source repo's package.json files.
	next: async version => {
		let specs = {};
		for (let path of ["", "packages/next/"]) {
			let pkg = await getJson(`${GITHUB}/vercel/next.js/v${version}/${path}package.json`);
			Object.assign(specs, pkg.dependencies, pkg.devDependencies);
		}
		let prefix = "/dist/compiled/";
		let { files } = await getJson(`${JSDELIVR}/next@${version}?structure=flat`);
		let dirs = new Set(files
			.filter(f => f.name.startsWith(prefix))
			.map(f => f.name.slice(prefix.length).match(/^(@[^/]+\/)?[^/]+(?=\/)/)?.[0])
			.filter(Boolean));

		return mapLimit([...dirs].sort(), 6, async d => {
			let compiled = await getJson(`${CDN}/next@${version}${prefix}${d}/package.json`).catch(() => ({}));
			let id = compiled.name || d;
			// Prefer an `npm:` alias keyed by folder (`loader-utils2`), then the compiled name (`react-builtin`), then the folder.
			let spec = [specs[d]].find(s => s?.startsWith("npm:")) || specs[id] || specs[d] || compiled.version;
			let [, alias, aliasVersion] = spec?.match(/^npm:(@?[^@]+)@(.+)$/) || [];
			// Next.js names React channel copies `<name>(-experimental)-builtin`; the version already encodes the channel.
			return { dir: d, name: alias || id.replace(/(-experimental)?-builtin$/, ""), version: aliasVersion || spec };
		});
	},
	// Vite bundles them into dist/node and lists them in LICENSE.md; devDependencies are ranges and miss transitive deps, so versions come from the release tag's lockfile.
	vite: async version => {
		let license = await getText(`${CDN}/vite@${version}/LICENSE.md`);
		let bundled = new Set([...license.matchAll(/^## (.+)$/gm)].flatMap(m => m[1].split(", ")));
		let text = await getText(`${GITHUB}/vitejs/vite/v${version}/pnpm-lock.yaml`).catch(() => "");
		// Newer pnpm writes its own environment as an extra document first.
		let lock = text.split(/^---$/m).map(parseLockfile).find(doc => doc.importers?.["packages/vite"]);
		let nodes = { ...lock?.packages, ...lock?.snapshots };
		// Importers nest `version`, dependencies of locked packages don't; values can carry peer or patch suffixes, or alias another package.
		let refs = deps => Object.entries(deps || {}).map(([name, ref]) => {
			ref = ref.version ?? ref;
			let [, alias, aliasRef] = ref.match(/^\/?((?:@[^/]+\/)?[^@/]+)@(.+)$/) || [];
			return alias && !/^\d/.test(ref) ? [alias, aliasRef] : [name, ref];
		});

		// Walks only bundled packages, since a bundled package's dependencies are bundled too.
		let found = new Map();
		let seen = new Set();
		for (let stack = refs(lock?.importers["packages/vite"].devDependencies); stack.length;) {
			let [name, ref] = stack.pop();
			if (!bundled.has(name) || seen.has(`${name}@${ref}`)) {
				continue;
			}
			seen.add(`${name}@${ref}`);
			// Lockfile v5 keys are `/name/version` with `_peer@version` suffixes; v6 adds `@` and parenthesized suffixes; v9 drops the slash.
			found.set(name, (found.get(name) || new Set()).add(ref.replace(/[(_].*$/, "")));
			let node = nodes[`${name}@${ref}`] || nodes[`/${name}@${ref}`] || nodes[`/${name}/${ref}`];
			stack.push(...refs(node?.dependencies), ...refs(node?.optionalDependencies));
		}
		return [...bundled].sort().flatMap(name => {
			let versions = [...(found.get(name) || [])];
			return versions.length ? versions.map(version => ({ dir: `${name}@${version}`, name, version })) : [{ dir: name, name }];
		});
	},
};

const packumentCache = new Map();
const getPackument = name => {
	if (!packumentCache.has(name)) {
		packumentCache.set(name, getJson(`${REGISTRY}/${name.replace("/", "%2f")}`));
	}
	return packumentCache.get(name);
};

const vendoredCache = new Map();

async function getVendored(name, version) {
	let key = `${name}@${version}`;
	if (!vendoredCache.has(key)) {
		vendoredCache.set(key, (async () => {
			let bundled = await VENDORED[name](version);
			let published = await mapLimit(bundled, 6, v => isPublished(v.name, v.version));
			let spec = v => v.version && `${v.name}@${v.version}`;
			return {
				vendored: bundled.filter((v, i) => published[i]),
				// Workspace, git and file specs, and repo versions of workspace packages, have nothing on npm to audit.
				unresolved: bundled.filter((v, i) => !published[i]).map(v => spec(v) && spec(v) !== v.dir ? `${v.dir} (${spec(v)})` : v.dir),
			};
		})());
	}
	return vendoredCache.get(key);
}

// Finds packages in an audited tree that bundle dependencies, and aliases that install those dependencies for a second audit.
async function getBundled(report, roots = report.direct) {
	let aliases = new Map();
	let vendoredBy = new Map();
	let vendoredUnder = new Map();
	let vendored = {};
	let aliasOf = new Map();
	let unresolved = {};
	let found = false;
	for (let [key, name] of report.installed) {
		if (!Object.hasOwn(VENDORED, name) || !key.startsWith(`${name}@`)) {
			continue;
		}
		found = true;
		let result = await getVendored(name, key.slice(name.length + 1));
		if (result.unresolved.length) {
			unresolved[name] = [...new Set([...(unresolved[name] || []), ...result.unresolved])];
		}
		for (let v of result.vendored) {
			let spec = `${v.name}@${v.version}`;
			let alias = `${name}-vendored-${spec.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+/, "")}`;
			aliases.set(alias, `npm:${spec}`);
			aliasOf.set(spec, alias);
			vendoredBy.set(v.name, name);
			vendoredUnder.set(name, (vendoredUnder.get(name) || new Set()).add(v.name));
			vendored[key] = { ...vendored[key], [v.dir]: spec };
		}
	}
	return { aliases: [...aliases], aliasOf, vendoredBy, vendoredUnder, vendored, unresolved, users: found ? getBundlingUsers(report, roots) : {} };
}

// Enough of npm's range syntax for peer ranges: `||` alternatives of space-separated comparators, with `^`, `~` and `x` wildcards; prereleases compare by their release.
function satisfies(version, range) {
	if (!version) {
		return false;
	}
	let v = parseVersion(version).nums;
	let cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
	return range.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split("||").some(alt => alt.trim().split(/\s+/).every(comparator => {
		let [, op = "", rest] = comparator.match(/^(\^|~|>=|<=|>|<|=)?v?(.*)$/);
		let parts = rest.split("-")[0].split(".").filter(part => /^\d+$/.test(part)).map(Number);
		if (!parts.length) {
			return true;
		}
		let [major, minor = 0, patch = 0] = parts;
		let d = cmp(v, [major, minor, patch]);
		if (op === ">=" || op === ">" || op === "<=" || op === "<") {
			return { ">=": d >= 0, ">": d > 0, "<=": d <= 0, "<": d < 0 }[op];
		}
		let upper;
		if (op === "^") {
			upper = major || parts.length === 1 ? [major + 1, 0, 0] : minor || parts.length === 2 ? [0, minor + 1, 0] : [0, 0, patch + 1];
		} else if (op === "~") {
			upper = parts.length === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0];
		} else if (parts.length < 3) {
			upper = parts.length === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0];
		} else {
			return d === 0;
		}
		return d >= 0 && cmp(v, upper) < 0;
	}));
}

// Resolved dependency paths of a lockfile entry; peers only count when required and satisfied, since `--legacy-peer-deps` can hoist an unrelated version into their place.
function resolveEdges(lock, path) {
	let p = lock[path];
	let deps = Object.keys({ ...p.dependencies, ...p.optionalDependencies }).map(dep => resolvePath(lock, path, dep));
	let peers = Object.entries(p.peerDependencies || {})
		.filter(([dep]) => !p.peerDependenciesMeta?.[dep]?.optional)
		.map(([dep, range]) => [resolvePath(lock, path, dep), range])
		.filter(([child, range]) => child && satisfies(lock[child].version, range))
		.map(([child]) => child);
	return [...deps, ...peers].filter(Boolean);
}

const lockName = (lock, path) => lock[path].name || path.split("node_modules/").pop();

// Node's lookup: the nearest `node_modules` folder up from the dependent's path.
function resolvePath(lock, from, name) {
	for (let path = from; ; path = path.replace(/\/?node_modules\/(@[^/]+\/)?[^/]+$/, "")) {
		let candidate = `${path ? `${path}/` : ""}node_modules/${name}`;
		if (lock[candidate]) {
			return candidate;
		}
		if (!path) {
			return;
		}
	}
}

// The versions of bundling packages each root (official packages, or the core alone) pulls in, leaving packages reached through another root to that one.
function getBundlingUsers(report, roots) {
	let users = {};
	for (let root of roots) {
		let start = `node_modules/${root}`;
		for (let stack = [start], seen = new Set(); stack.length;) {
			let path = stack.pop();
			if (!path || seen.has(path) || !report.lock[path]) {
				continue;
			}
			seen.add(path);
			let p = report.lock[path];
			let name = lockName(report.lock, path);
			if (path !== start && path === `node_modules/${name}` && roots.has(name)) {
				continue;
			}
			if (Object.hasOwn(VENDORED, name)) {
				users[name] ??= {};
				users[name][root] = [...new Set([...(users[name][root] || []), p.version])].sort(compareVersions);
			}
			stack.push(...resolveEdges(report.lock, path));
		}
	}
	return users;
}

const publishedVersions = new Map();

async function isPublished(name, version) {
	if (!version || !/^[\^~]?\d/.test(version)) {
		return false;
	}
	if (!publishedVersions.has(name)) {
		publishedVersions.set(name, fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" } })
			.then(res => res.ok ? res.json() : {})
			.then(packument => new Set(Object.keys(packument.versions || {}))));
	}
	let versions = await publishedVersions.get(name);
	return /^[\^~]/.test(version) ? versions.size > 0 : versions.has(version);
}

// `peers` installs required peer dependencies, which only resolves for small trees like a single core package; `force` installs them despite conflicting ranges.
async function audit(packages, date, { peers = false, force = false } = {}) {
	let cwd = await mkdtemp(join(tmpdir(), "scoreboard-"));
	try {
		await writeFile(join(cwd, "package.json"), JSON.stringify({ private: true, dependencies: Object.fromEntries(packages) }));
		let installArgs = ["install", "--package-lock-only", ...(peers ? [] : ["--legacy-peer-deps"]), ...(force ? ["--force"] : []), "--ignore-scripts", "--allow-git=all", "--allow-remote=all", "--no-audit", "--no-fund"];
		if (date !== today) {
			installArgs.push(`--before=${date}`);
		} else {
			// Today's resolution can include versions published after npm cached a package's metadata.
			installArgs.push("--prefer-online");
		}
		await run("npm", installArgs, { cwd, maxBuffer: 64 * 1024 * 1024 });

		let stdout;
		try {
			({ stdout } = await run("npm", ["audit", "--json"], { cwd, maxBuffer: 256 * 1024 * 1024 }));
		} catch (e) {
			// `npm audit` exits non-zero when it finds vulnerabilities.
			if (!e.stdout) {
				throw e;
			}
			stdout = e.stdout;
		}
		let report = JSON.parse(stdout);

		// Count unique name@version, since npm can install the same version at several nested paths.
		let lock = JSON.parse(await readFile(join(cwd, "package-lock.json"), "utf8"));
		let entries = Object.entries(lock.packages)
			.filter(([path]) => path)
			.map(([path, p]) => ({ ...p, name: p.name || path.split("node_modules/").pop() }));

		// Platform-specific builds (os/cpu) count once per package that lists them as optional dependencies.
		let platformParent = new Map();
		for (let p of entries) {
			for (let dep of Object.keys(p.optionalDependencies || {})) {
				let parent = `${p.name}@${p.version}`;
				if (!platformParent.has(dep) || parent < platformParent.get(dep)) {
					platformParent.set(dep, parent);
				}
			}
		}
		report.installed = new Map(entries.map(p => {
			let parent = (p.os || p.cpu) && platformParent.get(p.name);
			return [parent ? `platform builds of ${parent}` : `${p.name}@${p.version}`, p.name];
		}));

		// Reverse dependency edges, for linking vendored vulnerabilities up to direct dependencies; required peers count when satisfied.
		report.lock = lock.packages;
		report.direct = new Set(Object.keys(lock.packages[""].dependencies || {}));
		report.dependents = new Map();
		for (let path of Object.keys(lock.packages).filter(Boolean)) {
			for (let child of resolveEdges(lock.packages, path)) {
				let dep = lockName(lock.packages, child);
				report.dependents.set(dep, (report.dependents.get(dep) || new Set()).add(lockName(lock.packages, path)));
			}
		}
		return report;
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

// Installs required peers, forcing past conflicting ranges, before falling back to skipping them.
async function auditCore(packages, date) {
	for (let options of [{ peers: true }, { peers: true, force: true }]) {
		try {
			return { report: await audit(packages, date, options) };
		} catch {}
	}
	return { report: await audit(packages, date), peersSkipped: true };
}

let snapshots = [];
try {
	snapshots = JSON.parse(await readFile(DATA_FILE, "utf8"));
} catch {}

let published = {};
try {
	published = JSON.parse(await readFile(ADVISORIES_FILE, "utf8"));
} catch {}

async function save() {
	snapshots.sort((a, b) => a.date.localeCompare(b.date) || a.framework.localeCompare(b.framework));
	await mkdir(new URL("./", DATA_FILE), { recursive: true });
	await writeFile(DATA_FILE, JSON.stringify(snapshots, null, "\t") + "\n");
	await writeFile(ADVISORIES_FILE, JSON.stringify(Object.fromEntries(Object.entries(published).sort()), null, "\t") + "\n");
}

const advisoryId = url => url?.match(/GHSA(-[a-z0-9]{4}){3}$/)?.[0];

async function fetchPublishedDates(report) {
	let ids = new Set();
	for (let vuln of Object.values(report.vulnerabilities || {})) {
		for (let via of vuln.via) {
			let id = typeof via === "object" && advisoryId(via.url);
			if (id && !published[id]) {
				ids.add(id);
			}
		}
	}
	await mapLimit([...ids], 8, async id => {
		try {
			published[id] = (await getJson(`${OSV}/${id}`)).published;
		} catch (e) {
			console.log(`  Could not find publish date for ${id} (${e.message}), counting it as already public`);
		}
	});
}

// Rebuilds `npm audit`'s counts using only advisories public before the date, propagating through `via` dependency chains.
function summarize(report, date, owned, vendoredUnder = new Map()) {
	let cutoff = date === today ? Infinity : new Date(date).getTime();
	let isPublic = via => {
		let when = published[advisoryId(via.url)];
		return !when || new Date(when).getTime() < cutoff;
	};
	let vulns = { ...report.vulnerabilities };
	// Vendored copies install beside their parent, so link them back, and up through the parent's dependents, as if they were regular dependencies.
	let link = (name, via) => {
		let existing = vulns[name];
		vulns[name] = { name, isDirect: report.direct.has(name), ...existing, via: [...(existing?.via || []), ...via] };
		if (!existing) {
			for (let dependent of report.dependents.get(name) || []) {
				link(dependent, [name]);
			}
		}
	};
	for (let [parent, names] of vendoredUnder) {
		let via = [...names].filter(name => vulns[name]);
		if (via.length) {
			link(parent, via);
		}
	}
	let rank = new Map();
	let advisories = new Map();

	for (let changed = true; changed;) {
		changed = false;
		for (let [name, vuln] of Object.entries(vulns)) {
			let best = rank.get(name) ?? -1;
			for (let via of vuln.via) {
				let r = -1;
				if (typeof via === "string") {
					r = rank.get(via) ?? -1;
				} else if (isPublic(via)) {
					advisories.set(via.url, via.severity);
					r = SEVERITIES.indexOf(via.severity);
				}
				best = Math.max(best, r);
			}
			if (best > (rank.get(name) ?? -1)) {
				rank.set(name, best);
				changed = true;
			}
		}
	}

	let count = values => Object.fromEntries([
		...SEVERITIES.map(s => [s, values.filter(v => v === s).length]),
		["total", values.length],
	]);
	let severityOf = name => SEVERITIES[rank.get(name)];

	// Vulnerable packages reachable from a package through its `via` dependency chain, itself included.
	let reachable = name => {
		let seen = new Set();
		for (let stack = [name]; stack.length;) {
			let next = stack.pop();
			if (!seen.has(next) && rank.has(next)) {
				seen.add(next);
				stack.push(...vulns[next].via.filter(via => typeof via === "string"));
			}
		}
		return [...seen];
	};

	return {
		dependencies: report.installed.size,
		thirdPartyDependencies: [...report.installed.values()].filter(name => !owned.has(name)).length,
		vulnerabilities: count([...rank.keys()].map(severityOf)),
		advisories: count([...advisories.values()]),
		vulnerablePackages: Object.values(vulns)
			.filter(v => v.isDirect && rank.has(v.name))
			.map(v => ({ name: v.name, severity: severityOf(v.name), vulnerabilities: count(reachable(v.name).map(severityOf)) }))
			.sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.name.localeCompare(b.name)),
	};
}

// Fetches every framework's metadata before collecting, so a failed fetch exits before any snapshots are written.
let ecosystems = new Map();
for (let framework of selected) {
	console.log(`${framework.name}: fetching package metadata`);
	ecosystems.set(framework, await getEcosystem(framework));
}

for (let framework of selected) {
	console.log(`${framework.name}: collecting`);
	let { owned, packuments: ecosystem } = ecosystems.get(framework);

	for (let date of dates) {
		let packages = ecosystem
			.map(p => [p.name, versionAt(p, date)])
			.filter(([, version]) => version);

		let snapshot = { date, collectedAt: new Date().toISOString(), framework: framework.id, packageCount: packages.length };
		try {
			let bundlers = [];
			let core = packages.find(([name]) => name === framework.core);
			if (core) {
				let { report: plainCore, peersSkipped } = await auditCore([core], date);
				// The core's own bundler versions install directly, so they take the top of the ecosystem tree instead of whichever stale version npm places first.
				bundlers = Object.keys(VENDORED)
					.filter(name => plainCore.lock[`node_modules/${name}`] && !packages.some(([official]) => official === name))
					.map(name => [name, plainCore.lock[`node_modules/${name}`].version]);
				let bundled = await getBundled(plainCore);
				let coreReport = plainCore;
				if (bundled.aliases.length) {
					({ report: coreReport, peersSkipped } = await auditCore([core, ...bundled.aliases], date));
				}
				await fetchPublishedDates(coreReport);
				let { dependencies, thirdPartyDependencies, vulnerabilities, advisories } = summarize(coreReport, date, owned, bundled.vendoredUnder);
				snapshot.core = { name: core[0], version: core[1], dependencies, thirdPartyDependencies, vulnerabilities, advisories, ...(peersSkipped && { peersSkipped }) };
				if (bundled.aliases.length) {
					await fetchPublishedDates(plainCore);
					snapshot.core.nonVendoredVulnerabilities = summarize(plainCore, date, owned).vulnerabilities;
				}
			}

			// Without a core version, the latest bundler as of the date stands in when any official package depends on it.
			for (let name of Object.keys(VENDORED)) {
				let official = ([pkg, version]) => pkg === name || ["dependencies", "optionalDependencies", "peerDependencies"].some(field => ecosystem.find(p => p.name === pkg).versions[version]?.[field]?.[name]);
				if (!bundlers.some(([bundler]) => bundler === name) && !packages.some(([pkg]) => pkg === name) && packages.some(official)) {
					bundlers.push([name, versionAt(await getPackument(name), date)]);
				}
			}

			// The core's required peers install alongside, since every project using it has them; `--legacy-peer-deps` skips all other peers.
			let coreManifest = ecosystem.find(p => p.name === framework.core)?.versions[packages.find(([name]) => name === framework.core)?.[1]];
			let peers = Object.entries(coreManifest?.peerDependencies || {})
				.filter(([name]) => !coreManifest.peerDependenciesMeta?.[name]?.optional && !packages.some(([official]) => official === name) && !bundlers.some(([bundler]) => bundler === name));
			if (peers.length) {
				snapshot.peers = Object.fromEntries(peers);
			}
			if (bundlers.length) {
				snapshot.bundlers = Object.fromEntries(bundlers);
			}

			// The plain audit finds bundling packages anywhere in the tree, then a second audit adds what they bundle.
			let plain = await audit([...packages, ...peers, ...bundlers], date);
			let { aliases, aliasOf, vendoredBy, vendoredUnder, vendored, unresolved, users } = await getBundled(plain, new Set(packages.map(([name]) => name)));
			let report = aliases.length ? await audit([...packages, ...peers, ...bundlers, ...aliases], date) : plain;
			await fetchPublishedDates(report);
			Object.assign(snapshot, summarize(report, date, owned, vendoredUnder));
			for (let p of snapshot.vulnerablePackages) {
				if (vendoredBy.has(p.name)) {
					p.vendoredBy = vendoredBy.get(p.name);
				}
			}
			if (aliases.length) {
				await fetchPublishedDates(plain);
				snapshot.nonVendoredVulnerabilities = summarize(plain, date, owned).vulnerabilities;
				snapshot.vendored = vendored;
				snapshot.vendoredUsers = users;
				// Bundled copies npm audit flagged by install path, since a package can be vulnerable in one bundled version but not another.
				let flagged = new Set(snapshot.vulnerablePackages.map(p => p.name));
				snapshot.vendoredAffected = Object.fromEntries(Object.entries(vendored).map(([key, deps]) => [key, Object.values(deps).filter(spec => {
					let name = spec.slice(0, spec.lastIndexOf("@"));
					return flagged.has(name) && report.vulnerabilities[name]?.nodes?.includes(`node_modules/${aliasOf.get(spec)}`);
				})]));
			}
			if (Object.keys(unresolved).length) {
				snapshot.unresolvedVendored = unresolved;
			}

			console.log(`  ${date}: ${packages.length} packages, ${snapshot.vulnerabilities.total} vulnerabilities (core: ${snapshot.core?.vulnerabilities.total ?? "—"})`);
		} catch (e) {
			snapshot.error = String(e.stderr || e.message).trim().split("\n").slice(-5).join("\n");
			console.log(`  ${date}: failed\n${snapshot.error}`);
		}
		snapshot.packages = Object.fromEntries(packages);
		snapshot.published = Object.fromEntries(packages.map(([name, version]) => [name, ecosystem.find(p => p.name === name).time[version]?.slice(0, 10)]));

		snapshots = snapshots.filter(s => !(s.date === date && s.framework === framework.id));
		snapshots.push(snapshot);
		await save();
	}
}
