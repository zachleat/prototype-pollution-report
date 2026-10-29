import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import frameworks from "./frameworks.js";

const REGISTRY = "https://registry.npmjs.org";
const OSV = "https://api.osv.dev/v1/vulns";
const JSDELIVR = "https://data.jsdelivr.com/v1/packages/npm";
const CDN = "https://cdn.jsdelivr.net/npm";
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

async function getJson(url) {
	for (let attempt = 1; ; attempt++) {
		let res = await fetch(url);
		if (res.ok) {
			return res.json();
		}
		if (res.status === 404 || attempt === 3) {
			throw new Error(`${res.status} ${url}`);
		}
	}
}

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

// Skips deprecated, placeholder, prerelease-channel and platform-binary packages (binaries ride along as optional deps).
function isEligible(packument) {
	let latest = packument.versions?.[packument["dist-tags"]?.latest];
	return Boolean(latest)
		&& !latest.deprecated
		&& !latest.os
		&& !latest.cpu
		&& !latest.version.startsWith("0.0.0")
		&& !/-(edge|nightly|canary)$/.test(packument.name);
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

const vendoredCache = new Map();

// Published manifests strip devDependencies, so vendored versions come from the source repo's package.json files.
async function getVendored(name, version, { dir, manifests }) {
	let key = `${name}@${version}`;
	if (!vendoredCache.has(key)) {
		vendoredCache.set(key, (async () => {
			let specs = {};
			for (let url of manifests(version)) {
				let pkg = await getJson(url);
				Object.assign(specs, pkg.dependencies, pkg.devDependencies);
			}
			let prefix = `/${dir}/`;
			let { files } = await getJson(`${JSDELIVR}/${key}?structure=flat`);
			let dirs = new Set(files
				.filter(f => f.name.startsWith(prefix))
				.map(f => f.name.slice(prefix.length).match(/^(@[^/]+\/)?[^/]+(?=\/)/)?.[0])
				.filter(Boolean));

			let vendored = await mapLimit([...dirs].sort(), 6, async d => {
				let compiled = await getJson(`${CDN}/${key}/${dir}/${d}/package.json`).catch(() => ({}));
				let id = compiled.name || d;
				// Prefer an `npm:` alias keyed by folder (`loader-utils2`), then the compiled name (`react-builtin`), then the folder.
				let spec = [specs[d]].find(s => s?.startsWith("npm:")) || specs[id] || specs[d] || compiled.version;
				let [, alias, aliasVersion] = spec?.match(/^npm:(@?[^@]+)@(.+)$/) || [];
				// Next.js names React channel copies `<name>(-experimental)-builtin`; the version already encodes the channel.
				let resolved = { dir: d, name: alias || id.replace(/(-experimental)?-builtin$/, ""), version: aliasVersion || spec };
				resolved.published = await isPublished(resolved.name, resolved.version);
				return resolved;
			});
			return {
				vendored: vendored.filter(v => v.published),
				// Workspace, git and file specs, and repo versions of workspace packages, have nothing on npm to audit.
				unresolved: vendored.filter(v => !v.published).map(v => `${v.dir}${v.version ? ` (${v.name}@${v.version})` : ""}`),
			};
		})());
	}
	return vendoredCache.get(key);
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
	// Vendored copies install beside their parent, so link them back as if they were regular dependencies.
	for (let [parent, names] of vendoredUnder) {
		let via = [...names].filter(name => vulns[name]);
		if (via.length) {
			vulns[parent] = { name: parent, isDirect: true, ...vulns[parent], via: [...(vulns[parent]?.via || []), ...via] };
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

for (let framework of selected) {
	console.log(`${framework.name}: fetching package metadata`);
	let { owned, packuments: ecosystem } = await getEcosystem(framework);

	for (let date of dates) {
		let packages = ecosystem
			.map(p => [p.name, versionAt(p, date)])
			.filter(([, version]) => version);

		let snapshot = { date, framework: framework.id, packageCount: packages.length };
		try {
			let aliases = new Map();
			let vendoredBy = new Map();
			let vendoredUnder = new Map();
			for (let [name, version] of packages) {
				if (framework.vendored?.[name]) {
					let { vendored, unresolved } = await getVendored(name, version, framework.vendored[name]);
					if (unresolved.length) {
						snapshot.unresolvedVendored = { ...snapshot.unresolvedVendored, [name]: unresolved };
					}
					aliases.set(name, vendored.map(v => [`${name}-vendored-${v.dir.replace("@", "").replace("/", "-")}`, `npm:${v.name}@${v.version}`]));
					for (let v of vendored) {
						vendoredBy.set(v.name, name);
						vendoredUnder.set(name, (vendoredUnder.get(name) || new Set()).add(v.name));
						snapshot.vendored = { ...snapshot.vendored, [name]: { ...snapshot.vendored?.[name], [v.dir]: `${v.name}@${v.version}` } };
					}
				}
			}

			let report = await audit([...packages, ...[...aliases.values()].flat()], date);
			await fetchPublishedDates(report);
			Object.assign(snapshot, summarize(report, date, owned, vendoredUnder));
			for (let p of snapshot.vulnerablePackages) {
				if (vendoredBy.has(p.name)) {
					p.vendoredBy = vendoredBy.get(p.name);
				}
			}
			// A second audit without vendored packages, for comparison.
			if (aliases.size) {
				let plain = await audit(packages, date);
				await fetchPublishedDates(plain);
				snapshot.nonVendoredVulnerabilities = summarize(plain, date, owned).vulnerabilities;
			}

			let core = packages.find(([name]) => name === framework.core);
			if (core) {
				let coreAliases = aliases.get(framework.core) || [];
				let { report: coreReport, peersSkipped } = await auditCore([core, ...coreAliases], date);
				await fetchPublishedDates(coreReport);
				let { dependencies, thirdPartyDependencies, vulnerabilities, advisories } = summarize(coreReport, date, owned, vendoredUnder);
				snapshot.core = { name: core[0], version: core[1], dependencies, thirdPartyDependencies, vulnerabilities, advisories, ...(peersSkipped && { peersSkipped }) };
				if (coreAliases.length) {
					let { report: plain } = await auditCore([core], date);
					await fetchPublishedDates(plain);
					snapshot.core.nonVendoredVulnerabilities = summarize(plain, date, owned).vulnerabilities;
				}
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
