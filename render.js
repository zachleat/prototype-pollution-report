import { readFile, writeFile } from "node:fs/promises";
import { faCircleCheck as faCircleCheckRegular, faCircleXmark } from "@fortawesome/free-regular-svg-icons";
import { faArrowDown, faArrowUp, faCircleCheck, faCloud, faCloudBolt, faCloudRain, faCloudSun, faSun } from "@fortawesome/free-solid-svg-icons";
import frameworks from "./frameworks.js";

const snapshots = JSON.parse(await readFile(new URL("./data/snapshots.json", import.meta.url), "utf8"));
const OUTPUT = new URL("./index.html", import.meta.url);

const SEVERITIES = ["critical", "high", "moderate", "low"];
// Forecast by vulnerability count, like an air-quality report: the first bucket whose `max` the total fits under.
// Colors run from sun yellow (clear) to muddy brown (storms).
const FORECAST = [
	{ id: "clear", label: "Clear", max: 0, icon: faSun },
	{ id: "partly-cloudy", label: "Partly cloudy", max: 9, icon: faCloudSun },
	{ id: "cloudy", label: "Cloudy", max: 49, icon: faCloud },
	{ id: "rain", label: "Rain", max: 149, icon: faCloudRain },
	{ id: "storms", label: "Storms", max: Infinity, icon: faCloudBolt },
];
const forecast = total => {
	let { id, label } = FORECAST.find(f => total <= f.max);
	return `<td class="forecast" title="${label}"><svg class="icon weather" style="fill:var(--weather-${id})" role="img" aria-label="${label}"><use href="#weather-${id}"/></svg></td>`;
};

// Change since the previous snapshot: red up arrow for more, green down arrow for fewer.
const delta = (total, previous) => {
	let change = previous == null ? 0 : total - previous;
	if (!change) {
		return "";
	}
	let direction = change > 0 ? "up" : "down";
	return `<span class="delta ${direction}" title="${change > 0 ? "Up" : "Down"} ${num(Math.abs(change))} since ${formatDate(dates.at(-2))}"><svg class="trend" aria-hidden="true"><use href="#trend-${direction}"/></svg>${num(Math.abs(change))}</span>`;
};

const SUPPORT = {
	default: { label: "Default", icon: faCircleCheck },
	yes: { label: "Optional", icon: faCircleCheckRegular },
	no: { label: "No", icon: faCircleXmark },
};
const support = value => `<td><svg class="icon support ${value}" aria-hidden="true"><use href="#support-${value}"/></svg>${SUPPORT[value].label}</td>`;

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const num = n => (n ?? "—").toLocaleString("en-US");
const compact = n => new Intl.NumberFormat("en-US", { notation: "compact" }).format(n).toLowerCase();
const time = d => new Date(`${d}T00:00:00Z`).getTime();
const formatDate = (d, opts = { month: "short", day: "numeric", year: "numeric" }) =>
	new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(time(d));

const dates = [...new Set(snapshots.map(s => s.date))].sort();
const latestDate = dates.at(-1);
const byKey = new Map(snapshots.map(s => [`${s.date}|${s.framework}`, s]));
const get = (date, id) => byKey.get(`${date}|${id}`);
const series = frameworks.map((f, i) => ({ ...f, slot: i + 1 }));
const seriesVars = mode => series.map(f => `--series-${f.slot}: ${f.color[mode]};`).join("\n\t\t");

const symbol = (id, { icon: [w, h, , , d] }) => `<symbol id="${id}" viewBox="0 0 ${w} ${h}"><path d="${d}"/></symbol>`;
const sprite = `<svg class="sprite" aria-hidden="true">${[
	...series.map(f => symbol(`icon-${f.id}`, f.icon)),
	...Object.entries(SUPPORT).map(([key, { icon }]) => symbol(`support-${key}`, icon)),
	...FORECAST.map(({ id, icon }) => symbol(`weather-${id}`, icon)),
	symbol("trend-up", faArrowUp),
	symbol("trend-down", faArrowDown),
].join("")}</svg>`;
const icon = f => `<svg class="icon" aria-hidden="true" style="fill:var(--series-${f.slot})"><use href="#icon-${f.id}"/></svg>`;
const pills = counts => SEVERITIES.map(sev => counts[sev] ? ` <span class="badge ${sev}">${num(counts[sev])} ${sev}</span>` : "").join("");
const packagePills = p => p.vulnerabilities ? pills(p.vulnerabilities) : ` <span class="badge ${p.severity}">${p.severity}</span>`;
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
function smallMultiples({ id, title, description, measures, nameOf = f => f.name, versionOf }) {
	let x = timeX(SM.left, SW - SM.left - SM.right);
	let [primary, secondary, alt] = measures.map(m => {
		let rows = chartRows(m.value);
		let { ticks, ratio } = linearScale(rowsMax(rows), 3);
		return { ...m, rows, ticks, y: v => SH - SM.bottom - ratio(v) * (SH - SM.top - SM.bottom) };
	});
	let pathFor = ({ rows, y }, i) => rows.map((r, j) => r.values[i] == null ? "" : `${j && rows[j - 1].values[i] != null ? "L" : "M"}${x(r.date).toFixed(1)},${y(r.values[i]).toFixed(1)}`).join("");

	let panels = series.map((f, i) => {
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
		let labels = [{ name: primary.label, color }, { name: alt?.label, color, style: "dashed" }, { name: secondary.label, color, style: "dotted" }];
		return `<div class="panel">
			<h3>${icon(f)}${esc(nameOf(f))}</h3>
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

let renderingTable = `<div class="scroll"><table class="scoreboard compact">
	<thead>
		<tr>
			<th rowspan="2">Framework</th>
			<th colspan="2" class="group">Rendering</th>
			<th colspan="2" class="group">Navigation</th>
		</tr>
		<tr>
			<th>Static</th>
			<th>Request-time</th>
			<th>MPA</th>
			<th>SPA</th>
		</tr>
	</thead>
	<tbody>${series.toSorted((a, b) => a.name.localeCompare(b.name)).map(f => `<tr>
		<th scope="row">${icon(f)}${esc(f.name)}</th>
		${support(f.static)}
		${support(f.requestTime)}
		${support(f.mpa)}
		${support(f.spa)}
	</tr>`).join("")}</tbody>
</table></div>`;

let scoreboard = `<div class="scroll"><table class="scoreboard">
	<thead><tr>
		<th>Forecast</th>
		<th>Framework</th>
		<th class="n">Vulnerabilities<br><span class="third-party">(Raw npm audit)</span></th>
		<th class="n">Advisories</th>
		<th class="n">Packages</th>
		<th class="n">Dependencies<br><span class="third-party">(Third-party)</span></th>
		<th>Severity</th>
	</tr></thead>
	<tbody>${latest.map(({ f, s }) => `<tr>
		${forecast(s.vulnerabilities.total)}
		<th scope="row">${icon(f)}${esc(f.name)}</th>
		<td class="n strong">${num(s.vulnerabilities.total)}${delta(s.vulnerabilities.total, get(dates.at(-2), f.id)?.vulnerabilities?.total)}${rawAudit(s)}</td>
		<td class="n">${num(s.advisories.total)}</td>
		<td class="n">${num(s.packageCount)}</td>
		<td class="n">${num(s.dependencies)}<br><span class="third-party">(${num(s.thirdPartyDependencies)})</span></td>
		<td class="sev">${pills(s.vulnerabilities) || `<span class="muted">—</span>`}</td>
	</tr>`).join("")}</tbody>
</table></div>`;

let coreScoreboard = `<div class="scroll"><table class="scoreboard">
	<thead><tr>
		<th>Forecast</th>
		<th>Package</th>
		<th class="n">Vulnerabilities<br><span class="third-party">(Raw npm audit)</span></th>
		<th class="n">Advisories</th>
		<th class="n">Dependencies<br><span class="third-party">(Third-party)</span></th>
		<th>Severity</th>
	</tr></thead>
	<tbody>${latest.filter(({ s }) => s.core).sort((a, b) => a.s.core.vulnerabilities.total - b.s.core.vulnerabilities.total).map(({ f, s: { core } }) => `<tr>
		${forecast(core.vulnerabilities.total)}
		<th scope="row">${icon(f)}<a href="https://www.npmjs.com/package/${esc(core.name)}/v/${esc(core.version)}">${esc(core.name)}</a> <span class="muted">${esc(core.version)}</span></th>
		<td class="n strong">${num(core.vulnerabilities.total)}${delta(core.vulnerabilities.total, get(dates.at(-2), f.id)?.core?.vulnerabilities.total)}${rawAudit(core)}</td>
		<td class="n">${num(core.advisories.total)}</td>
		<td class="n">${num(core.dependencies)}<br><span class="third-party">(${num(core.thirdPartyDependencies)})</span></td>
		<td class="sev">${pills(core.vulnerabilities) || `<span class="muted">—</span>`}</td>
	</tr>`).join("")}</tbody>
</table></div>`;


let details = latest.map(({ f, s }) => `<details class="ecosystem">
	<summary>${icon(f)}${esc(f.name)}: ${(affected => `${num(affected)} of ${num(s.packageCount)} official packages (${Math.round(affected / s.packageCount * 100)}%) affected`)(s.vulnerablePackages.filter(p => !p.vendoredBy).length)}</summary>
	<ul class="packages">${Object.entries(s.packages).map(([name, version]) => {
		let vuln = s.vulnerablePackages.find(p => p.name === name && !p.vendoredBy);
		return `<li><a href="https://www.npmjs.com/package/${esc(name)}/v/${esc(version)}">${esc(name)}</a> <span class="muted">${esc(version)}</span>${vuln ? packagePills(vuln) : ""}</li>`;
	}).join("")}</ul>
	${Object.entries(s.vendored || {}).map(([parent, deps]) => {
		let specs = Object.values(deps);
		let vulnerable = s.vulnerablePackages.filter(p => p.vendoredBy === parent);
		let unresolved = s.unresolvedVendored?.[parent] || [];
		return `<p class="note"><code>${esc(parent)}</code> bundles ${num(specs.length)} packages in <code>dist/compiled</code>. ${num(vulnerable.length)} have vulnerabilities:</p>
	<ul class="packages">${vulnerable.map(p => {
		let spec = specs.find(v => v.startsWith(`${p.name}@`)) || p.name;
		return `<li>${esc(spec)}${packagePills(p)}</li>`;
	}).join("")}</ul>
	${unresolved.length ? `<p class="note">Not published to npm, so not checked: ${unresolved.map(esc).join(", ")}.</p>` : ""}`;
	}).join("")}
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
	--weather-clear: #e0a100;
	--weather-partly-cloudy: #c99a3e;
	--weather-cloudy: #ad8a52;
	--weather-rain: #927048;
	--weather-storms: #7a5a3a;
	--good: #0ca30c;
	--critical: #d03b3b;
	--serious: #ec835a;
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
		--weather-clear: #f5b400;
		--weather-partly-cloudy: #d9ab52;
		--weather-cloudy: #c19b68;
		--weather-rain: #a8845c;
		--weather-storms: #94704c;
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
	--weather-clear: #f5b400;
	--weather-partly-cloudy: #d9ab52;
	--weather-cloudy: #c19b68;
	--weather-rain: #a8845c;
	--weather-storms: #94704c;
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--page);
	color: var(--text);
	font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
	line-height: 1.5;
}
main { max-width: 64em; margin-inline: auto; padding: 2em 1em 4em; }
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
	padding: 1.5em;
	display: flex;
	flex-direction: column;
	gap: 2em;
}
figure { margin: 0; display: flex; flex-direction: column; gap: 1.25em; }
.stack { display: flex; flex-direction: column; gap: 0.75em; }
.footnotes, .footnote { color: var(--text-2); font-size: 0.8125em; max-width: 46em; margin: 0; }
.footnotes { padding-inline-start: 1.25em; }
.footnotes li + li { margin-block-start: 0.25em; }
.sprite { position: absolute; width: 0; height: 0; }
.delta { font-size: 0.8125em; font-weight: 500; margin-inline-start: 0.375em; white-space: nowrap; }
.delta.up { color: var(--critical); }
.delta.down { color: var(--good); }
/* Font Awesome arrows are 384 wide by 512 tall, so match that ratio to avoid side padding. */
.trend { width: 0.6em; height: 0.8em; vertical-align: -0.05em; margin-inline-end: 0.1em; fill: currentColor; }
.weather { width: 1.125em; height: 1.125em; vertical-align: -0.2em; }
.support { width: 1em; height: 1em; vertical-align: -0.125em; fill: var(--good); }
.support.no { fill: var(--muted); }
.icon { width: 1.375em; height: 1.375em; vertical-align: -0.3em; margin-inline-end: 0.5em; overflow: visible; }
.plot { position: relative; }
.plot svg { display: block; width: 100%; height: auto; overflow: visible; }
.plot svg:focus-visible { outline: 2px solid var(--text-2); outline-offset: 4px; border-radius: 4px; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dot { stroke: var(--surface); stroke-width: 2; }
.multiples { display: grid; grid-template-columns: repeat(auto-fill, minmax(14em, 1fr)); gap: 1.5em; }
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
	position: absolute;
	top: 0;
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
table { border-collapse: collapse; width: 100%; font-size: 0.875em; }
table.compact { width: auto; }
/* Each column group starts with extra space, and its header underline stops short so groups read apart. */
table.compact tbody > tr > :is(:nth-child(2), :nth-child(4)),
table.compact thead > tr:last-child > :is(:nth-child(1), :nth-child(3)),
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
.packages { columns: 18em; list-style: none; padding: 0; margin: 0.75em 0 0; font-size: 0.8125em; }
.packages li { break-inside: avoid; padding-block: 0.1em; }
/* Severity pills wrap between pills, never inside one. */
td.sev { white-space: normal; line-height: 1.4; min-width: 12em; }
.badge { white-space: nowrap; font-size: 0.75em; padding: 0 0.4em; border-radius: 4px; color: #fff; }
.badge.critical { background: var(--critical); }
.badge.high { background: var(--serious); color: #0b0b0b; }
.badge.moderate { background: var(--warning); color: #0b0b0b; }
.badge.low { background: var(--axis); color: #0b0b0b; }
</style>
</head>
<body>
${sprite}
<main>
<header>
	<h1>Prototype Pollution Report</h1>
	<p class="note">Every non-deprecated package published by each framework’s npm organization, installed as of the first of each month and checked with <code>npm audit</code>. Last updated ${formatDate(latestDate)}.</p>
</header>

<section class="card">
	<hgroup>
		<h2>Rendering</h2>
		<p class="note">Static output or server code that runs on every request, and full page loads (MPA) or a client-side router (SPA).</p>
	</hgroup>
	<div class="stack">
		${renderingTable}
		<script>
		// Shuffle rows on every load (alphabetical without JS); inline so it runs before first paint.
		{
			let tbody = document.currentScript.previousElementSibling.querySelector("tbody");
			let rows = [...tbody.rows];
			for (let i = rows.length - 1; i > 0; i--) {
				let j = Math.floor(Math.random() * (i + 1));
				[rows[i], rows[j]] = [rows[j], rows[i]];
			}
			tbody.append(...rows);
		}
		</script>
		<p class="footnote">In a static build, dependencies only run on the build machine. A ReDoS in a Markdown parser might slow down a build, but visitors can’t trigger it. Request-time code runs on a live server, where anyone loading a page can reach it.</p>
	</div>
</section>

<section class="card">
	<hgroup>
		<h2>Scoreboard</h2>
		<p class="note">As of ${formatDate(latestDate)}, sorted by fewest vulnerabilities.</p>
	</hgroup>
	<div class="stack">
		${scoreboard}
		<ul class="footnotes">
			<li>Vulnerabilities are affected packages in the install tree, as reported by <code>npm audit</code>. Next.js bundles many dependencies into <code>dist/compiled</code>, and those are checked too. Raw npm audit leaves them out.</li>
			<li>Advisories are distinct GitHub security advisories matched anywhere in the install tree. One advisory can flag every package that depends on the affected one, and one package can have several advisories, so this can be higher or lower than Vulnerabilities.</li>
			<li>Dependencies are unique <code>name@version</code> pairs across the whole ecosystem, installed together in one tree. Shared dependencies count once per version. Platform-specific builds of a native package (one per OS and CPU) count once. Third-party means not published by the framework’s npm organization.</li>
			<li>Past dates only count advisories published by that date.</li>
			<li>Snapshots are fresh installs, which pick up the newest patch releases each package allows.</li>
		</ul>
	</div>
	<div class="stack">
		<h3>Package Lists</h3>
		${details}
	</div>
	${smallMultiples({ id: "vulnerabilities", title: "Vulnerabilities over time", description: "All official packages.", measures: [{ label: "Vulnerabilities", value: s => s.vulnerabilities.total }, { label: "Dependencies", value: s => s.dependencies }, { label: "Raw npm audit", value: s => s.nonVendoredVulnerabilities?.total ?? s.vulnerabilities.total }] })}
	${failures.length ? `<p class="note">Missing data, where the install failed: ${failures.map(s => `${esc(series.find(f => f.id === s.framework)?.name ?? s.framework)} on ${formatDate(s.date)}`).join(", ")}.</p>` : ""}
</section>

<section class="card">
	<hgroup>
		<h2>Core package</h2>
		<p class="note">Each framework’s main package installed on its own. As of ${formatDate(latestDate)}, sorted by fewest vulnerabilities.</p>
	</hgroup>
	<div class="stack">
		${coreScoreboard}
		<ul class="footnotes">
			<li>Includes required peer dependencies, like Vite and Svelte for SvelteKit.</li>
		</ul>
	</div>
	${smallMultiples({ id: "core-vulnerabilities", title: "Vulnerabilities over time (core/primary package only)", measures: [{ label: "Vulnerabilities", value: s => s.core?.vulnerabilities.total }, { label: "Dependencies", value: s => s.core?.dependencies }, { label: "Raw npm audit", value: s => s.core?.nonVendoredVulnerabilities?.total ?? s.core?.vulnerabilities.total }], nameOf: f => f.coreName ?? f.name, versionOf: s => s.core?.version })}
</section>
</main>
<script type="module">
for (const svg of document.querySelectorAll("svg[data-points]")) {
	const points = JSON.parse(svg.dataset.points);
	const labels = JSON.parse(svg.dataset.labels);
	const tooltip = svg.nextElementSibling;
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

		const scale = svg.clientWidth / svg.viewBox.baseVal.width;
		const left = p.x * scale;
		const flip = left + tooltip.offsetWidth + 16 > svg.clientWidth;
		tooltip.style.left = (flip ? left - tooltip.offsetWidth - 12 : left + 12) + "px";
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
