import { test, expect } from '@playwright/test';

// OTP auth flow — runs in demo mode (no backend required).
// The app uses OTP code 123456 in demo mode.
test.describe('OTP Login Flow', () => {
  test('should complete full OTP login and reach the market', async ({ page }) => {
    // 1. Navigate to root
    await page.goto('/');

    // 2. Login / consent screen should be visible
    await expect(
      page.getByRole('heading', { name: /asiel farm/i }).or(
        page.getByText(/sign in/i).or(page.getByText(/enter your phone/i))
      )
    ).toBeVisible();

    // 3. Fill in phone number
    const phoneInput = page
      .getByPlaceholder(/phone number/i)
      .or(page.getByPlaceholder(/07\d\d/i))
      .or(page.getByRole('textbox', { name: /phone/i }));
    await phoneInput.fill('+255712345678');

    // 4. Click "Send OTP" button
    const sendBtn = page
      .getByRole('button', { name: /send otp/i })
      .or(page.getByRole('button', { name: /get code/i }))
      .or(page.getByRole('button', { name: /continue/i }));
    await sendBtn.click();

    // 5. OTP input fields should appear
    const otpField = page
      .getByPlaceholder(/otp/i)
      .or(page.getByPlaceholder(/6.digit/i))
      .or(page.getByLabel(/enter code/i))
      .or(page.locator('input[maxlength="6"]'));
    await expect(otpField.first()).toBeVisible({ timeout: 8000 });

    // 6. Enter the demo OTP (123456)
    await otpField.first().fill('123456');

    // 7. Submit OTP
    const verifyBtn = page
      .getByRole('button', { name: /verify/i })
      .or(page.getByRole('button', { name: /confirm/i }))
      .or(page.getByRole('button', { name: /continue/i }));
    // Some implementations auto-submit on 6-digit fill; click only if visible
    if (await verifyBtn.isVisible()) {
      await verifyBtn.click();
    }

    // 8. Role selector should appear
    const roleSelector = page
      .getByText(/customer/i)
      .or(page.getByRole('button', { name: /customer/i }))
      .or(page.getByRole('radio', { name: /customer/i }));
    await expect(roleSelector.first()).toBeVisible({ timeout: 8000 });

    // 9. Select "Customer" role
    await roleSelector.first().click();

    // Confirm selection if there is a separate confirm button
    const confirmBtn = page.getByRole('button', { name: /confirm/i }).or(
      page.getByRole('button', { name: /continue/i })
    );
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }

    // 10. Market / products tab should be visible
    const marketTab = page
      .getByRole('tab', { name: /market/i })
      .or(page.getByText(/market/i))
      .or(page.getByRole('link', { name: /market/i }));
    await expect(marketTab.first()).toBeVisible({ timeout: 10000 });
  });
});
