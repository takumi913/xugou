/**
 * 构建期世界地图数据生成脚本（运行时零依赖）
 *
 * 再生成命令（在 frontend/ 目录下）：
 *   corepack pnpm@10 install   # 确保 devDependencies（world-atlas/topojson-client/d3-geo）就位
 *   node scripts/generate-world-map.mjs
 *
 * 流程：
 * 1. 读取 world-atlas 的 countries-110m.json（TopoJSON），转 GeoJSON 国家要素；
 * 2. 用 d3-geo 的 Natural Earth I 投影预投影为固定 viewBox 下的 SVG path 字符串
 *    （路径坐标取整——1000 单位宽下误差 ≤0.5 单位肉眼不可辨，换取 gzip ≤30KB；
 *    质心保留 1 位小数），同时计算每个国家的投影后质心；
 * 3. 输出 frontend/src/assets/worldMap.ts：WORLD_VIEWBOX / COUNTRY_PATHS /
 *    COUNTRY_CENTROIDS / projectPoint（Natural Earth I 多项式近似公式内联，
 *    投影参数由本脚本注入，运行时不依赖 d3）。
 * 4. 内置自校验：北京/纽约/悉尼三点的 projectPoint 结果与 d3-geo 参考投影
 *    误差必须 < 0.5 个 viewBox 单位，失败则退出码非 0。
 *
 * 南极洲（AQ）被剔除（无监控节点、省体积），viewBox 高度按剩余国家的
 * 投影范围收紧。d3-geo 仅作为 devDependency 在本脚本使用，不进运行时包。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import * as topojson from "topojson-client";
import { geoNaturalEarth1, geoPath } from "d3-geo";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.resolve(__dirname, "../src/assets/worldMap.ts");

// viewBox 宽度固定 1000，高度按投影范围（剔除 AQ 后）收紧
const MAP_WIDTH = 1000;
const FIT_HEIGHT = 520;

// ISO 3166-1 numeric → alpha-2（world-atlas 要素 id 为数字码字符串）
const NUMERIC_TO_ALPHA2 = {
  "004": "AF", "008": "AL", "010": "AQ", "012": "DZ", "016": "AS", "020": "AD",
  "024": "AO", "028": "AG", "031": "AZ", "032": "AR", "036": "AU", "040": "AT",
  "044": "BS", "048": "BH", "050": "BD", "051": "AM", "052": "BB", "056": "BE",
  "060": "BM", "064": "BT", "068": "BO", "070": "BA", "072": "BW", "074": "BV",
  "076": "BR", "084": "BZ", "086": "IO", "090": "SB", "092": "VG", "096": "BN",
  "100": "BG", "104": "MM", "108": "BI", "112": "BY", "116": "KH", "120": "CM",
  "124": "CA", "132": "CV", "136": "KY", "140": "CF", "144": "LK", "148": "TD",
  "152": "CL", "156": "CN", "158": "TW", "162": "CX", "166": "CC", "170": "CO",
  "174": "KM", "175": "YT", "178": "CG", "180": "CD", "184": "CK", "188": "CR",
  "191": "HR", "192": "CU", "196": "CY", "203": "CZ", "204": "BJ", "208": "DK",
  "212": "DM", "214": "DO", "218": "EC", "222": "SV", "226": "GQ", "231": "ET",
  "232": "ER", "233": "EE", "234": "FO", "238": "FK", "239": "GS", "242": "FJ",
  "246": "FI", "248": "AX", "250": "FR", "254": "GF", "258": "PF", "260": "TF",
  "262": "DJ", "266": "GA", "268": "GE", "270": "GM", "275": "PS", "276": "DE",
  "288": "GH", "292": "GI", "296": "KI", "300": "GR", "304": "GL", "308": "GD",
  "312": "GP", "316": "GU", "320": "GT", "324": "GN", "328": "GY", "332": "HT",
  "334": "HM", "336": "VA", "340": "HN", "344": "HK", "348": "HU", "352": "IS",
  "356": "IN", "360": "ID", "364": "IR", "368": "IQ", "372": "IE", "376": "IL",
  "380": "IT", "384": "CI", "388": "JM", "392": "JP", "398": "KZ", "400": "JO",
  "404": "KE", "408": "KP", "410": "KR", "414": "KW", "417": "KG", "418": "LA",
  "422": "LB", "426": "LS", "428": "LV", "430": "LR", "434": "LY", "438": "LI",
  "440": "LT", "442": "LU", "446": "MO", "450": "MG", "454": "MW", "458": "MY",
  "462": "MV", "466": "ML", "470": "MT", "474": "MQ", "478": "MR", "480": "MU",
  "484": "MX", "492": "MC", "496": "MN", "498": "MD", "499": "ME", "500": "MS",
  "504": "MA", "508": "MZ", "512": "OM", "516": "NA", "520": "NR", "524": "NP",
  "528": "NL", "531": "CW", "533": "AW", "534": "SX", "535": "BQ", "540": "NC",
  "548": "VU", "554": "NZ", "558": "NI", "562": "NE", "566": "NG", "570": "NU",
  "574": "NF", "578": "NO", "580": "MP", "581": "UM", "583": "FM", "584": "MH",
  "585": "PW", "586": "PK", "591": "PA", "598": "PG", "600": "PY", "604": "PE",
  "608": "PH", "612": "PN", "616": "PL", "620": "PT", "624": "GW", "626": "TL",
  "630": "PR", "634": "QA", "638": "RE", "642": "RO", "643": "RU", "646": "RW",
  "652": "BL", "654": "SH", "659": "KN", "660": "AI", "662": "LC", "663": "MF",
  "666": "PM", "670": "VC", "674": "SM", "678": "ST", "682": "SA", "686": "SN",
  "688": "RS", "690": "SC", "694": "SL", "702": "SG", "703": "SK", "704": "VN",
  "705": "SI", "706": "SO", "710": "ZA", "716": "ZW", "724": "ES", "728": "SS",
  "729": "SD", "732": "EH", "740": "SR", "744": "SJ", "748": "SZ", "752": "SE",
  "756": "CH", "760": "SY", "762": "TJ", "764": "TH", "768": "TG", "772": "TK",
  "776": "TO", "780": "TT", "784": "AE", "788": "TN", "792": "TR", "795": "TM",
  "796": "TC", "798": "TV", "800": "UG", "804": "UA", "807": "MK", "818": "EG",
  "826": "GB", "831": "GG", "832": "JE", "833": "IM", "834": "TZ", "840": "US",
  "850": "VI", "854": "BF", "858": "UY", "860": "UZ", "862": "VE", "876": "WF",
  "882": "WS", "887": "YE", "894": "ZM",
};

// Natural Earth 数据中若干无 ISO 数字码的要素（id 缺失/-99），按名称特判
const NAME_TO_ALPHA2 = {
  Kosovo: "XK",
};

// ---- 1. 读取 TopoJSON 并转 GeoJSON ----
const topoPath = require.resolve("world-atlas/countries-110m.json");
const topo = JSON.parse(readFileSync(topoPath, "utf-8"));
const { features } = topojson.feature(topo, topo.objects.countries);

// ---- 2. 建立投影（Natural Earth I，fitSize 到 1000x520 的球面范围） ----
const projection = geoNaturalEarth1().fitSize([MAP_WIDTH, FIT_HEIGHT], {
  type: "Sphere",
});
const pathGen = geoPath(projection).digits(0);

const skipped = [];
const countries = [];
for (const feature of features) {
  const id = typeof feature.id === "string" ? feature.id : String(feature.id ?? "");
  const name = feature.properties?.name ?? "(unnamed)";
  const iso2 = NUMERIC_TO_ALPHA2[id.padStart(3, "0")] ?? NAME_TO_ALPHA2[name] ?? null;
  if (!iso2) {
    skipped.push(`${name} (id=${id || "?"})`);
    continue;
  }
  if (iso2 === "AQ") continue; // 南极洲剔除
  const d = pathGen(feature);
  if (!d) continue;
  const [cx, cy] = pathGen.centroid(feature);
  countries.push({
    iso2,
    path: d,
    centroid: [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10],
    bounds: pathGen.bounds(feature),
  });
}
countries.sort((a, b) => (a.iso2 < b.iso2 ? -1 : 1));

// viewBox 高度按剩余国家投影范围收紧（上下各留 4 单位边距）
let minY = Infinity;
let maxY = -Infinity;
for (const country of countries) {
  minY = Math.min(minY, country.bounds[0][1]);
  maxY = Math.max(maxY, country.bounds[1][1]);
}
const viewMinY = Math.max(0, Math.floor(minY) - 4);
const viewHeight = Math.min(FIT_HEIGHT, Math.ceil(maxY) + 4) - viewMinY;

// ---- 3. 生成 worldMap.ts ----
const [tx, ty] = projection.translate();
const k = projection.scale();
const round6 = (value) => Math.round(value * 1e6) / 1e6;

const pathsLiteral = countries
  .map((c) => `  { iso2: ${JSON.stringify(c.iso2)}, path: ${JSON.stringify(c.path)} },`)
  .join("\n");
const centroidsLiteral = countries
  .map((c) => `  ${c.iso2}: [${c.centroid[0]}, ${c.centroid[1]}],`)
  .join("\n");

const output = `/* eslint-disable */
// 本文件由 scripts/generate-world-map.mjs 生成，请勿手改。
// 再生成：在 frontend/ 目录执行 node scripts/generate-world-map.mjs
// 数据源：world-atlas countries-110m.json（Natural Earth，公有领域）
// 投影：Natural Earth I（d3-geo geoNaturalEarth1 同参数，多项式近似公式内联）
// 说明：南极洲（AQ）已剔除；路径坐标整数精度，质心 1 位小数。

// 预投影 viewBox（x y width height）
export const WORLD_VIEWBOX = {
  x: 0,
  y: ${viewMinY},
  width: ${MAP_WIDTH},
  height: ${viewHeight},
} as const;

// 与生成脚本同一投影的运行时函数（纯数学，零依赖）。
// x = TX + K * rawX(λ, φ)；y = TY - K * rawY(λ, φ)（λ/φ 为弧度）。
const K = ${round6(k)};
const TX = ${round6(tx)};
const TY = ${round6(ty)};
const RAD = Math.PI / 180;

export function projectPoint(lat: number, lon: number): [number, number] {
  const l = lon * RAD;
  const p = lat * RAD;
  const p2 = p * p;
  const p4 = p2 * p2;
  const rx =
    l *
    (0.8707 -
      0.131979 * p2 +
      p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
  const ry =
    p *
    (1.007226 +
      p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
  return [TX + K * rx, TY - K * ry];
}

// 国家轮廓（ISO 3166-1 alpha-2 → 预投影 SVG path）
export const COUNTRY_PATHS: ReadonlyArray<{ iso2: string; path: string }> = [
${pathsLiteral}
];

// 国家质心（投影后坐标，仅有 region 无经纬度的 agent 降级定位用）
export const COUNTRY_CENTROIDS: Record<string, readonly [number, number]> = {
${centroidsLiteral}
};
`;

mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
writeFileSync(OUTPUT_FILE, output, "utf-8");

// ---- 4. 自校验：三城投影 vs d3-geo 参考值，误差 < 0.5 单位 ----
// 与生成文件完全同一公式/参数（复算而非 import，避免 TS 编译依赖）
const projectPointCheck = (lat, lon) => {
  const l = lon * RAD_CHECK;
  const p = lat * RAD_CHECK;
  const p2 = p * p;
  const p4 = p2 * p2;
  const rx =
    l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
  const ry =
    p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
  return [round6(tx) + round6(k) * rx, round6(ty) - round6(k) * ry];
};
const RAD_CHECK = Math.PI / 180;

const CHECK_CITIES = [
  { name: "Beijing", lat: 39.9, lon: 116.4 },
  { name: "New York", lat: 40.7, lon: -74.0 },
  { name: "Sydney", lat: -33.9, lon: 151.2 },
];
let checkFailed = false;
console.log("=== projectPoint self-check (tolerance < 0.5 viewBox units) ===");
for (const { name, lat, lon } of CHECK_CITIES) {
  const [x, y] = projectPointCheck(lat, lon);
  const [refX, refY] = projection([lon, lat]);
  const err = Math.hypot(x - refX, y - refY);
  const pass = err < 0.5;
  if (!pass) checkFailed = true;
  console.log(
    `${pass ? "PASS" : "FAIL"} ${name.padEnd(9)} lat=${lat} lon=${lon} → ` +
      `generated=[${x.toFixed(3)}, ${y.toFixed(3)}] d3-ref=[${refX.toFixed(3)}, ${refY.toFixed(3)}] err=${err.toExponential(2)}`
  );
}

const sizeKb = Buffer.byteLength(output, "utf-8") / 1024;
console.log(`countries: ${countries.length}, skipped (no ISO2): ${skipped.join(", ") || "none"}`);
console.log(`viewBox: 0 ${viewMinY} ${MAP_WIDTH} ${viewHeight}`);
console.log(`output: ${OUTPUT_FILE} (${sizeKb.toFixed(1)} KB raw)`);
if (sizeKb > 120) {
  console.error(`FAIL: worldMap.ts raw size ${sizeKb.toFixed(1)} KB exceeds 120 KB budget`);
  process.exit(1);
}
if (checkFailed) {
  console.error("FAIL: projection self-check exceeded tolerance");
  process.exit(1);
}
console.log("WORLD_MAP_GENERATION_OK");
