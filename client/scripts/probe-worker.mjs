import { accessSync, constants } from 'node:fs';
import { chromium } from 'playwright-core';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const browser = await launchInstalledBrowser();

try {
  const page = await browser.newPage();
  let postCount = 0;
  let releaseCreation;
  const creationGate = new Promise((resolve) => {
    releaseCreation = resolve;
  });

  await page.route('**/api/rooms', async (route) => {
    if (route.request().method() === 'POST') {
      postCount += 1;
      await creationGate;
    }
    await route.continue();
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Your name').fill('Skeleton Walker');
  const createButton = page.locator('.home__create');

  // Two clicks in the same browser task are faster than React can rerender the
  // disabled state, so this proves the transport guard as well as the UI guard.
  await createButton.evaluate((button) => {
    button.click();
    button.click();
  });
  await waitUntil(() => postCount > 0, 'Room creation request');
  if (!(await createButton.isDisabled())) {
    throw new Error('Create remained enabled while creation was in flight.');
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (postCount !== 1) throw new Error(`Rapid double-click sent ${postCount} creation requests.`);
  releaseCreation();

  await page.getByRole('heading', { name: 'Lobby' }).waitFor();
  const roomCode = ((await page.locator('.seal').textContent()) ?? '').trim();
  const storedMembership = await page.evaluate((code) => {
    const raw = localStorage.getItem(`wikispeedrun.room.${code}.membership`);
    return raw === null ? null : JSON.parse(raw);
  }, roomCode);
  if (
    storedMembership === null ||
    typeof storedMembership.playerId !== 'string' ||
    typeof storedMembership.rejoinCredential !== 'string'
  ) {
    throw new Error('Lobby rendered before its Room membership was persisted.');
  }
  await page.getByRole('status').getByText('Room saved.', { exact: false }).waitFor();

  const players = page.locator('.lobby__player');
  if ((await players.count()) !== 1) throw new Error('Rendered lobby did not contain one player.');
  const host = players.first();
  if (
    !(await host.getByText('Skeleton Walker', { exact: false }).isVisible()) ||
    !(await host.getByText('Host', { exact: true }).isVisible())
  ) {
    throw new Error('Rendered one-player lobby did not identify its host.');
  }
  if (
    (await page.getByRole('button', { name: 'Start Game' }).count()) !== 0 ||
    (await page.getByRole('button', { name: /copy/i }).count()) !== 0 ||
    (await page.getByText('Choose your portrait', { exact: true }).count()) !== 0 ||
    (await page.getByText('Round settings', { exact: true }).count()) !== 0
  ) {
    throw new Error('Worker lobby exposed actions that are not implemented yet.');
  }

  console.log(
    JSON.stringify({
      phase: 'lobby',
      players: 1,
      host: true,
      roomCode,
      createPosts: postCount,
      membershipPersisted: true,
      surface: 'react',
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
}

async function launchInstalledBrowser() {
  if (process.env.BROWSER_PATH) {
    return chromium.launch({ executablePath: process.env.BROWSER_PATH, headless: true });
  }
  if (process.env.BROWSER_CHANNEL) {
    return chromium.launch({ channel: process.env.BROWSER_CHANNEL, headless: true });
  }

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const executablePath = candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!executablePath) {
    throw new Error(
      'No installed Chrome or Edge executable found. Set BROWSER_PATH or BROWSER_CHANNEL.',
    );
  }
  return chromium.launch({ executablePath, headless: true });
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not occur.`);
}
