import { test, expect } from '@playwright/test';

// Helper: perform OTP login in demo mode so tests don't depend on auth state storage.
async function loginAsDemoCustomer(page) {
  await page.goto('/');

  // Wait for phone input
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

  // Wait until we're past the auth screen
  await page.waitForURL(/.*/, { timeout: 8000 });
}

test.describe('Complete Purchase Flow', () => {
  // Allow extra time for the full buy flow including the 2.6 s demo payment transition
  test.setTimeout(15000);

  test('should add a product to cart and complete M-Pesa checkout', async ({ page }) => {
    // Step 1: Login
    await loginAsDemoCustomer(page);

    // Step 2: Navigate to the Market tab
    const marketTab = page
      .getByRole('tab', { name: /market/i })
      .or(page.getByText(/market/i).first())
      .or(page.getByRole('link', { name: /market/i }));
    await expect(marketTab.first()).toBeVisible({ timeout: 10000 });
    await marketTab.first().click();

    // Step 3: Product cards should be visible
    const productCard = page
      .getByRole('article')
      .or(page.locator('[data-testid="product-card"]'))
      .or(page.locator('.product-card'));
    await expect(productCard.first()).toBeVisible({ timeout: 8000 });

    // Step 4: Click the first product card to open detail / drawer
    await productCard.first().click();

    // Step 5: Product detail / drawer should open
    const productDetail = page
      .getByRole('dialog')
      .or(page.locator('[data-testid="product-detail"]'))
      .or(page.locator('.product-drawer'));
    await expect(productDetail.first()).toBeVisible({ timeout: 5000 });

    // Step 6: Click "Add to Cart"
    const addToCartBtn = page
      .getByRole('button', { name: /add to cart/i })
      .or(page.getByRole('button', { name: /add/i }));
    await addToCartBtn.first().click();

    // Step 7: Cart panel should open
    const cartPanel = page
      .getByRole('complementary', { name: /cart/i })
      .or(page.locator('[data-testid="cart-panel"]'))
      .or(page.locator('.cart-panel'));
    await expect(cartPanel.first()).toBeVisible({ timeout: 5000 });

    // Step 8: Cart badge should show 1
    const cartBadge = page
      .locator('[data-testid="cart-badge"]')
      .or(page.locator('.cart-badge'))
      .or(page.locator('span').filter({ hasText: '1' }));
    await expect(cartBadge.first()).toHaveText('1');

    // Step 9: Click Checkout / Proceed to Payment
    const checkoutBtn = page
      .getByRole('button', { name: /checkout/i })
      .or(page.getByRole('button', { name: /proceed/i }))
      .or(page.getByRole('button', { name: /pay/i }));
    await checkoutBtn.first().click();

    // Step 10: Payment gateway / modal should open
    const paymentGateway = page
      .getByRole('dialog', { name: /payment/i })
      .or(page.locator('[data-testid="payment-modal"]'))
      .or(page.locator('.payment-modal'));
    await expect(paymentGateway.first()).toBeVisible({ timeout: 5000 });

    // Step 11: Select M-Pesa payment method
    const mpesaOption = page
      .getByRole('radio', { name: /m-pesa/i })
      .or(page.getByText(/m-pesa/i))
      .or(page.locator('[data-method="mpesa"]'));
    await mpesaOption.first().click();

    // Step 12: Fill in phone number for M-Pesa
    const mpesaPhone = page
      .getByPlaceholder(/phone/i)
      .or(page.getByRole('textbox', { name: /phone/i }));
    await mpesaPhone.first().fill('+255712345678');

    // Step 13: Click Pay
    const payBtn = page
      .getByRole('button', { name: /^pay/i })
      .or(page.getByRole('button', { name: /submit/i }));
    await payBtn.first().click();

    // Step 14: Processing screen should appear
    const processingScreen = page
      .getByText(/processing/i)
      .or(page.getByText(/please wait/i))
      .or(page.locator('[data-testid="processing"]'));
    await expect(processingScreen.first()).toBeVisible({ timeout: 5000 });

    // Step 15: Success screen should appear after demo transition (~2.6 s)
    const successScreen = page
      .getByText(/success/i)
      .or(page.getByText(/payment successful/i))
      .or(page.locator('[data-testid="payment-success"]'));
    await expect(successScreen.first()).toBeVisible({ timeout: 8000 });
  });
});
