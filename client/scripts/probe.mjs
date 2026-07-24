import { accessSync, constants } from 'node:fs';
import { chromium } from 'playwright-core';
import { configureLobby } from './probeLobby.mjs';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const browser = await launchInstalledBrowser();

try {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  await stubArticleHtml(hostContext);
  await stubArticleHtml(guestContext);
  const page = await hostContext.newPage();
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
  const players = page.locator('.lobby__player');
  if ((await players.count()) !== 1) throw new Error('Rendered lobby did not contain one player.');
  const host = players.first();
  if (
    !(await host.getByText('Skeleton Walker', { exact: false }).isVisible()) ||
    !(await host.getByText('Host', { exact: true }).isVisible())
  ) {
    throw new Error('Rendered one-player lobby did not identify its host.');
  }
  if ((await page.getByRole('button', { name: 'Start Game' }).count()) !== 1) {
    throw new Error('Worker lobby did not expose its implemented Start action.');
  }
  if ((await page.getByRole('button', { name: 'Copy invite link' }).count()) !== 1) {
    throw new Error('Worker lobby did not expose its invite path.');
  }

  const guestPage = await guestContext.newPage();
  let guestSocket;
  await guestPage.routeWebSocket('**/websocket', (socket) => {
    guestSocket = socket;
    socket.connectToServer();
  });
  await guestPage.goto(`${baseUrl}/?code=${roomCode}`, { waitUntil: 'domcontentloaded' });
  await guestPage.getByLabel('Your name').fill('Invited Guest');
  await guestPage.getByRole('button', { name: 'Join Room' }).click();
  await guestPage.getByRole('heading', { name: 'Lobby' }).waitFor();
  if (new URL(guestPage.url()).searchParams.has('code')) {
    throw new Error('Guest invite query remained after joining.');
  }
  await waitUntil(
    async () => (await page.locator('.lobby__player').count()) === 2,
    'host join sync',
  );
  await waitUntil(
    async () => (await guestPage.locator('.lobby__player').count()) === 2,
    'guest join sync',
  );

  const guestMembership = await guestPage.evaluate((code) => {
    const raw = localStorage.getItem(`wikispeedrun.room.${code}.membership`);
    return raw === null ? null : JSON.parse(raw);
  }, roomCode);
  if (
    guestMembership === null ||
    typeof guestMembership.playerId !== 'string' ||
    guestMembership.playerId === storedMembership.playerId
  ) {
    throw new Error('Invited browser did not receive a distinct persisted Player identity.');
  }

  if (!guestSocket) throw new Error('Guest WebSocket was not observed by the browser probe.');
  await guestSocket.close({ code: 1012, reason: 'Smoke network drop.' });
  await guestPage.getByRole('status').getByText('Reconnecting…', { exact: true }).waitFor();
  await guestPage
    .getByRole('status')
    .getByText('Reconnecting…', { exact: true })
    .waitFor({ state: 'detached' });
  await waitUntil(
    async () => (await guestPage.locator('.lobby__player').count()) === 2,
    'guest reconnect sync',
  );
  const guestMembershipAfterReconnect = await guestPage.evaluate((code) => {
    const raw = localStorage.getItem(`wikispeedrun.room.${code}.membership`);
    return raw === null ? null : JSON.parse(raw);
  }, roomCode);
  const identitiesPreserved =
    guestMembershipAfterReconnect?.playerId === guestMembership.playerId &&
    guestMembershipAfterReconnect?.rejoinCredential === guestMembership.rejoinCredential;
  if (!identitiesPreserved) {
    throw new Error('Guest reconnect changed the Room Membership identity.');
  }

  if ((await guestPage.getByRole('button', { name: 'Start Game' }).count()) !== 0) {
    throw new Error('Invited non-host browser exposed the host Start action.');
  }
  await guestPage.getByText('Waiting for the host to start…', { exact: true }).waitFor();

  const lobbyActions = await configureLobby(page, guestPage);

  const hostPreparing = page.getByRole('heading', { name: 'Choosing articles' }).waitFor();
  const guestPreparing = guestPage.getByRole('heading', { name: 'Choosing articles' }).waitFor();
  await page.getByRole('button', { name: 'Start Game' }).click();
  await Promise.all([hostPreparing, guestPreparing]);
  const prepared = true;

  await Promise.all([
    page.locator('.countdown__number').waitFor(),
    guestPage.locator('.countdown__number').waitFor(),
  ]);
  await Promise.all([
    page.locator('.race__route').waitFor({ timeout: 20_000 }),
    guestPage.locator('.race__route').waitFor({ timeout: 20_000 }),
  ]);
  const hostPair = await page.locator('.race__route-title').allTextContents();
  const guestPair = await guestPage.locator('.race__route-title').allTextContents();
  if (
    hostPair.length !== 2 ||
    guestPair.length !== 2 ||
    hostPair[0] !== guestPair[0] ||
    hostPair[1] !== guestPair[1]
  ) {
    throw new Error('Browsers entered racing with different article pairs.');
  }
  if (
    (await page.getByRole('button', { name: 'Give Up' }).count()) !== 1 ||
    (await guestPage.getByRole('button', { name: 'Give Up' }).count()) !== 1
  ) {
    throw new Error('Worker racing did not expose its authoritative actions.');
  }

  const goalLink = page.getByRole('link', { name: hostPair[1], exact: true });
  await goalLink.waitFor();
  const hostFinished = page.getByRole('heading', { name: 'You reached the goal!' }).waitFor();
  await goalLink.click();
  await hostFinished;

  const hostResults = page.getByRole('heading', { name: 'Enlightenment Achieved' }).waitFor();
  const guestResults = guestPage.getByRole('heading', { name: 'Enlightenment Achieved' }).waitFor();
  await guestPage.getByRole('button', { name: 'Give Up' }).click();
  await Promise.all([hostResults, guestResults]);
  const hostRows = await page.locator('.results__table tbody tr').allTextContents();
  const guestRows = await guestPage.locator('.results__table tbody tr').allTextContents();
  if (JSON.stringify(hostRows) !== JSON.stringify(guestRows)) {
    throw new Error('Browsers observed different authoritative results.');
  }
  const scores = await page.locator('.results__fortune').allTextContents();
  const roundPoints = await page.locator('.results__points').allTextContents();
  if (scores.join(',') !== '5,0' || roundPoints.join(',') !== '+5,0') {
    throw new Error('Worker results did not preserve expected finish and give-up scoring.');
  }

  if ((await guestPage.getByRole('button', { name: 'Play Again' }).count()) !== 0) {
    throw new Error('Worker results exposed host replay authority to the guest.');
  }
  const hostLobbyAgain = page.getByRole('heading', { name: 'Lobby' }).waitFor();
  const guestLobbyAgain = guestPage.getByRole('heading', { name: 'Lobby' }).waitFor();
  await page.getByRole('button', { name: 'Play Again' }).click();
  await Promise.all([hostLobbyAgain, guestLobbyAgain]);
  const playedAgain = true;

  const replacementPage = await guestContext.newPage();
  const replacementLobby = replacementPage.getByRole('heading', { name: 'Lobby' }).waitFor();
  const oldConnectionReplaced = guestPage
    .getByText('This Room Membership was opened in another tab.', { exact: true })
    .waitFor();
  await replacementPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await Promise.all([replacementLobby, oldConnectionReplaced]);
  await guestPage.getByRole('heading', { name: 'Wiki Speedrun' }).waitFor();
  const replacementMembership = await replacementPage.evaluate((code) => {
    const raw = localStorage.getItem(`wikispeedrun.room.${code}.membership`);
    return raw === null ? null : JSON.parse(raw);
  }, roomCode);
  if (
    replacementMembership?.playerId !== guestMembership.playerId ||
    replacementMembership?.rejoinCredential !== guestMembership.rejoinCredential
  ) {
    throw new Error('Replacement tab did not retain the same Room Membership.');
  }
  await waitUntil(
    async () => (await page.locator('.lobby__player').count()) === 2,
    'replacement tab host sync',
  );
  const replaced = true;

  const replacementKicked = replacementPage
    .getByText('The host removed you from the Room.', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Remove Invited Guest' }).click();
  await replacementKicked;
  await replacementPage.getByRole('heading', { name: 'Wiki Speedrun' }).waitFor();
  const removedMembership = await replacementPage.evaluate(
    (code) => localStorage.getItem(`wikispeedrun.room.${code}.membership`),
    roomCode,
  );
  if (removedMembership !== null) {
    throw new Error('Kicked browser retained its Room Membership credential.');
  }
  await waitUntil(
    async () => (await page.locator('.lobby__player').count()) === 1,
    'host kick sync',
  );
  const kicked = true;

  console.log(
    JSON.stringify({
      phase: 'lobby',
      players: 1,
      host: true,
      roomCode,
      createPosts: postCount,
      membershipPersisted: true,
      joined: true,
      reconnected: true,
      identitiesPreserved,
      lobbyActions,
      prepared,
      alarmTransitioned: true,
      resultRows: hostRows,
      scores,
      roundPoints,
      playedAgain,
      replaced,
      kicked,
      startArticle: hostPair[0],
      goalArticle: hostPair[1],
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

async function stubArticleHtml(context) {
  await context.route('https://en.wikipedia.org/api/rest_v1/page/html/**', async (route) => {
    const title = decodeURIComponent(route.request().url().split('/').at(-1) ?? '').replaceAll(
      '_',
      ' ',
    );
    const goal =
      (
        await route
          .request()
          .frame()
          .locator('.race__route-title--goal')
          .textContent({ timeout: 2_000 })
      )?.trim() ?? '';
    if (!goal) throw new Error('Article stub could not observe the rendered goal.');
    const goalHref = encodeURIComponent(goal.replaceAll(' ', '_'));
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<article><p>Stubbed article for ${escapeHtml(title)}. <a href="./${goalHref}">${escapeHtml(goal)}</a></p></article>`,
    });
  });
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not occur.`);
}
