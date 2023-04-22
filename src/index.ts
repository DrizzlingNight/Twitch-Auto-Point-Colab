import {Page} from "puppeteer";

require('dotenv').config();
import {usageOptions, cmdOptions} from "./cli-config";
import {followingStreamserList} from "./followingStreamserList"

const puppeteer = require("puppeteer");
const cmdArgs = require('command-line-args');
const cmdUsage = require('command-line-usage');
const fs = require('fs').promises;

const usage = cmdUsage(usageOptions);
const args = cmdArgs(cmdOptions);

const {game, timeout, verbose, help, proxy, file, kind} = args
const headless = !args['no-headless'];

// 自己新增 Start
var streamers = new Array;
const cheerio = require('cheerio');
const streamersUrl = 'https://www.twitch.tv/directory/following/live'; // 2021.09.14 修改取得頻道的網址（改成追隨中的live頻道）
const channelsQuery = 'a[data-a-target="preview-card-image-link"]'; // 2021.09.14 修改取得頻道的網址的Query
const claimPointQuery = 'button[aria-label="領取額外獎勵"]' // 領取忠誠點數額外獎勵按鈕Query
const pointNumberQuery = 'div[data-test-selector="balance-string"] span' // 忠誠點數數量Query

// 自己新增 End

if (help || !(game || file)) {
    console.log(usage);
    process.exit(0);
}

if (!process.env.TWITCH_CHROME_EXECUTABLE) {
    throw new Error('TWITCH_CHROME_EXECUTABLE not set')
}
if (!process.env.TWITCH_AUTH_TOKEN) {
    throw new Error('TWITCH_AUTH_TOKEN not set')
}

const directoryUrl = `https://www.twitch.tv/directory/game/${game}?tl=c2542d6d-cd10-4532-919b-3d19f30a768b`;

function formatLog(msg: string) {
    return `[${new Date().toUTCString()}] ${msg}`;
}

function info(msg: string) {
    console.info(formatLog(msg));
}

function vinfo(msg: string) {
    if (!verbose) return;
    console.debug(`[VERBOSE] ${formatLog(msg)}`);
}

function warn(msg: string) {
    console.warn(`[WARNING] ${formatLog(msg)}`);
}

async function initTwitch(page: Page) {
    info('Navigating to Twitch');
    await page.goto('https://twitch.tv', {
        waitUntil: ['networkidle2', 'domcontentloaded']
    });
    info('Configuring streaming settings');
    await page.evaluate(() => {
        localStorage.setItem('mature', 'true');
        localStorage.setItem('video-muted', '{"default":true}');
        localStorage.setItem('volume', '0.0');
        localStorage.setItem('video-quality', '{"default":"160p30"}');
    });
    info('Signing in using auth-token')
    await page.setCookie(
        {
            name: 'auth-token',
            value: process.env.TWITCH_AUTH_TOKEN
        }
    );
}

let buffering = 0;
let prevDuration = -1;

async function findRandomChannel(page: Page) {
    await page.goto(directoryUrl, {
        waitUntil: ['networkidle2', 'domcontentloaded']
    });
    const aHandle = await page.waitForSelector('a[data-a-target="preview-card-image-link"]', {timeout: 0});
    const channel = await page.evaluate(a => a.getAttribute('href'), aHandle);
    info('Channel found: navigating');
    await page.goto(`https://twitch.tv${channel}`, {
        waitUntil: ['networkidle2', 'domcontentloaded']
    });
}

// 自己新增 Start
async function getAllStreamer(page: Page) {
    info("=========================");
    await page.goto(streamersUrl, {
        waitUntil: ['networkidle2', 'domcontentloaded']
    });

    info('📡 Checking active streamers...');
    const jquery = await queryOnWebsite(page, channelsQuery);
  
    info('🧹 Listing online streamers...');
    for (var i = 0; i < jquery.length; i++) {
      streamers[i] = jquery[i].attribs.href;
      info(`streamers: ${streamers[i]}`)
    }
    info("=========================");
    return;
}

async function queryOnWebsite(page: Page, query: String) {
    let bodyHTML = await page.evaluate(() => document.body.innerHTML);
    let $ = cheerio.load(bodyHTML);
    const jquery = $(query);
    return jquery;
}

async function findFollowOnlineChannel(page: Page) {
    buffering = 0;
    prevDuration = -1;
    info('Finding online channel...');
    await getAllStreamer(page)
    return;

}

async function findOnlineChannelFromList(page: Page) {
    buffering = 0;
    prevDuration = -1;
    info('Finding online channel...');
    streamers = []
    for (var i = 0; i < followingStreamserList.length; i++ ) {
        const channel = followingStreamserList[i]
        vinfo(`Trying ${channel}`)
        await page.goto(`https://twitch.tv/${channel}`, {
            waitUntil: ['networkidle2', 'domcontentloaded']
        });
        const live = !(await isLive(page)).notLive;
        if (!live) {
            // do nothing
        } else {
            streamers.push( `/${channel}`)
            info(`/${channel} is online`);
        }
    }
    if (!streamers[0]) {
        info('No channels online! Trying again after the timeout');
    }
    return;
}

// 領取忠誠點數
async function checkClaimBtn(page: Page) {
    const claimButtons = (await page.$$(claimPointQuery));
    
    // const pointNumberTest = (await page.$$(pointNumberQuery));
    // for (const point of pointNumberTest) {
    //     info(`${page.mainFrame().url()} point get！ Now point: ${point}`); // 這段之後刪掉
    // }
    if (claimButtons.length > 0) {
        // const pointNumber = (await page.$$(pointNumberQuery));
        for (const claimButton of claimButtons) {
            await claimButton.click();
            // info(`${page.mainFrame().url()} point get！ Now point: ${pointNumber[0]}`); // 這段之後刪掉
        }
    }
}

async function myRunTimer(page: Page) {
    vinfo('myRunTimer function called')
    await checkClaimBtn(page);
    setTimeout(myRunTimer, 1000, page);
}

// 自己新增 End

let list: string[];

async function readList() {
    info(`Parsing list of channels: ${file}`);
    const read = await fs.readFile(file, {encoding: "utf-8"});
    list = read.split(/\r?\n/).filter((s: string) => s.length !== 0);
    info(`${list.length} channels found: ${list.join(', ')}`);
}

async function findChannelFromList(page: Page) {
    if (!list) await readList();
    for (let channel of list) {
        vinfo(`Trying ${channel}`)
        await page.goto(`https://twitch.tv/${channel}`, {
            waitUntil: ['networkidle2', 'domcontentloaded']
        });
        const live = !(await isLive(page)).notLive;
        vinfo(`Channel live: ${live}`);
        if (!live) vinfo('Channel offline, trying next channel');
        else {
            if (game) {
                const gameLink = await page.waitForSelector('a[data-a-target="stream-game-link"]', {timeout: 0});
                const href = await page.evaluate(a => a.getAttribute('href'), gameLink);
                const streamingGame = href.toLowerCase().endsWith(`/${game.toLowerCase()}`);
                vinfo(`Channel streaming the given game: ${streamingGame}`);
                if (!streamingGame) continue;
            }
            info('Online channel found!');
            return;
        }
    }
    info('No channels online! Trying again after the timeout');
}

async function findCOnlineChannel(page: Page) {
    buffering = 0;
    prevDuration = -1;
    info('Finding online channel...');

    if (file) await findChannelFromList(page);
    else await findRandomChannel(page);
}

async function checkInventory(inventory: Page) {
    await inventory.goto('https://twitch.tv/inventory', {
        waitUntil: ['networkidle2', 'domcontentloaded']
    });
    const claimButtons = (await inventory.$$('button[data-test-selector="DropsCampaignInProgressRewardPresentation-claim-button"]'));
    vinfo(`${claimButtons.length} claim buttons found${claimButtons.length > 0 ? '!' : '.'}`);
    for (const claimButton of claimButtons) {
        info('Reward found! Claiming!')
        await new Promise(resolve => setTimeout(resolve, 1000));
        await claimButton.click();
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function isLive(mainPage: Page) {
    const status = await mainPage.$$eval('a[status]', li => li.pop()?.getAttribute('status'));
    const videoDuration = await mainPage.$$eval('video', videos => (videos.pop() as HTMLVideoElement)?.currentTime);
    const raid = mainPage.url().includes('?referrer=raid');
    vinfo(`Current url: ${mainPage.url()}`);
    vinfo(`Channel status: ${status}`);
    vinfo(`Video duration: ${videoDuration}`);
    const notLive = status !== 'live' || videoDuration === 0;
    return {videoDuration, notLive, raid};
}

async function checkLiveStatus(mainPage: Page) {
    const {videoDuration, notLive, raid} = await isLive(mainPage);
    if (notLive || raid) {
        info('Channel offline');
        await findCOnlineChannel(mainPage);
        return;
    }
    if (videoDuration === prevDuration) {
        warn('Stream buffering or offline. If this persists a new channel will be found next cycle');
        if (++buffering > 1) {
            info('Channel offline or stream still buffering');
            await findCOnlineChannel(mainPage);
            return;
        }
    } else {
        buffering = 0;
    }
    prevDuration = videoDuration;
}

async function runTimer(mainPage: Page, inventory: Page) {
    vinfo('Timer function called')
    await checkInventory(inventory);
    await checkLiveStatus(mainPage);
    setTimeout(runTimer, timeout, mainPage, inventory);
}

// async function run() {
//     info('Starting application');
//     const browser = await puppeteer.launch({executablePath:"/usr/bin/chromium-browser", args:['--no-sandbox','--start-maximized', '--headless=new']});
//     const mainPage = (await browser.pages())[0];
//     await mainPage.setViewport({width: 1280, height: 720})
//     await initTwitch(mainPage);

//     const inventory = await browser.newPage();
//     await inventory.setViewport({width: 1280, height: 720})
//     await mainPage.bringToFront();

//     await findCOnlineChannel(mainPage);
//     setTimeout(runTimer, timeout, mainPage, inventory);
// }

// 自己新增 Start
async function run() {
    process.setMaxListeners(0); // 設置MaxListeners，0代表無限
    info('Starting application');
    const streamersBrowser = new Array
    const browser = await puppeteer.launch({executablePath:"/usr/bin/chromium-browser", args:['--no-sandbox','--start-maximized', '--headless=new']});
    const mainPage = (await browser.pages())[0];
    await mainPage.setViewport({width: 1280, height: 720})
    await initTwitch(mainPage);
    await mainPage.bringToFront();
    
    if (kind === '1'){
        await findFollowOnlineChannel(mainPage); // 從有追蹤的頁面裡找
    } else {
        await findOnlineChannelFromList(mainPage); // 從List裡找
    }
    
    // info("=========================");
    // info("now Watch https://www.twitch.tv/vanilla_shironeko");
    // await mainPage.goto(`https://www.twitch.tv/vanilla_shironeko`, {
    //     waitUntil: ['networkidle2', 'domcontentloaded']
    // });

    // await findFollowOnlineChannel(mainPage);

    const streamersPage = new Array
    const claimBtnArray = new Array


    info("=========================");
    for (var i = 0; i < streamers.length; i++) {
        streamersBrowser[i] = await puppeteer.launch({executablePath:"/usr/bin/chromium-browser", args:['--no-sandbox','--start-maximized', '--headless=new']});
        streamersPage[i] = (await streamersBrowser[i].pages())[0];
        await streamersPage[i].setViewport({width: 1280, height: 720})
        await initTwitch(streamersPage[i]);
        await streamersPage[i].bringToFront();
        const link = streamers[i]
        info(`now Watch ${link}`);
        await streamersPage[i].goto(`https://twitch.tv${link}`, {
            waitUntil: ['networkidle2', 'domcontentloaded']
        });

        // 設置領取忠誠點數按鈕
        setTimeout(myRunTimer, 1000, streamersPage[i])
        
    // info("=========================");
    // for (var i = 0; i < streamers.length; i++) {
    //     streamersPage[i] = await browser.newPage();
    //     await streamersPage[i].setViewport({width: 1280, height: 720})
    //     await initTwitch(streamersPage[i]);
    //     await streamersPage[i].bringToFront();
    //     const link = streamers[i]
    //     info(`now Watch ${link}`);
    //     await streamersPage[i].goto(`https://twitch.tv${link}`, {
    //         waitUntil: ['networkidle2', 'domcontentloaded']
    //     });
    // }
    // info("=========================");
    }
    info("=========================");

    setInterval(async ()=>{

        // 先把browser關掉
        info("Now close browser....");
        for (var i = 0; i < streamers.length; i++) {
            await streamersBrowser[i].close()
        }

        if (kind === '1'){
            await findFollowOnlineChannel(mainPage); // 從有追蹤的頁面裡找
        } else {
            await findOnlineChannelFromList(mainPage); // 從List裡找
        }

        info("=========================");
        for (var i = 0; i < streamers.length; i++) {
            streamersBrowser[i] = await puppeteer.launch({executablePath:"/usr/bin/chromium-browser", args:['--no-sandbox','--start-maximized', '--headless=new']});
            streamersPage[i] = (await streamersBrowser[i].pages())[0];
            await streamersPage[i].setViewport({width: 1280, height: 720})
            await initTwitch(streamersPage[i]);
            await streamersPage[i].bringToFront();
            const link = streamers[i]
            info(`now Watch ${link}`);
            await streamersPage[i].goto(`https://twitch.tv${link}`, {
                waitUntil: ['networkidle2', 'domcontentloaded']
            });

            // 設置領取忠誠點數按鈕
            setTimeout(myRunTimer, 1000, streamersPage[i])
        }
        info("=========================");
    },1800000)
}
// 自己新增 End

run().then(() => {
    // Nothing
});