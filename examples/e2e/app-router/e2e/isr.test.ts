import { expect, test } from "@playwright/test";

// ISR is currently not supported: https://github.com/opennextjs/opennextjs-cloudflare/issues/105
test.skip("Incremental Static Regeneration", async ({ page }) => {
  test.setTimeout(45000);
  await page.goto("/");
  await page.locator("[href='/isr']").click();
  // Load the page a couple times to regenerate ISR

  let el = page.getByText("Time:");
  // Track the static time
  let time = await el.textContent();
  let newTime: typeof time;
  let tempTime = time;
  do {
    await page.waitForTimeout(1000);
    await page.reload();
    time = tempTime;
    el = page.getByText("Time:");
    newTime = await el.textContent();
    tempTime = newTime;
  } while (time !== newTime);
  await page.reload();

  await page.waitForTimeout(1000);
  el = page.getByText("Time:");
  const midTime = await el.textContent();
  // Expect that the time is still stale
  expect(midTime).toEqual(newTime);

  // Wait 10 + 1 seconds for ISR to regenerate time
  await page.waitForTimeout(11000);
  let finalTime = newTime;
  do {
    await page.waitForTimeout(2000);
    el = page.getByText("Time:");
    finalTime = await el.textContent();
    await page.reload();
  } while (newTime === finalTime);

  expect(newTime).not.toEqual(finalTime);
});

// ISR is currently not supported: https://github.com/opennextjs/opennextjs-cloudflare/issues/105
test.skip("headers", async ({ page }) => {
  let responsePromise = page.waitForResponse((response) => {
    return response.status() === 200;
  });
  await page.goto("/isr");

  while (true) {
    const response = await responsePromise;
    const headers = response.headers();

    // this was set in middleware
    if (headers["cache-control"] === "max-age=10, stale-while-revalidate=999") {
      break;
    }
    await page.waitForTimeout(1000);
    responsePromise = page.waitForResponse((response) => {
      return response.status() === 200;
    });
    await page.reload();
  }
});
