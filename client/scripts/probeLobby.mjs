export async function configureLobby(page, guestPage, waitUntil) {
  if (
    (await page.getByText('Choose your portrait', { exact: true }).count()) !== 1 ||
    (await page.getByText('Round settings', { exact: true }).count()) !== 1
  ) {
    throw new Error('Worker lobby did not expose its implemented configuration actions.');
  }

  const guestSettingButtons = guestPage.locator('.lobby__preset');
  if (
    (await guestSettingButtons.count()) === 0 ||
    (await guestSettingButtons.count()) !==
      (await guestPage.locator('.lobby__preset:disabled').count())
  ) {
    throw new Error('Invited non-host browser received authoritative settings controls.');
  }
  if ((await guestPage.locator('.lobby__swatch:disabled').count()) !== 0) {
    throw new Error('Invited Player could not configure their own cosmetics.');
  }

  await page.getByRole('button', { name: '3 min', exact: true }).click();
  await page.getByRole('button', { name: '5s', exact: true }).click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'The Owl', exact: true }).click();
  await guestPage.locator('.lobby__cosmetics').evaluate((picker) => {
    const face = picker.querySelector('button[title="The Automaton"]');
    const hat = picker.querySelector('button[title="Crown"]');
    if (!(face instanceof HTMLButtonElement) || !(hat instanceof HTMLButtonElement)) {
      throw new Error('Guest cosmetic choices were not rendered.');
    }
    face.click();
    hat.click();
  });

  await waitUntil(async () => {
    for (const browserPage of [page, guestPage]) {
      const activeSettings = await browserPage.locator('.lobby__preset--active').allTextContents();
      if (
        !activeSettings.includes('3 min') ||
        !activeSettings.includes('5s') ||
        !activeSettings.includes('History')
      ) {
        return false;
      }
      const hostRow = browserPage.locator('.lobby__player').filter({ hasText: 'Skeleton Walker' });
      const guestRow = browserPage.locator('.lobby__player').filter({ hasText: 'Invited Guest' });
      if ((await hostRow.getByRole('img', { name: 'The Owl' }).count()) !== 1) return false;
      if ((await guestRow.getByRole('img', { name: 'The Automaton' }).count()) !== 1) return false;
      if ((await guestRow.locator('.avatar__hat').textContent()) !== '👑') return false;
    }
    return true;
  }, 'lobby settings and cosmetics convergence');
  return { lobbyActions: true };
}

export async function startWithRejectedSettings(page, guestPage) {
  const hostPreparing = page.getByRole('heading', { name: 'Choosing articles' }).waitFor();
  const guestPreparing = guestPage.getByRole('heading', { name: 'Choosing articles' }).waitFor();
  const hostRejectedSettings = page
    .getByText('Settings can only be changed in the lobby.', { exact: true })
    .waitFor();

  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button:not(:disabled)')];
    const start = buttons.find((button) => button.textContent?.trim() === 'Start Game');
    const preset = buttons.find((button) => button.textContent?.trim() === '10 min');
    if (!(start instanceof HTMLButtonElement) || !(preset instanceof HTMLButtonElement)) {
      throw new Error('Host Start and stale settings controls were not both enabled.');
    }
    start.click();
    preset.click();
  });

  await Promise.all([hostPreparing, guestPreparing, hostRejectedSettings]);
  return { prepared: true, recoverableActionError: true };
}
