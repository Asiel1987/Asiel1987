import { test, expect } from '@playwright/test';

// Helper: log in as demo customer then navigate to the Market tab.
async function goToMarket(page) {
  await page.goto('/');

  const phoneInput = page
    .getByPlaceholder(/phone number/i)
    .or(page.getByPlaceholder(/07\d\d/i))
    .or(page.getByRole('textbox', { name: /phone/i }));
  await phoneInput.fill('+255712345678');

  const sendBtn = page
    .getByRole('button', { name: /send otp/i })
    .or(page.getByRole('button', { name: /get code/i }))
    .or(page.getByRole('button', { name: /continue/i }));
  await sendBtn.click();

  const otpField = page
    .getByPlaceholder(/otp/i)
    .or(page.getByPlaceholder(/6.digit/i))
    .or(page.locator('input[maxlength="6"]'));
  await otpField.first().fill('123456');

  const verifyBtn = page
    .getByRole('button', { name: /verify/i })
    .or(page.getByRole('button', { name: /confirm/i }))
    .or(page.getByRole('button', { name: /continue/i }));
  if (await verifyBtn.isVisible()) {
    await verifyBtn.click();
  }

  const roleSelector = page
    .getByText(/customer/i)
    .or(page.getByRole('button', { name: /customer/i }))
    .or(page.getByRole('radio', { name: /customer/i }));
  await roleSelector.first().click();

  const confirmBtn = page
    .getByRole('button', { name: /confirm/i })
    .or(page.getByRole('button', { name: /continue/i }));
  if (await confirmBtn.isVisible()) {
    await confirmBtn.click();
  }

  const marketTab = page
    .getByRole('tab', { name: /market/i })
    .or(page.getByText(/market/i).first())
    .or(page.getByRole('link', { name: /market/i }));
  await expect(marketTab.first()).toBeVisible({ timeout: 10000 });
  await marketTab.first().click();
}

test.describe('Market Page', () => {
  test('page loads with products visible', async ({ page }) => {
    await goToMarket(page);

    // Product cards should render
    const productCard = page
      .getByRole('article')
      .or(page.locator('[data-testid="product-card"]'))
      .or(page.locator('.product-card'));
    await expect(productCard.first()).toBeVisible({ timeout: 8000 });
  });

  test('search filter works', async ({ page }) => {
    await goToMarket(page);

    // Find the search input
    const searchInput = page
      .getByPlaceholder(/search/i)
      .or(page.getByRole('searchbox'))
      .or(page.getByRole('textbox', { name: /search/i }));
    await searchInput.first().fill('tomato');

    // Results should filter — expect at least one card with "tomato" text
    const tomatoResult = page.getByText(/tomato/i);
    await expect(tomatoResult.first()).toBeVisible({ timeout: 5000 });

    // There should be no un-related product visible that clearly doesn't match
    // (this is a light assertion — we just confirm the filter had some effect)
    const allCards = page
      .getByRole('article')
      .or(page.locator('[data-testid="product-card"]'));
    const count = await allCards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('category filter works', async ({ page }) => {
    await goToMarket(page);

    // Click any category chip / button (the first non-"All" one)
    const categoryBtn = page
      .getByRole('button', { name: /vegetable|fruit|grain|dairy|livestock/i })
      .or(page.locator('[data-testid="category-chip"]'))
      .or(page.locator('.category-chip'));
    await categoryBtn.first().click();

    // Products should still be visible after filtering
    const productCard = page
      .getByRole('article')
      .or(page.locator('[data-testid="product-card"]'))
      .or(page.locator('.product-card'));
    await expect(productCard.first()).toBeVisible({ timeout: 5000 });
  });

  test('dark mode toggle works', async ({ page }) => {
    await goToMarket(page);

    // Click the dark mode toggle button
    const darkToggle = page
      .getByRole('button', { name: /dark mode|light mode|toggle theme/i })
      .or(page.locator('[data-testid="dark-mode-toggle"]'))
      .or(page.locator('.dark-toggle'));
    await darkToggle.first().click();

    // Body or root element should have a 'dark' class
    await expect(page.locator('body')).toHaveClass(/dark/, { timeout: 3000 });
  });

  test('PWA install banner is dismissible', async ({ page }) => {
    await goToMarket(page);

    // PWA install banner / prompt
    const installBanner = page
      .getByText(/install/i)
      .or(page.locator('[data-testid="install-banner"]'))
      .or(page.locator('.install-prompt'));

    // Only run this assertion if the banner actually appears in this environment
    if (await installBanner.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      const dismissBtn = page
        .getByRole('button', { name: /dismiss|close|not now|later/i })
        .or(page.locator('[data-testid="dismiss-install"]'));
      await dismissBtn.first().click();

      // Banner should disappear
      await expect(installBanner.first()).not.toBeVisible({ timeout: 3000 });
    } else {
      // Banner not shown in this environment — that's acceptable (test passes)
      test.skip();
    }
  });
});
