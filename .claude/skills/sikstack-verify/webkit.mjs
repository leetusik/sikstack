// The WebKit mode (SKILL.md): one page of the running stack in WebKit 18.2 on a phone or a tablet profile,
// signed in, shot full-page, its layout facts printed as one JSON line. Run through `run.sh webkit`, which
// pins the engine (playwright-core 1.49.1, WebKit build v2104) and passes the stack's URL and evidence folder.
//
// usage: node webkit.mjs <phone|tablet> <url> <shot.png> [auth-state.json] [measure.js]
//   phone:  iPhone 13 Mini (375 x 629 @3x); tablet: iPad Mini (768 x 1024 @2x).
//   measure.js: optional, the body of a function run in the page; its return value is printed as `measure`.
//
// WebKit never sends the `__Host-` session cookie (Secure) over plain http, where Chromium treats *.localhost
// as secure: the saved sign-in's cookies are added to the requests for the app's own origin only, so a design
// build's host keeps its own cookie (adding them to every request breaks the design frames).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const pc = require(process.env.PWCORE || "playwright-core");
const [device, url, shot, auth, measure] = process.argv.slice(2);
const PROFILES = { phone: "iPhone 13 Mini", tablet: "iPad Mini" };
if (!PROFILES[device] || !url || !shot) {
  console.error("usage: node webkit.mjs <phone|tablet> <url> <shot.png> [auth-state.json] [measure.js]");
  process.exit(2);
}
const browser = await pc.webkit.launch();
try {
  const context = await browser.newContext({ ...pc.devices[PROFILES[device]] });
  if (auth) {
    const origin = new URL(url).origin;
    const cookie = JSON.parse(readFileSync(auth, "utf8"))
      .cookies.map((c) => `${c.name}=${c.value}`)
      .join("; ");
    await context.route(
      (u) => u.origin === origin,
      (route) => route.continue({ headers: { ...route.request().headers(), cookie } }),
    );
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const facts = await page.evaluate(() => {
    const rail = document.querySelector("nav.rail");
    return {
      engine: navigator.userAgent.match(/Version\/[\d.]+/)?.[0] ?? navigator.userAgent,
      at: location.pathname + location.search,
      width: innerWidth,
      scrollsSideways: document.documentElement.scrollWidth > innerWidth,
      railHeight: rail ? Math.round(rail.getBoundingClientRect().height) : null,
    };
  });
  if (measure) facts.measure = await page.evaluate(`(() => { ${readFileSync(measure, "utf8")} })()`);
  if (errors.length) facts.errors = errors;
  await page.screenshot({ path: shot, fullPage: true });
  console.log(JSON.stringify({ device, shot, ...facts }));
} finally {
  await browser.close();
}
