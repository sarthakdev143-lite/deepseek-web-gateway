// shared-browser-pool.js — Single Chromium profile shared across gateway sessions
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const logger = require('./logger');

let context = null;
let refCount = 0;
let launchPromise = null;

async function launchContext() {
  const sessionDir = path.resolve(config.SESSION_DIR);
  const cookiesFile = path.join(sessionDir, 'cookies.json');

  let cookies = [];
  if (fs.existsSync(cookiesFile)) {
    try {
      cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
      logger.success('Loaded saved cookies — attempting silent login...');
    } catch (e) {
      logger.warn('Could not load cookies: ' + e.message);
    }
  }

  const ctx = await chromium.launchPersistentContext(sessionDir, {
    headless: config.HEADLESS,
    viewport: null,
    userAgent: [
      'Mozilla/5.0 (X11; Linux x86_64)',
      'AppleWebKit/537.36 (KHTML, like Gecko)',
      'Chrome/124.0.0.0 Safari/537.36',
    ].join(' '),
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--disable-default-apps',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  if (cookies.length > 0) {
    await ctx.addCookies(cookies);
    logger.dim(`Injected ${cookies.length} cookies`);
  }

  return ctx;
}

async function acquire() {
  if (context) {
    refCount++;
    logger.dim(`Reusing shared browser session (refs: ${refCount})`);
    return context;
  }

  if (!launchPromise) {
    launchPromise = (async () => {
      logger.info('Launching browser with persistent session...');
      context = await launchContext();
      refCount = 1;
      launchPromise = null;
      return context;
    })();
  }

  try {
    return await launchPromise;
  } catch (err) {
    launchPromise = null;
    context = null;
    refCount = 0;
    throw err;
  }
}

async function release() {
  if (refCount <= 0) return;
  refCount--;
  logger.dim(`Released shared browser session (refs: ${refCount})`);
  if (refCount === 0 && context) {
    try {
      await context.close();
    } catch (err) {
      logger.warn('Error closing shared browser: ' + err.message);
    }
    context = null;
  }
}

function getRefCount() {
  return refCount;
}

module.exports = { acquire, release, getRefCount, getContext: () => context };
