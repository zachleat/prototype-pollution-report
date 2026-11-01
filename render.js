import { readFile, writeFile } from "node:fs/promises";
import { faCircleCheck as faCircleCheckRegular, faCircleXmark } from "@fortawesome/free-regular-svg-icons";
import { faArrowDown, faArrowUp, faBoxOpen, faBug, faCircleCheck, faCircleInfo, faCloud, faCloudBolt, faCloudRain, faCloudShowersHeavy, faCloudSun, faFileCode, faServer, faSun, faUser } from "@fortawesome/free-solid-svg-icons";
import { faWordpressSimple } from "@fortawesome/free-brands-svg-icons";
import frameworks from "./frameworks.js";

// Shown in the rendering table only, since it isn't audited.
const renderingOnly = [
	{ id: "wordpress", mpa: "default", spa: "no", static: "no", requestTime: "default", name: "WordPress", icon: faWordpressSimple, color: "light-dark(#21759b, #4f94d4)" },
];

const snapshots = JSON.parse(await readFile(new URL("./data/snapshots.json", import.meta.url), "utf8"));
const OUTPUT = new URL("./index.html", import.meta.url);

const SEVERITIES = ["critical", "high", "moderate", "low"];
// Forecast by weighted vulnerability score, like an air-quality report: the first bucket whose `max` the score fits under.
// Each bucket borrows a severity pill color.
const FORECAST = [
	{ id: "clear", label: "Clear", max: 0, icon: faSun, severity: "none" },
	{ id: "partly-cloudy", label: "Partly cloudy", max: 24, icon: faCloudSun, severity: "low" },
	{ id: "cloudy", label: "Cloudy", max: 124, icon: faCloud, severity: "moderate" },
	{ id: "rain", label: "Rain", max: 249, icon: faCloudRain, severity: "high" },
	{ id: "heavy-rain", label: "Heavy rain", max: 624, icon: faCloudShowersHeavy, severity: "severe" },
	{ id: "storms", label: "Storms", max: Infinity, icon: faCloudBolt, severity: "critical" },
];
const SEVERITY_POINTS = { critical: 10, high: 6, moderate: 3, low: 1 };
const forecastScore = counts => Object.entries(SEVERITY_POINTS).reduce((sum, [sev, points]) => sum + (counts[sev] ?? 0) * points, 0);
// The bucket's rank shows beside the icon, from 0 (clear) to 5 (storms).
const rankPill = index => {
	let { id, label, severity } = FORECAST[index];
	return `<span class="badge rank ${severity}"><svg class="weather" role="img" aria-label="${label}"><use href="#weather-${id}"/></svg>${index}</span>`;
};
const forecast = counts => {
	let score = forecastScore(counts);
	let index = FORECAST.findIndex(f => score <= f.max);
	return `<td class="forecast" title="${FORECAST[index].label}">${rankPill(index)}</td>`;
};
const forecastLegend = `<ul class="keys legend">${FORECAST.map(({ label }, i) => `<li>${rankPill(i)}${label}</li>`).join("")}</ul>`;

// Change since the snapshot closest to three weeks before the latest: red up arrow for more, green down arrow for fewer.
const delta = (total, previous) => {
	let change = previous == null ? 0 : total - previous;
	if (!change) {
		return "";
	}
	let direction = change > 0 ? "up" : "down";
	return `<span class="delta ${direction}" title="${change > 0 ? "Up" : "Down"} ${num(Math.abs(change))} since ${formatDate(baseline)}"><svg class="trend" aria-hidden="true"><use href="#trend-${direction}"/></svg>${num(Math.abs(change))}</span>`;
};

// Age of a published version as of the latest snapshot.
const age = published => {
	if (!published) {
		return "";
	}
	let days = Math.round((time(latestDate) - time(published)) / 864e5);
	let label = days <= 30 ? `${days}d` : Math.round(days / 30.44) <= 12 ? `${Math.round(days / 30.44)}mo` : `${Math.round(days / 365.25 * 2) / 2}y`;
	return ` <span class="badge age" title="Published ${formatDate(published)}">${label}</span>`;
};

const SUPPORT = {
	default: { label: "Default", icon: faCircleCheck },
	yes: { label: "Optional", icon: faCircleCheckRegular },
	no: { label: "No", icon: faCircleXmark },
};
const REQUEST_TIME_WARNING = "Code runs on request (by default)";
const cautionIcon = label => `<svg class="support warn" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><use href="#support-warn"/></svg>`;
// Frameworks that run server code per request by default get a warning next to their vulnerability counts.
// Left off when there are no vulnerabilities to warn about.
const requestTimeCaution = (f, total) => f.requestTime === "default" && total !== 0 ? cautionIcon(REQUEST_TIME_WARNING) : "";

// `warn` adds a separate exclamation after defaults that add risk.
const support = (value, { warn } = {}) => {
	let caution = warn && value === "default" ? cautionIcon(warn) : "";
	return `<td><svg class="icon support ${value}" aria-hidden="true"><use href="#support-${value}"/></svg>${SUPPORT[value].label}${caution}</td>`;
};

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const num = n => (n ?? "—").toLocaleString("en-US");
const compact = n => new Intl.NumberFormat("en-US", { notation: "compact" }).format(n).toLowerCase();
const time = d => new Date(`${d}T00:00:00Z`).getTime();
const formatDate = (d, opts = { month: "short", day: "numeric", year: "numeric" }) =>
	new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(time(d));

const dates = [...new Set(snapshots.map(s => s.date))].sort();
const latestDate = dates.at(-1);
const distance = d => Math.abs(time(d) - (time(latestDate) - 21 * 864e5));
const baseline = dates.slice(0, -1).reduce((best, d) => distance(d) < distance(best) ? d : best, dates[0]);
const collectedAt = snapshots.filter(s => s.date === latestDate && s.collectedAt).map(s => s.collectedAt).sort().at(-1);
const lastUpdated = collectedAt
	? `<time datetime="${collectedAt}" data-since>${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(collectedAt))} UTC</time>`
	: formatDate(latestDate);
const byKey = new Map(snapshots.map(s => [`${s.date}|${s.framework}`, s]));
const get = (date, id) => byKey.get(`${date}|${id}`);
const series = frameworks.map((f, i) => ({ ...f, slot: i + 1 }));
const seriesVars = mode => series.map(f => `--series-${f.slot}: ${f.color[mode]};`).join("\n\t\t");

const symbol = (id, { icon: [w, h, , , d] }) => `<symbol id="${id}" viewBox="0 0 ${w} ${h}"><path d="${d}"/></symbol>`;
const sprite = `<svg class="sprite" aria-hidden="true">${[
	...[...series, ...renderingOnly].map(f => symbol(`icon-${f.id}`, f.icon)),
	symbol("flow-user", faUser),
	symbol("flow-html", faFileCode),
	symbol("flow-server", faServer),
	symbol("flow-bug", faBug),
	...Object.entries(SUPPORT).map(([key, { icon }]) => symbol(`support-${key}`, icon)),
	symbol("support-warn", faCircleInfo),
	...FORECAST.map(({ id, icon }) => symbol(`weather-${id}`, icon)),
	symbol("trend-up", faArrowUp),
	symbol("trend-down", faArrowDown),
	symbol("bundle", faBoxOpen),
].join("")}</svg>`;
const icon = f => `<svg class="icon" aria-hidden="true" style="fill:${f.slot ? `var(--series-${f.slot})` : f.color}"><use href="#icon-${f.id}"/></svg>`;

// A request travels from a visitor toward the vulnerable dependency: static output stops it at the HTML, request-time code carries it through.
const flow = ({ kind, title, label, middle }) => `<div class="panel">
	<h3>${title}</h3>
	<svg class="flow ${kind}" viewBox="0 0 340 56" role="img" aria-label="${esc(label)}">
		<line class="flow-track" x1="40" x2="150" y1="20" y2="20"/>
		<line class="flow-track${kind === "static" ? " dashed" : ""}" x1="190" x2="300" y1="20" y2="20"/>
		${kind === "static" ? `<text class="tick flow-note" x="245" y="10" text-anchor="middle">once, at build</text>` : ""}
		<circle class="flow-dot" cx="40" cy="20" r="4"/>
		<use class="flow-icon" href="#flow-user" x="8" y="8" width="24" height="24"/>
		<use class="flow-icon flow-middle" href="#flow-${middle.id}" x="158" y="8" width="24" height="24"/>
		<use class="flow-bug" href="#flow-bug" x="308" y="8" width="24" height="24"/>
		<text class="tick" x="8" y="50">Visitor</text>
		<text class="tick" x="170" y="50" text-anchor="middle">${middle.label}</text>
		<text class="tick" x="332" y="50" text-anchor="end">Vulnerable dependency</text>
	</svg>
</div>`;
const flows = `<div class="flows">
	${flow({ kind: "static", title: "Build-time", label: "Visitor requests stop at prebuilt HTML files. The vulnerable dependency only ran on the build machine.", middle: { id: "html", label: "HTML files" } })}
	${flow({ kind: "request-time", title: `Request-time${cautionIcon(REQUEST_TIME_WARNING)}`, label: "Visitor requests pass through the server to the vulnerable dependency on every page load.", middle: { id: "server", label: "Server" } })}
</div>`;
// Only the most severe pill is labeled; the rest show counts, with the severity in the tooltip.
const pills = counts => SEVERITIES.filter(sev => counts[sev]).map((sev, i) => i ? ` <span class="badge ${sev}" title="${num(counts[sev])} ${sev}">${num(counts[sev])}</span>` : ` <span class="badge ${sev}">${sev}<span class="count">${num(counts[sev])}</span></span>`).join("");
const packagePills = p => p.vulnerabilities ? pills(p.vulnerabilities) : ` <span class="badge ${p.severity}">${p.severity}</span>`;
// Bundled copies per bundler version, sorted by bundler then version; older snapshots key by bundler name and only know which names were vulnerable.
const bundles = s => Object.entries(s.vendored || {}).map(([key, deps]) => {
	let at = key.lastIndexOf("@");
	let parent = at > 0 ? key.slice(0, at) : key;
	let specs = Object.values(deps);
	let affected = s.vendoredAffected?.[key] ?? specs.filter(spec => s.vulnerablePackages.some(p => p.vendoredBy === parent && spec.startsWith(`${p.name}@`)));
	return { parent, version: at > 0 ? key.slice(at + 1) : "", specs, affected };
}).sort((a, b) => a.parent.localeCompare(b.parent) || a.version.localeCompare(b.version, undefined, { numeric: true }));

// Bundled packages count once per unique version across bundlers.
const bundledCount = (s, field) => new Set(bundles(s).flatMap(b => b[field])).size;
const officialAffected = s => s.vulnerablePackages.filter(p => !p.vendoredBy && s.packages[p.name]).length;
// The raw npm audit count (no vendored packages), shown only where it differs.
const rawAudit = s => s.nonVendoredVulnerabilities && s.nonVendoredVulnerabilities.total !== s.vulnerabilities.total ? `<br><span class="third-party">(${num(s.nonVendoredVulnerabilities.total)})</span>` : "";

function linearScale(max, count = 5) {
	let raw = Math.max(max, 1) / count;
	let mag = 10 ** Math.floor(Math.log10(raw));
	let norm = raw / mag;
	let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
	let top = Math.ceil(Math.max(max, 1) / step) * step;
	return { ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step), ratio: v => v / top };
}

const chartRows = value => dates.map(date => ({ date, values: series.map(f => {
	let s = get(date, f.id);
	return s && !s.error ? value(s) ?? null : null;
}) }));
const rowsMax = rows => Math.max(...rows.flatMap(r => r.values.filter(v => v != null)));
const timeX = (left, right) => d => left + (time(latestDate) === time(dates[0]) ? 0.5 : (time(d) - time(dates[0])) / (time(latestDate) - time(dates[0]))) * right;

// `alt` rows show beneath the main value, muted, only where they differ.
const dataTable = (rows, label, nameOf, alt) => `<details>
		<summary>${esc(label)} data table</summary>
		${alt ? `<p class="note">${esc(alt.label)} counts in parentheses where they differ.</p>` : ""}
		<div class="scroll"><table>
			<thead><tr><th>Date</th>${series.map(f => `<th class="n">${esc(nameOf(f))}</th>`).join("")}</tr></thead>
			<tbody>${rows.map((r, j) => `<tr><td>${formatDate(r.date)}</td>${r.values.map((v, i) => {
				let other = alt?.rows[j].values[i];
				return `<td class="n">${num(v)}${other != null && other !== v ? `<br><span class="third-party">(${num(other)})</span>` : ""}</td>`;
			}).join("")}</tr>`).join("")}</tbody>
		</table></div>
	</details>`;

const SW = 240;
const SH = 150;
const SM = { top: 12, right: 40, bottom: 24, left: 40 };

// One panel per framework: the first measure (solid) on the right axis, the second (dotted) on the left, and an optional third (dashed) sharing the first's axis.
// Each axis is shared across frameworks so sizes stay comparable.
function smallMultiples({ id, title, description, measures, nameOf = f => f.name, versionOf, order = [] }) {
	let x = timeX(SM.left, SW - SM.left - SM.right);
	let [primary, secondary, alt] = measures.map(m => {
		let rows = chartRows(m.value);
		let { ticks, ratio } = linearScale(rowsMax(rows), 3);
		return { ...m, rows, ticks, y: v => SH - SM.bottom - ratio(v) * (SH - SM.top - SM.bottom) };
	});
	let pathFor = ({ rows, y }, i) => rows.map((r, j) => r.values[i] == null ? "" : `${j && rows[j - 1].values[i] != null ? "L" : "M"}${x(r.date).toFixed(1)},${y(r.values[i]).toFixed(1)}`).join("");

	// Panels follow `order` (framework ids), with anything missing from it at the end.
	let rank = f => order.includes(f.id) ? order.indexOf(f.id) : Infinity;
	let panels = series.toSorted((a, b) => rank(a) - rank(b)).map(f => {
		let i = series.indexOf(f);
		let color = `var(--series-${f.slot})`;
		let present = primary.rows.filter(r => r.values[i] != null);
		let { y } = primary;
		let area = present.length ? `M${x(present[0].date).toFixed(1)},${y(0)}${present.map(r => `L${x(r.date).toFixed(1)},${y(r.values[i]).toFixed(1)}`).join("")}L${x(present.at(-1).date).toFixed(1)},${y(0)}Z` : "";
		// The dashed value only shows in the tooltip where it differs from the solid one.
		let altValue = j => alt && alt.rows[j].values[i] !== primary.rows[j].values[i] ? alt.rows[j].values[i] : null;
		let versions = versionOf ? primary.rows.map(r => {
			let snap = get(r.date, f.id);
			return snap && !snap.error ? versionOf(snap) : undefined;
		}) : [];
		let points = primary.rows.map((r, j) => ({ x: x(r.date), label: formatDate(r.date), version: versions[j], values: [r.values[i], altValue(j), secondary.rows[j].values[i]] }));
		// Mark where the major version changes (0.x counts by minor), labeling the first one at the left edge.
		let major = v => v && (v.startsWith("0.") ? v.split(".").slice(0, 2).join(".") : v.split(".")[0]);
		let changes = versions.flatMap((v, j) => {
			let prev = versions.slice(0, j).findLast(Boolean);
			return v && major(v) !== major(prev) ? [{ x: x(primary.rows[j].date), label: `v${major(v)}`, first: !prev }] : [];
		});
		// Drop a label that would run into the next one (about 5 units per character at this size).
		let versionMarks = changes.map((c, k) => {
			let next = changes[k + 1];
			let fits = !next || c.x + 3 + c.label.length * 5 + 2 <= next.x;
			return (c.first ? "" : `<line class="version-mark" x1="${c.x.toFixed(1)}" x2="${c.x.toFixed(1)}" y1="${SM.top}" y2="${SH - SM.bottom}"/>`)
				+ (fits ? `<text class="tick version" x="${(c.x + 3).toFixed(1)}" y="${SM.top - 4}">${esc(c.label)}</text>` : "");
		}).join("");
		// Tooltips use a measure's shorter `tooltip` label when it has one.
		let labels = [{ name: primary.label, color }, { name: alt?.tooltip ?? alt?.label, color, style: "dashed" }, { name: secondary.label, color, style: "dotted" }];
		return `<div class="panel">
			<h3>${icon(f)}${esc(nameOf(f))}${requestTimeCaution(f, present.at(-1)?.values[i])}</h3>
			<div class="plot">
				<svg viewBox="0 0 ${SW} ${SH}" role="img" aria-label="${esc(`${nameOf(f)}: ${title}`)}" tabindex="0" data-labels="${esc(JSON.stringify(labels))}" data-points="${esc(JSON.stringify(points))}">
					${primary.ticks.map(t => `<line class="grid" x1="${SM.left}" x2="${SW - SM.right}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${SW - SM.right + 6}" y="${y(t)}" dominant-baseline="middle">${num(t)}</text>`).join("")}
					${secondary.ticks.map(t => `<text class="tick secondary" x="${SM.left - 6}" y="${secondary.y(t)}" text-anchor="end" dominant-baseline="middle">${compact(t)}</text>`).join("")}
					<line class="axis" x1="${SM.left}" x2="${SW - SM.right}" y1="${y(0)}" y2="${y(0)}"/>
					<text class="tick" x="${SM.left}" y="${SH - 6}">${formatDate(dates[0], { month: "short", year: "2-digit" })}</text>
					<text class="tick" x="${SW - SM.right}" y="${SH - 6}" text-anchor="end">${formatDate(latestDate, { month: "short", year: "2-digit" })}</text>
					${versionMarks}
					<path d="${area}" class="area" style="fill:${color}"/>
					<path d="${pathFor(secondary, i)}" class="line dotted" style="stroke:${color}"/>
					${alt ? `<path d="${pathFor({ rows: alt.rows, y }, i)}" class="line dashed" style="stroke:${color}"/>` : ""}
					<path d="${pathFor(primary, i)}" class="line" style="stroke:${color}"/>
					<line class="crosshair" y1="${SM.top}" y2="${SH - SM.bottom}" visibility="hidden"/>
				</svg>
				<div class="tooltip-anchor"></div>
				<div class="tooltip" hidden></div>
			</div>
		</div>`;
	}).join("");

	return `<figure class="chart" id="${id}">
	<figcaption>
		<h3>${esc(title)}</h3>
		${description ? `<p>${esc(description)}</p>` : ""}
		<ul class="keys"><li><i class="dotted"></i>${esc(secondary.label)} (left axis)</li><li><i></i>${esc(primary.label)} (right axis)</li>${alt ? `<li><i class="dashed"></i>${esc(alt.label)} (right axis)</li>` : ""}</ul>
	</figcaption>
	<div class="multiples">${panels}</div>
	<div class="stack">${dataTable(primary.rows, primary.label, nameOf, alt)}${dataTable(secondary.rows, secondary.label, nameOf)}</div>
</figure>`;
}

let latest = series
	.map(f => ({ f, s: get(latestDate, f.id) }))
	.filter(({ s }) => s && !s.error)
	.sort((a, b) => a.s.vulnerabilities.total - b.s.vulnerabilities.total);
let latestCore = latest
	.filter(({ s }) => s.core)
	.toSorted((a, b) => a.s.core.vulnerabilities.total - b.s.core.vulnerabilities.total);

let latestOf = f => latest.find(l => l.f === f)?.s;
// Fewest ecosystem vulnerabilities first, then fewest core vulnerabilities; missing data sorts last.
let coreTotal = f => latestOf(f)?.core?.vulnerabilities.total ?? Infinity;
let ecosystemTotal = f => latestOf(f)?.vulnerabilities.total ?? Infinity;
let renderingTable = `<div class="scroll"><table class="scoreboard compact">
	<thead>
		<tr>
			<th rowspan="2">Framework</th>
			<th colspan="2" class="group">Forecast</th>
			<th colspan="2" class="group">Rendering</th>
			<th colspan="2" class="group">Navigation</th>
		</tr>
		<tr>
			<th>Ecosystem</th>
			<th>Core</th>
			<th>Build-time (static)</th>
			<th>Request-time</th>
			<th>MPA</th>
			<th>SPA</th>
		</tr>
	</thead>
	<tbody>${[...series, ...renderingOnly].toSorted((a, b) => ecosystemTotal(a) - ecosystemTotal(b) || coreTotal(a) - coreTotal(b) || a.name.localeCompare(b.name)).map(f => `<tr>
		<th scope="row">${icon(f)}${esc(f.name)}</th>
		${(s => s ? forecast(s.vulnerabilities) : "<td></td>")(latestOf(f))}
		${(core => core ? forecast(core.vulnerabilities) : "<td></td>")(latestOf(f)?.core)}
		${support(f.static)}
		${support(f.requestTime, { warn: REQUEST_TIME_WARNING })}
		${support(f.mpa)}
		${support(f.spa)}
	</tr>`).join("")}</tbody>
</table></div>`;

let scoreboard = `<div class="scroll"><table class="scoreboard">
	<thead><tr>
		<th>Forecast</th>
		<th>Framework</th>
		<th class="n">Vulnerabilities<br><span class="third-party">(Raw npm audit)</span></th>
		<th class="n">GitHub<br>Advisories</th>
		<th class="n">Packages<br><span class="third-party">(Affected)</span></th>
		<th class="n">Dependencies<br><span class="third-party">(Third-party)</span></th>
		<th>Severity<br>${SEVERITIES.map(sev => `<span class="badge ${sev} key">${sev}</span>`).join(" ")}</th>
	</tr></thead>
	<tbody>${latest.map(({ f, s }) => `<tr>
		${forecast(s.vulnerabilities)}
		<th scope="row">${icon(f)}${esc(f.name)}</th>
		<td class="n strong">${requestTimeCaution(f, s.vulnerabilities.total)}${num(s.vulnerabilities.total)}${delta(s.vulnerabilities.total, get(baseline, f.id)?.vulnerabilities?.total)}${rawAudit(s)}</td>
		<td class="n">${num(s.advisories.total)}</td>
		<td class="n">${num(s.packageCount)}<br><span class="third-party">(${num(officialAffected(s))})</span></td>
		<td class="n">${num(s.dependencies)}<br><span class="third-party">(${num(s.thirdPartyDependencies)})</span></td>
		<td class="sev">${pills(s.vulnerabilities) || `<span class="muted">—</span>`}</td>
	</tr>`).join("")}</tbody>
</table></div>`;

let coreScoreboard = `<div class="scroll"><table class="scoreboard">
	<thead><tr>
		<th>Forecast</th>
		<th>Package</th>
		<th class="n">Vulnerabilities<br><span class="third-party">(Raw npm audit)</span></th>
		<th class="n">GitHub<br>Advisories</th>
		<th class="n">Dependencies<br><span class="third-party">(Third-party)</span></th>
		<th>Severity<br>${SEVERITIES.map(sev => `<span class="badge ${sev} key">${sev}</span>`).join(" ")}</th>
	</tr></thead>
	<tbody>${latestCore.map(({ f, s: { core, published } }) => `<tr>
		${forecast(core.vulnerabilities)}
		<th scope="row">${icon(f)}<a href="https://www.npmjs.com/package/${esc(core.name)}/v/${esc(core.version)}">${esc(core.name)}</a> <span class="muted">${esc(core.version)}</span>${age(published?.[core.name])}</th>
		<td class="n strong">${requestTimeCaution(f, core.vulnerabilities.total)}${num(core.vulnerabilities.total)}${delta(core.vulnerabilities.total, get(baseline, f.id)?.core?.vulnerabilities.total)}${rawAudit(core)}</td>
		<td class="n">${num(core.advisories.total)}</td>
		<td class="n">${num(core.dependencies)}<br><span class="third-party">(${num(core.thirdPartyDependencies)})</span></td>
		<td class="sev">${pills(core.vulnerabilities) || `<span class="muted">—</span>`}</td>
	</tr>`).join("")}</tbody>
</table></div>`;


let details = latest.map(({ f, s }) => `<details class="ecosystem">
	<summary>${icon(f)}${esc(f.name)}: ${((affected, bundled, bundledAffected) => {
		let official = `${num(affected)} of ${num(s.packageCount)} official`;
		let percent = `(${Math.round(affected / s.packageCount * 100)}%)`;
		return bundledAffected ? `${official} ${percent} and ${num(bundledAffected)} of ${num(bundled)} bundled (${Math.round(bundledAffected / bundled * 100)}%) packages affected` : `${official} packages ${percent} affected`;
	})(officialAffected(s), bundledCount(s, "specs"), bundledCount(s, "affected"))}</summary>
	<ul class="packages">${Object.entries(s.packages).sort(([a], [b]) => (s.published?.[a] || "9999").localeCompare(s.published?.[b] || "9999")).map(([name, version]) => {
		let vuln = s.vulnerablePackages.find(p => p.name === name && !p.vendoredBy);
		let bundling = Object.entries(s.vendoredUsers || {}).filter(([, users]) => users[name]).map(([parent, users]) => ` <span class="badge bundling" title="${parent === name ? "Bundles its dependencies" : `Installs ${esc(parent)}, which bundles its dependencies`}"><svg class="bundle" aria-hidden="true"><use href="#bundle"/></svg>${esc(parent)}${parent === name ? "" : ` ${users[name].map(esc).join(", ")}`}</span>`).join("");
		let published = age(s.published?.[name]).trim();
		return `<li>${published ? `${published} ` : ""}${vuln ? `${packagePills(vuln).trim()} ` : ""}<a href="https://www.npmjs.com/package/${esc(name)}/v/${esc(version)}">${esc(name)}</a> <span class="muted">${esc(version)}</span>${bundling}</li>`;
	}).join("")}${bundles(s).map(({ parent, version, specs, affected }) => {
		let clean = specs.length - affected.length;
		return `<li class="bundled-heading">Bundled by <span class="badge bundling"><svg class="bundle" aria-hidden="true"><use href="#bundle"/></svg>${esc(parent)}${version && !s.packages[parent] ? ` ${esc(version)}` : ""}</span></li>` + affected.map(spec => {
			let name = spec.slice(0, spec.lastIndexOf("@"));
			let p = s.vulnerablePackages.find(p => p.name === name);
			return `<li class="bundled">${p ? `${packagePills(p).trim()} ` : ""}<a href="https://www.npmjs.com/package/${esc(name)}/v/${esc(spec.slice(name.length + 1))}">${esc(name)}</a> <span class="muted">${esc(spec.slice(name.length + 1))}</span></li>`;
		}).join("") + (clean ? `<li class="bundled"><em><code>${esc(parent)}</code> bundled ${num(clean)} more deps without vulnerabilities, not shown here.</em></li>` : "");
	}).join("")}</ul>
	${Object.values(s.unresolvedVendored || {}).map(unresolved => `<!-- <p class="note">Not published to npm, so not checked: ${unresolved.map(esc).join(", ")}.</p> -->`).join("")}
</details>`).join("");

let failures = snapshots.filter(s => s.error);

let html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prototype Pollution Report</title>
<meta name="description" content="npm audit results over time for official framework packages.">
<style>
:root {
	color-scheme: light;
	--page: #f9f9f7;
	--surface: #fcfcfb;
	--text: #0b0b0b;
	--text-2: #52514e;
	--muted: #898781;
	--grid: #e1e0d9;
	--axis: #c3c2b7;
	--border: rgba(11, 11, 11, 0.1);
	${seriesVars("light")}
	--caution: #e3b85e;
	--good: #0ca30c;
	--critical: #d03b3b;
	--serious: #ec835a;
	--severe: #e25f4a;
	--sun: #ffd60a;
	--warning: #fab219;
}
@media (prefers-color-scheme: dark) {
	:root:not([data-theme="light"]) {
		color-scheme: dark;
		--page: #0d0d0d;
		--surface: #1a1a19;
		--text: #f0efec;
		--text-2: #c3c2b7;
		--grid: #2c2c2a;
		--axis: #383835;
		--border: rgba(255, 255, 255, 0.1);
		${seriesVars("dark")}
		--caution: #c7a560;
	}
}
:root[data-theme="dark"] {
	color-scheme: dark;
	--page: #0d0d0d;
	--surface: #1a1a19;
	--text: #f0efec;
	--text-2: #c3c2b7;
	--grid: #2c2c2a;
	--axis: #383835;
	--border: rgba(255, 255, 255, 0.1);
	${seriesVars("dark")}
	--caution: #c7a560;
}
/* Registered so it inherits as a computed length, keeping table cells (smaller font) aligned with page padding. */
@property --page-pad-inline { syntax: "<length>"; inherits: true; initial-value: 0px; }
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--page);
	color: var(--text);
	font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
	line-height: 1.5;
}
main { --page-pad-inline: 1em; max-width: 64em; margin-inline: auto; padding: 2em var(--page-pad-inline) 4em; }
h1 { font-size: 1.75em; line-height: 1.2; margin: 0; }
h2 { font-size: 1.125em; margin: 0; }
h3 { font-size: 1em; margin: 0; }
p { margin: 0; }
a { color: inherit; }
.muted, figcaption p, .note { color: var(--text-2); }
.note { font-size: 0.875em; max-width: 46em; }
/* One gap between groups; each group sets its own tighter gap. */
header, hgroup, figcaption { display: flex; flex-direction: column; gap: 0.5em; }
header { margin-block-end: 2em; }
hgroup { margin: 0; }
section { margin: 0 0 2em; }
.card {
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 12px;
	padding: 1.5em var(--page-pad-inline);
	display: flex;
	flex-direction: column;
	gap: 2em;
}
/* Bleed past main's inline padding to the viewport edge on small screens. */
@media (width < 40em) {
	.card { margin-inline: calc(-1 * var(--page-pad-inline)); border-inline: 0; border-radius: 0; }
}
figure { margin: 0; display: flex; flex-direction: column; gap: 1.25em; }
.stack { display: flex; flex-direction: column; gap: 0.75em; }
.footnotes, .footnote { color: var(--text-2); font-size: 0.8125em; max-width: 46em; margin: 0; }
.footnotes { padding-inline-start: 1.25em; }
.footnotes, .footnotes ul { display: flex; flex-direction: column; gap: 0.25em; }
.footnotes ul { margin-block-start: 0.25em; }
.sprite { position: absolute; width: 0; height: 0; }
.delta { font-size: 0.8125em; font-weight: 500; margin-inline-start: 0.375em; white-space: nowrap; }
.delta.up { color: var(--critical); }
.delta.down { color: var(--good); }
/* Font Awesome arrows are 384 wide by 512 tall, so match that ratio to avoid side padding. */
.trend { width: 0.6em; height: 0.8em; vertical-align: -0.05em; margin-inline-end: 0.1em; fill: currentColor; }
.weather { width: 1.125em; height: 1.125em; vertical-align: -0.2em; }
.support { width: 1em; height: 1em; vertical-align: -0.125em; fill: var(--good); }
.support.no { fill: var(--muted); }
.support.warn { fill: var(--caution); margin-inline-start: 0.375em; }
.footnote .support.warn { margin-inline: 0 0.25em; }
td.n > .support.warn:first-child { margin-inline: 0 0.375em; }
.icon { width: 1.375em; height: 1.375em; vertical-align: -0.3em; margin-inline-end: 0.5em; overflow: visible; }
.plot { position: relative; anchor-scope: --point; }
/* Script moves this to the hovered point; the fixed tooltip anchors beside it and flips sides at the viewport edge, since it is wider than the plot. */
.tooltip-anchor { position: absolute; inset-block: 0; width: 0; anchor-name: --point; }
.plot svg { display: block; width: 100%; height: auto; overflow: visible; }
.plot svg:focus-visible { outline: 2px solid var(--text-2); outline-offset: 4px; border-radius: 4px; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dot { stroke: var(--surface); stroke-width: 2; }
.multiples { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 1.5em; }
.panel h3 { font-size: 0.875em; font-weight: 500; margin: 0 0 0.5em; }
.line.dotted { stroke-dasharray: 0 4; }
.line.dashed { stroke-dasharray: 5 4; stroke-linecap: butt; }
.keys i.dotted, .tooltip i.dotted { height: 0; background: none; border-top: 2px dotted currentColor; }
/* Drawn as a gradient so short keys still show clear gaps, matching the chart's dash pattern. */
.keys i.dashed, .tooltip i.dashed { width: 18px; background: repeating-linear-gradient(90deg, currentColor 0 5px, transparent 5px 9px); }
.tick.secondary { opacity: 0.7; }
.keys { display: flex; flex-wrap: wrap; gap: 0.25em 1em; list-style: none; padding: 0; margin: 0; color: var(--text-2); font-size: 0.8125em; }
.keys li { display: flex; align-items: center; gap: 0.4em; }
.keys i, .tooltip i { width: 12px; height: 2px; border-radius: 1px; }
.keys i { color: var(--text-2); background: currentColor; }
.area { opacity: 0.1; }
.version-mark { stroke: var(--axis); stroke-width: 1; stroke-dasharray: 2 2; }
.tick.version { font-size: 8px; }
.crosshair { stroke: var(--axis); stroke-width: 1; }
.tooltip {
	position: fixed;
	z-index: 1;
	position-anchor: --point;
	top: anchor(top);
	left: anchor(right);
	margin-inline-start: 12px;
	position-try-fallbacks: flip-inline;
	pointer-events: none;
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 8px;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
	padding: 0.5em 0.75em;
	font-size: 0.8125em;
	white-space: nowrap;
}
.tooltip .date { color: var(--text-2); margin-block-end: 0.25em; }
.tooltip .row { display: flex; align-items: center; gap: 0.5em; }
.tooltip i { width: 12px; height: 2px; border-radius: 1px; }
.tooltip b { font-variant-numeric: tabular-nums; min-width: 2.5em; }
.tooltip span { color: var(--text-2); }
.scroll { overflow-x: auto; }
/* Tables run to the card edge, with outer cells padded to match the page. */
.card .scroll { margin-inline: calc(-1 * var(--page-pad-inline)); }
.card .scroll :is(th, td):first-child { padding-inline-start: var(--page-pad-inline); }
.card .scroll :is(th, td):last-child { padding-inline-end: var(--page-pad-inline); }
table { border-collapse: collapse; width: 100%; font-size: 0.875em; }
table.compact { width: auto; }
/* Each column group starts with extra space, and its header underline stops short so groups read apart. */
table.compact tbody > tr > :is(:nth-child(2), :nth-child(4), :nth-child(6)),
table.compact thead > tr:last-child > :is(:nth-child(1), :nth-child(3), :nth-child(5)),
th.group { padding-inline-start: 2em; }
th.group { text-align: center; border-block-end: 0; background: linear-gradient(var(--axis), var(--axis)) right bottom / calc(100% - 2em) 1px no-repeat; }
thead th[rowspan] { vertical-align: bottom; }
th, td { padding: 0.4em 0.6em; text-align: start; border-block-end: 1px solid var(--grid); white-space: nowrap; }
thead th { color: var(--text-2); font-weight: 500; }
tbody th { font-weight: 500; }
.n { text-align: end; font-variant-numeric: tabular-nums; }
.strong { font-weight: 600; }
.third-party { color: var(--muted); font-size: 0.8125em; font-weight: 400; }
summary { cursor: pointer; color: var(--text-2); font-size: 0.875em; }
.ecosystem summary { color: var(--text); font-size: 0.9375em; }
.packages { columns: 18em; list-style: disc; padding: 0; margin: 0.75em 0 0; font-size: 0.8125em; }
/* Each item gets its own margin, not padding on the list, so markers stay inside every column. */
.packages li { break-inside: avoid; padding-block: 0.1em; margin-inline-start: 1.25em; }
.packages .bundled-heading { list-style: none; margin-inline-start: 0; font-weight: 600; padding-block-start: 0.5em; break-after: avoid; }
/* Severity pills wrap between pills, never inside one. */
td.sev { white-space: normal; line-height: 1.6; min-width: 12em; }
/* A fixed line height keeps severity and forecast pills the same height wherever they sit. */
.badge { display: inline-flex; align-items: center; line-height: 1.5; white-space: nowrap; font-size: 0.875em; padding: 0 0.4em; border-radius: 4px; color: #fff; }
.badge.critical { background: var(--critical); }
.badge.high { background: var(--serious); color: #0b0b0b; }
.badge.severe { background: var(--severe); color: #0b0b0b; }
.badge.moderate { background: var(--warning); color: #0b0b0b; }
.badge.low { background: #c3c2b7; color: #0b0b0b; }
/* An inset shadow outlines the pill without changing its height. */
/* A translucent tint stays subtle on both light and dark surfaces. */
.badge.none { background: rgb(255 214 10 / 0.12); color: var(--text); box-shadow: inset 0 0 0 1px var(--sun); }
.badge.age, .badge.bundling { color: var(--text-2); font-weight: 500; box-shadow: inset 0 0 0 1px var(--axis); }
/* A translucent purple stays subtle in both modes. */
/* Header pills are a key, not data, so they sit back. */
.badge.key { opacity: 0.65; }
.badge.bundling { background: rgb(100 108 255 / 0.14); }
.badge.rank { gap: 0.3em; font-weight: 600; }
/* The divider runs the full pill height since pills have no block padding. */
.badge .count { font-weight: 600; padding-inline-start: 0.4em; margin-inline-start: 0.4em; border-inline-start: 1px solid color-mix(in srgb, currentColor 40%, transparent); }
.badge.rank .weather { fill: currentColor; }
.bundle { width: 1em; height: 1em; vertical-align: -0.125em; margin-inline-end: 0.3em; fill: currentColor; }
.badge.rank.none .weather { fill: var(--sun); }
.flows { display: grid; grid-template-columns: repeat(auto-fit, minmax(16em, 1fr)); gap: 1em 2em; max-width: 46em; }
.flow { display: block; width: 100%; max-width: 340px; overflow: visible; }
.flow-track { stroke: var(--axis); stroke-width: 2; }
.flow-track.dashed { stroke-dasharray: 4 4; }
.tick.flow-note { font-size: 9px; }
.flow-icon { fill: var(--text-2); }
.flow-bug { fill: var(--critical); transform-box: fill-box; transform-origin: center; }
.flow-dot { fill: var(--text); opacity: 0; }
/* Both lanes share a duration and speed, so the static request turns back at the HTML while the other reaches the bug. */
.flow .flow-dot, .flow .flow-middle, .flow .flow-bug { animation: 3.2s linear infinite; }
.static .flow-dot { animation-name: flow-bounce; }
.static .flow-middle { animation-name: flow-served; }
.request-time .flow-dot { animation-name: flow-through; }
.request-time .flow-bug { animation-name: flow-hit; }
@keyframes flow-bounce {
	0% { transform: translateX(0); opacity: 0; }
	5% { opacity: 1; }
	33% { transform: translateX(110px); }
	62% { opacity: 1; }
	66%, 100% { transform: translateX(0); opacity: 0; }
}
@keyframes flow-through {
	0% { transform: translateX(0); opacity: 0; }
	5%, 78% { opacity: 1; }
	80%, 100% { transform: translateX(260px); opacity: 0; }
}
@keyframes flow-served {
	0%, 30%, 50%, 100% { fill: var(--text-2); }
	34% { fill: var(--good); }
}
@keyframes flow-hit {
	0%, 77%, 95%, 100% { scale: 1; }
	83% { scale: 1.35; }
}
@media (prefers-reduced-motion: reduce) {
	.flow .flow-dot, .flow .flow-middle, .flow .flow-bug { animation: none; }
}
</style>
</head>
<body>
${sprite}
<!-- zachleat nav (2026-09-15) -->
<style>
.demo-nav{all:initial;--demo-nav-bg:light-dark(#f4f6f4b3,#1e201eb3);--demo-nav-bg-solid:light-dark(#fff,#1b1b1b);--demo-nav-text:light-dark(#222,#f2f2f2);--demo-nav-muted:light-dark(#525252,#a9a9a9);--demo-nav-border:light-dark(#d2ded2,#2f3a2f);--demo-nav-green:light-dark(#4caf50,#6cc470);--demo-nav-primary:light-dark(#3c603c,#9ccf9f);--demo-nav-accent:light-dark(#f525e9,#ff6df5);--demo-nav-icon-bg:light-dark(#0000000d,#ffffff14);--demo-nav-radius:.25em;--demo-nav-font:Lato, Numero, system-ui, -apple-system, sans-serif;--demo-nav-font-mono:Consolas, Monaco, ui-monospace, monospace;box-sizing:border-box;isolation:isolate;color-scheme:light dark;background-color:var(--demo-nav-bg);border-block-end:1px solid var(--demo-nav-border);color:var(--demo-nav-text);font-family:var(--demo-nav-font);text-align:start;flex-wrap:wrap;align-items:center;gap:.5em 1.5em;padding:.75em clamp(.75em,3vw,1.5em);line-height:1.4;display:flex}.demo-nav *,.demo-nav :before,.demo-nav :after{all:unset;display:revert;box-sizing:border-box}.demo-nav a{color:var(--demo-nav-text);cursor:pointer;text-decoration:underline;text-decoration-color:var(--demo-nav-green);text-underline-offset:.2em;text-decoration-thickness:.09em}.demo-nav a:hover,.demo-nav a:focus,.demo-nav a:active{color:var(--demo-nav-green)}.demo-nav a:focus-visible{outline:2px solid var(--demo-nav-accent);outline-offset:3px;border-radius:var(--demo-nav-radius)}@media (height>=30em){.demo-nav{z-index:1;position:sticky;top:0}@supports (backdrop-filter:blur(1px)){.demo-nav{backdrop-filter:saturate(180%)blur(10px)}}}.demo-nav.demo-nav-static{position:static}.demo-nav .demo-nav-icon{border-radius:var(--demo-nav-icon-radius,var(--demo-nav-radius));background-color:var(--demo-nav-icon-bg);object-fit:contain;flex-shrink:0;width:1.15em;height:1.15em;display:block;overflow:hidden}.demo-nav .demo-nav-home{color:var(--demo-nav-primary);flex-shrink:0;align-items:center;gap:.4em;font-weight:700;text-decoration:none;display:inline-flex}.demo-nav .demo-nav-home:hover{color:var(--demo-nav-green);text-underline-offset:.2em;text-decoration:underline}.demo-nav .demo-nav-suffix{color:var(--demo-nav-muted);font-weight:400}.demo-nav .demo-nav-home .demo-nav-icon{border-radius:var(--demo-nav-icon-radius,50%);width:1.6em;height:1.6em}.demo-nav .demo-nav-heading{flex:12em;min-width:0}.demo-nav .demo-nav-title{color:var(--demo-nav-text);margin:0;font-size:1em;font-weight:700;line-height:1.3;display:block}.demo-nav .demo-nav-description{color:var(--demo-nav-muted);text-wrap:pretty;margin:0;font-size:.8125em;display:block}.demo-nav .demo-nav-links{flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:.25em 1em;max-width:24em;margin-inline-start:auto;font-size:.875em;display:flex}.demo-nav .demo-nav-links a{align-items:center;gap:.4em;display:inline-flex}.demo-nav .demo-nav-code{font-family:var(--demo-nav-font-mono);font-size:.9em}.demo-nav .demo-nav-skip{clip-path:inset(50%);white-space:nowrap;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}.demo-nav .demo-nav-skip:focus-visible{clip-path:none;background-color:var(--demo-nav-bg-solid);width:auto;height:auto;margin:0;padding:.25em .5em;position:static;overflow:visible}@media (width<=30em){.demo-nav .demo-nav-links{flex-basis:100%;justify-content:flex-start;max-width:none;margin-inline-start:0}}@media print{.demo-nav{border-block-end-width:0}.demo-nav .demo-nav-links,.demo-nav .demo-nav-skip{display:none}}
</style>
<header class="demo-nav">
	<a class="demo-nav-skip" href="#main">Skip to content</a>
	<a class="demo-nav-home" href="https://www.zachleat.com/">
		<img class="demo-nav-icon" src="https://v1.indieweb-avatar.11ty.dev/https%3A%2F%2Fwww.zachleat.com%2F/" alt="" width="48" height="48" decoding="async">
		<span>zachleat</span>
	</a>
	<nav class="demo-nav-links" aria-label="Demo links">
		<a href="https://github.com/zachleat/prototype-pollution-report"><img class="demo-nav-icon" src="https://v1.indieweb-avatar.11ty.dev/https%3A%2F%2Fgithub.com%2Fzachleat%2Fprototype-pollution-report/" alt="" width="24" height="24" decoding="async">Source</a>
		<a href="https://www.zachleat.com/projects/"><img class="demo-nav-icon" src="https://v1.indieweb-avatar.11ty.dev/https%3A%2F%2Fwww.zachleat.com%2Fprojects%2F/" alt="" width="24" height="24" decoding="async">All Projects</a>
	</nav>
</header>
<!-- /zachleat nav -->
<main id="main">
<header>
	<h1>Prototype Pollution Report</h1>
	<p class="note">Every non-deprecated package published by each framework’s npm organization, installed as of the first of each month and checked with <code>npm audit</code>. Last updated ${lastUpdated}.</p>
</header>

<section class="stack">
	<p class="note">Forecasts weight each vulnerability by severity (${Object.entries(SEVERITY_POINTS).map(([sev, points]) => `${sev} ${points}`).join(", ")}) and rank the total from clear to storms.</p>
	${forecastLegend}
</section>

<section class="card">
	<div class="stack">
		${renderingTable}
		<p class="footnote">In a static build, server dependencies are limited to the build machine. A ReDoS in a Markdown parser might slow down a build, but visitors can’t trigger it. ${cautionIcon(REQUEST_TIME_WARNING)}Request-time code runs on a live server, where anyone loading a page can reach it. Note that client dependencies ship to the browser either way, so their vulnerabilities can affect both Build-time and Request-time projects.</p>
		${flows}
	</div>
</section>

<section class="card">
	<hgroup>
		<h2>Ecosystem Scoreboard</h2>
		<p class="note">As of ${formatDate(latestDate)}, sorted by fewest vulnerabilities.</p>
	</hgroup>
	<div class="stack">
		${scoreboard}
		<ul class="footnotes">
			<li>Vulnerabilities are affected packages in the install tree, as reported by <code>npm audit</code>. Next.js and Vite bundle many dependencies into their published code, and those are checked too wherever they appear in the install tree. Raw npm audit leaves them out.</li>
			<li>Note that Vite’s bundled dependencies run in its dev server and at build time, not when serving production requests.</li>
			<li>Advisories are distinct GitHub security advisories matched anywhere in the install tree. One advisory can flag every package that depends on the affected one, and one package can have several advisories, so this can be higher or lower than Vulnerabilities.</li>
			<li>Dependencies are unique <code>name@version</code> pairs across the whole ecosystem, installed together in one tree. Shared dependencies count once per version. Platform-specific builds of a native package (one per OS and CPU) count once. Third-party means not published by the framework’s npm organization.</li>
			<li>Past dates only count advisories published by that date.</li>
			<li>Snapshots are fresh installs, which pick up the newest patch releases each package allows.</li>
			<li>Each ecosystem also installs its core package’s required peer dependencies, like Vite for SvelteKit or React for Next.js, and its core package’s version of Vite (or the latest Vite, if the core doesn’t use it), so older versions from stale packages don’t displace it. Peer dependencies of other official packages aren’t installed.</li>
			<li>Forecasts count every package equally and are not currently weighted by download count.</li>
		</ul>
	</div>
	${smallMultiples({ id: "vulnerabilities", title: "Vulnerabilities over time (all official packages)", order: latest.map(({ f }) => f.id), measures: [{ label: "Vulnerabilities", value: s => s.vulnerabilities.total }, { label: "Dependencies", value: s => s.dependencies }, { label: "Raw npm audit (bundled dependencies not counted)", tooltip: "Raw npm audit", value: s => s.nonVendoredVulnerabilities?.total ?? s.vulnerabilities.total }] })}
	${failures.length ? `<p class="note">Missing data, where the install failed: ${failures.map(s => `${esc(series.find(f => f.id === s.framework)?.name ?? s.framework)} on ${formatDate(s.date)}`).join(", ")}.</p>` : ""}
	<div class="stack">
		<h3>Package Lists</h3>
		${details}
	</div>
</section>

<section class="card">
	<hgroup>
		<h2>Core Scoreboard</h2>
		<p class="note">Each framework’s main package installed on its own. As of ${formatDate(latestDate)}, sorted by fewest vulnerabilities.</p>
	</hgroup>
	<div class="stack">
		${coreScoreboard}
		<ul class="footnotes">
			<li>Includes required peer dependencies, like Vite and Svelte for SvelteKit.</li>
			<li>Note that Vite’s bundled dependencies run in its dev server and at build time, not when serving production requests.</li>
			<li>Forecasts count every package equally and are not currently weighted by download count.</li>
		</ul>
	</div>
	${smallMultiples({ id: "core-vulnerabilities", title: "Vulnerabilities over time (core package only)", order: latestCore.map(({ f }) => f.id), measures: [{ label: "Vulnerabilities", value: s => s.core?.vulnerabilities.total }, { label: "Dependencies", value: s => s.core?.dependencies }, { label: "Raw npm audit (bundled dependencies not counted)", tooltip: "Raw npm audit", value: s => s.core?.nonVendoredVulnerabilities?.total ?? s.core?.vulnerabilities.total }], nameOf: f => f.coreName ?? f.name, versionOf: s => s.core?.version })}
</section>
</main>
<script type="module">
// Hours since the last update, relative to the viewer's clock.
for (const time of document.querySelectorAll("time[data-since]")) {
	const hours = Math.round((Date.now() - new Date(time.dateTime)) / 36e5);
	time.after(" (" + (hours < 1 ? "less than an hour ago" : new Intl.RelativeTimeFormat("en-US").format(-hours, "hour")) + ")");
}

for (const svg of document.querySelectorAll("svg[data-points]")) {
	const points = JSON.parse(svg.dataset.points);
	const labels = JSON.parse(svg.dataset.labels);
	const anchor = svg.parentElement.querySelector(".tooltip-anchor");
	const tooltip = svg.parentElement.querySelector(".tooltip");
	const crosshair = svg.querySelector(".crosshair");
	let index = -1;

	function show(i) {
		index = Math.max(0, Math.min(points.length - 1, i));
		const p = points[index];
		crosshair.setAttribute("x1", p.x);
		crosshair.setAttribute("x2", p.x);
		crosshair.removeAttribute("visibility");

		const date = document.createElement("div");
		date.className = "date";
		date.textContent = p.version ? p.label + " · " + p.version : p.label;
		const rows = p.values
			.map((value, k) => ({ value, ...labels[k] }))
			.filter(r => r.value != null)
			.map(({ value, name: label, color, style }) => {
				const row = document.createElement("div");
				row.className = "row";
				const key = document.createElement("i");
				if (style) {
					key.classList.add(style);
				}
				key.style[style ? "color" : "background"] = color;
				const b = document.createElement("b");
				b.textContent = value.toLocaleString("en-US");
				const name = document.createElement("span");
				name.textContent = label;
				row.append(key, b, name);
				return row;
			});
		tooltip.replaceChildren(date, ...rows);
		tooltip.hidden = false;
		anchor.style.left = p.x / svg.viewBox.baseVal.width * 100 + "%";
	}

	function hide() {
		crosshair.setAttribute("visibility", "hidden");
		tooltip.hidden = true;
	}

	svg.addEventListener("pointermove", e => {
		const x = (e.clientX - svg.getBoundingClientRect().left) * svg.viewBox.baseVal.width / svg.clientWidth;
		let nearest = 0;
		points.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(points[nearest].x - x)) nearest = i; });
		if (nearest !== index) show(nearest);
	});
	svg.addEventListener("pointerleave", () => { index = -1; hide(); });
	svg.addEventListener("focus", () => show(points.length - 1));
	svg.addEventListener("blur", hide);
	svg.addEventListener("keydown", e => {
		if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
			e.preventDefault();
			show(index + (e.key === "ArrowLeft" ? -1 : 1));
		}
	});
}
</script>
</body>
</html>
`;

await writeFile(OUTPUT, html);
console.log(`Wrote index.html (${dates.length} dates)`);
