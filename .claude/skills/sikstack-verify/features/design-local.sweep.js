async page => {
  // The design-local sweep (run it with `playwright-cli -s=<guest> --raw run-code --filename=<copy>`, after replacing
  // __LINK__ with the build's share link and __SHOTS__ with the evidence folder). A signed-out browser holding only the
  // share link walks the build by click at 1440 and 375: every page from the front page's links, then every state
  // from that page's "Design states" bar. A modal state (a `showModal()` dialog) makes the bar inert, so an open
  // `dialog:modal` is closed with its own Cancel before the next pick; a busy one (its Cancel disabled, Escape refused,
  // as while a request runs) cannot be, so the next state is clicked from the front page's state links. It records
  // where each click lands, the status of each document, page and console errors, and every link that leaves the
  // build's host; it returns JSON.
  const LINK = "__LINK__";
  const SHOTS = "__SHOTS__";
  const errors = [];
  const docs = [];
  page.on("pageerror", e => errors.push({ where: page.url(), error: String(e).slice(0, 200) }));
  page.on("console", m => { if (m.type() === "error") errors.push({ where: page.url(), console: m.text().slice(0, 200) }); });
  page.on("response", r => { if (r.request().resourceType() === "document") docs.push({ url: r.url(), status: r.status() }); });
  await page.goto(LINK);
  await page.waitForLoadState("networkidle");
  const origin = new URL(page.url()).origin;
  const out = { link: LINK, landed: page.url(), origin, sizes: [] };
  const offBuild = () => page.$$eval("a[href]", (as, o) => as.map(a => a.href).filter(u => !u.startsWith(o + "/") && !u.startsWith("javascript:")), origin);
  const closeModal = async () => { // an open modal: "cancel" when its own Cancel closed it, "busy" when that Cancel is disabled
    const dialog = page.locator("dialog:modal");
    if (!(await dialog.count())) return null;
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    if (await cancel.isDisabled()) return "busy";
    await cancel.click({ timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector("dialog:modal"), null, { timeout: 5000 });
    return "cancel";
  };
  const state = () => new URL(page.url()).searchParams.get("state");
  for (const [w, h] of [[1440, 900], [375, 812]]) {
    await page.setViewportSize({ width: w, height: h });
    const size = { width: w, pages: [] };
    await page.goto(origin + "/");
    await page.waitForLoadState("networkidle");
    const entries = await page.$$eval("main li > div > a", as => [...new Set(as.map(a => a.getAttribute("href")))]);
    size.frontEntries = entries.length;
    size.frontStateLinks = (await page.$$eval("main a[href*='state=']", as => as.length));
    await page.screenshot({ path: `${SHOTS}/design-local-${w}-00-front.png` });
    let n = 0;
    for (const href of entries) {
      n += 1;
      const rec = { href, states: [], stateFailures: [], modalsClosed: [], modalsBusy: [], offBuildLinks: [] };
      await page.goto(origin + "/");
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => localStorage.clear()); // a state another page picked lives in the build's storage
      await page.click(`main a[href="${href}"]`);
      await page.waitForLoadState("networkidle");
      rec.landed = page.url();
      rec.path = new URL(page.url()).pathname;
      rec.onBuild = page.url().startsWith(origin + "/");
      rec.offBuildLinks.push(...(await offBuild()));
      await page.screenshot({ path: `${SHOTS}/design-local-${w}-${String(n).padStart(2, "0")}.png` });
      const picker = page.locator('role=button[name^="Design states: "]');
      if (await picker.count()) {
        await picker.first().click();
        const keys = await page.$$eval("[data-design-state]", els => els.map(e => e.getAttribute("data-design-state")));
        await page.keyboard.press("Escape");
        rec.barKeys = keys;
        for (const key of keys) {
          try {
            const was = state();
            const closed = await closeModal();
            let via = "bar";
            if (closed === "cancel") rec.modalsClosed.push(was);
            if (closed === "busy") { // a busy modal (its Cancel disabled, Escape refused) holds the bar: the front page links the state
              rec.modalsBusy.push(was);
              via = "front";
              await page.goto(origin + "/");
              await page.waitForLoadState("networkidle");
              const link = await page.$$eval("main a[href*='state=']", (as, [path, k]) => {
                const a = as.find(a => { const u = new URL(a.href); return u.pathname === path && u.searchParams.get("state") === k; });
                return a ? a.getAttribute("href") : null;
              }, [rec.path, key]);
              if (!link) throw new Error(`the front page has no link to ${rec.path}?state=${key}`);
              await page.click(`main a[href="${link}"]`);
              await page.waitForLoadState("networkidle"); // a full load: the state's dialog opens once the page hydrates
            } else {
              if (!(await page.locator(`[data-design-state="${key}"]`).isVisible())) await picker.first().click();
              await page.click(`[data-design-state="${key}"]`, { timeout: 5000 });
            }
            await page.waitForFunction(k => new URLSearchParams(location.search).get("state") === k, key, { timeout: 5000 });
            rec.states.push({ key, via, onBuild: page.url().startsWith(origin + "/") });
            rec.offBuildLinks.push(...(await offBuild()));
            if (await page.locator("dialog:modal").count()) {
              await page.screenshot({ path: `${SHOTS}/design-local-${w}-${String(n).padStart(2, "0")}-modal-${key}.png` });
            }
          } catch (e) {
            rec.stateFailures.push({ key, error: String(e).split("\n")[0].slice(0, 160), url: page.url() });
          }
        }
        if ((await closeModal()) === "cancel") rec.modalsClosed.push(state());
      }
      rec.offBuildLinks = [...new Set(rec.offBuildLinks)];
      size.pages.push(rec);
    }
    out.sizes.push(size);
  }
  out.errors = errors;
  out.badDocs = docs.filter(d => d.status >= 400);
  out.docCount = docs.length;
  return JSON.stringify(out);
}
