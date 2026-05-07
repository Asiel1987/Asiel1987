import { test, expect } from '@playwright/test';

// Shared login helper (demo mode — no backend required)
async function login(page) {
  await page.goto('/');
  const phone = page.getByPlaceholder(/phone number/i)
    .or(page.getByRole('textbox', { name: /phone/i }));
  await phone.fill('+255712345678');
  await page.getByRole('button', { name: /send otp|get code|continue/i }).first().click();
  const otp = page.locator('input[maxlength="6"]').or(page.getByPlaceholder(/otp/i));
  await otp.first().fill('123456');
  const verify = page.getByRole('button', { name: /verify|confirm|continue/i });
  if (await verify.isVisible()) await verify.click();
  const customer = page.getByText(/customer/i).or(page.getByRole('button', { name: /customer/i }));
  await customer.first().click();
  const confirm = page.getByRole('button', { name: /confirm|continue/i });
  if (await confirm.isVisible()) await confirm.click();
  await page.waitForTimeout(500);
}

async function goToMarket(page) {
  await login(page);
  const tab = page.getByRole('tab', { name: /market/i })
    .or(page.getByText(/market/i).first());
  await tab.first().click();
  await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 8000 });
}

// ── Price Comparison Widget ───────────────────────────────────────────────────
test.describe('Price comparison widget', () => {
  test('shows savings vs market price on products that have one', async ({ page }) => {
    await goToMarket(page);
    // Open any product modal
    await page.locator('.product-card').first().click();
    const modal = page.locator('.modal-body, [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });
    // If this product has a marketPrice the compare widget should appear
    const compare = modal.locator('.price-compare');
    if (await compare.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(compare).toContainText(/save/i);
    }
  });
});

// ── Recently Viewed ───────────────────────────────────────────────────────────
test.describe('Recently viewed', () => {
  test('appears after viewing a product and shows the viewed item', async ({ page }) => {
    await goToMarket(page);
    const cards = page.locator('.product-card');
    const firstName = await cards.first().locator('.card-name, h3').first().textContent();
    await cards.first().click();
    // Close modal
    const close = page.locator('.modal-close, button[aria-label="Close"]');
    if (await close.isVisible({ timeout: 2000 }).catch(() => false)) await close.click();
    // Recently viewed section should appear
    await expect(page.locator('.recent-section')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.recent-chip')).toContainText(firstName.trim().slice(0, 4));
  });
});

// ── Stock Alert (notify me) ───────────────────────────────────────────────────
test.describe('Notify me when back in stock', () => {
  test('notify button is present and toggleable on sold-out products', async ({ page }) => {
    await goToMarket(page);
    // Find a sold-out card (has notify-btn) — if none exist in demo data the test skips
    const notifyPill = page.locator('.notify-pill').first();
    if (!await notifyPill.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip();
      return;
    }
    await notifyPill.click();
    const notifyBtn = page.locator('.notify-btn');
    const initial = await notifyBtn.first().textContent();
    await notifyBtn.first().click();
    await expect(notifyBtn.first()).not.toHaveText(initial);
  });
});

// ── WhatsApp Product Share ────────────────────────────────────────────────────
test.describe('WhatsApp share', () => {
  test('share link is present on product modal', async ({ page }) => {
    await goToMarket(page);
    await page.locator('.product-card').first().click();
    const modal = page.locator('.modal-body, [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });
    const shareLink = modal.locator('a[href*="wa.me"], a[href*="whatsapp"], .share-wa');
    await expect(shareLink.first()).toBeVisible({ timeout: 3000 });
  });
});

// ── Delivery ETA ─────────────────────────────────────────────────────────────
test.describe('Delivery ETA', () => {
  test('ETA label is shown on product cards', async ({ page }) => {
    await goToMarket(page);
    const eta = page.locator('.card-eta').first();
    await expect(eta).toBeVisible({ timeout: 5000 });
    await expect(eta).toContainText(/delivers by|tomorrow/i);
  });
});

// ── Chama Group Order ─────────────────────────────────────────────────────────
test.describe('Chama group order', () => {
  test.setTimeout(15000);

  test('start chama button opens sheet with share link', async ({ page }) => {
    await goToMarket(page);
    // Add item to cart first
    await page.locator('.product-card').first().click();
    await page.getByRole('button', { name: /add to cart/i }).first().click();
    // Cart panel should open — click Start Chama
    const chamaBtn = page.locator('.chama-btn');
    await expect(chamaBtn).toBeVisible({ timeout: 5000 });
    await chamaBtn.click();
    // Chama sheet should appear
    await expect(page.locator('.chama-sheet')).toBeVisible({ timeout: 5000 });
    // Share link should contain a chama ID
    await expect(page.locator('.chama-link-box')).toContainText(/chama=/i);
  });
});

// ── Dark Mode Toggle ──────────────────────────────────────────────────────────
test.describe('Dark mode', () => {
  test('toggles dark class on body', async ({ page }) => {
    await goToMarket(page);
    const toggle = page.locator('.dark-toggle, [aria-label*="dark"], [aria-label*="theme"]').first();
    await expect(toggle).toBeVisible({ timeout: 5000 });
    const before = await page.evaluate(() => document.body.classList.contains('dark'));
    await toggle.click();
    const after = await page.evaluate(() => document.body.classList.contains('dark'));
    expect(after).toBe(!before);
  });
});

// ── Video Preview ─────────────────────────────────────────────────────────────
test.describe('Harvest video preview', () => {
  test('video element is present in modal for products with a videoUrl', async ({ page }) => {
    await goToMarket(page);
    // Try each product card until we find one with a video pill or just check first modal
    const cards = page.locator('.product-card');
    const count = await cards.count();
    let found = false;
    for (let i = 0; i < Math.min(count, 9); i++) {
      await cards.nth(i).click();
      const video = page.locator('.modal-video');
      if (await video.isVisible({ timeout: 1500 }).catch(() => false)) {
        await expect(video).toHaveAttribute('src', /.+/);
        found = true;
        break;
      }
      const close = page.locator('.modal-close');
      if (await close.isVisible({ timeout: 500 }).catch(() => false)) await close.click();
    }
    if (!found) test.skip(); // no demo products have videoUrl configured
  });
});
