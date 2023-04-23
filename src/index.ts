import {Page} from "puppeteer";

require('dotenv').config();
import {usageOptions, cmdOptions} from "./cli-config";
import {followingStreamserList} from "./followingStreamserList"

const puppeteer = require("puppeteer");
const cmdArgs = require('command-line-args');
const cmdUsage = require('command-line-usage');
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone') // dependent on utc plugin
const fs = require('fs').promises;

dayjs.extend(utc)
dayjs.extend(timezone)

const usage = cmdUsage(usageOptions);
const args = cmdArgs(cmdOptions);

const {game, timeout, verbose, help, proxy, file, kind} = args
const headless = !args['no-headless'];

// 自己新增 Start
var streamers = new Array;
const cheerio = require('cheerio');
const streamersUrl = 'https://www.twitch.tv/directory/following/live'; // 2021.09.14 修改取得頻道的網址（改成追隨中的live頻道）
const channelsQuery = 'a[data-a-target="preview-card-image-link"]'; // 2021.09.14 修改取得頻道的網址的Query
const claimPointQuery = 'button.kIlsPe[aria-label="領取額外獎勵"]' // 領取忠誠點數額外獎勵按鈕Query
const pointNumberQuery = 'div[data-test-selector="balance-string"] span' // 忠誠點數數量Query
const streamOfflineQuery = 'a[status="offline"]'; // 判斷頻道是否離線Query

// 自己新增 End

// if (help || !(game || file)) {
//     console.log(usage);
//     process.exit(0);
// }

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
    info('📱 Navigating to Twitch');
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

let buffering = 0;
let prevDuration = -1;

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
    info('===從所有追隨的主播裡尋找===');
    info('Finding online channel...');
    await getAllStreamer(page)
    return;

}

async function findOnlineChannelFromList(page: Page) {
    buffering = 0;
    prevDuration = -1;
    info('===從自定義的主播清單裡尋找===');
    info('Finding online channel...');
    info("=========================");
    info('🧹 Listing online streamers...');
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
    info("=========================");
    if (!streamers[0]) {
        info('No channels online! Trying again after the timeout');
    }
    return;
}

// 獲取忠誠點數的數字
async function getPointNumber(page: Page, pointNumberQuery: string): Promise<string> {
    try {
        const pointNumber = await page.$eval(pointNumberQuery, (element) => {
            return element.textContent ? element.textContent: '0';
        });
        return pointNumber;
    } catch (error) {
      console.error('Error during getting point number');
      return '0';
    }
}

async function loopWatch(streamer: any) {
    info(`👁‍🗨 now Watch ${streamer.link}, 🕒 Start: ${streamer.startTime}`);
    await streamer.page.goto(`https://twitch.tv${streamer.link}`, {
        waitUntil: ['networkidle2', 'domcontentloaded']
    });
    streamer.startPoint = await getPointNumber(streamer.page, pointNumberQuery);
    while (streamer.isRun) {
        await claimPoint(streamer);
    }
}

async function claimPoint(streamer: any) {
    if (streamer.isRun === false) return;
    const beforeClaim = streamer.claim
    const claimBtn = await queryOnWebsite(streamer.page, claimPointQuery);
    if (claimBtn.length > 0) {
        try {
            await streamer.page.evaluate((claimPointQuery:string) => {
                try {
                  const button = document.querySelector(claimPointQuery);
                  if (button) {
                    (button as HTMLElement).click();
                  } else {
                    console.error('claim button not found');
                  }
                } catch (error) {
                  console.error('Error during claim button click:', error);
                }
            },claimPointQuery);
            // await streamer.page.reload({waitUntil: ['networkidle2', 'domcontentloaded']})
            await streamer.page.waitForTimeout(1000);
            const claimBtnCheck = await queryOnWebsite(streamer.page, claimPointQuery);
            if (claimBtnCheck.length === 0) {
                streamer.claim++;
            }
        } catch (error) {
            console.error('Error during page.evaluate():', error);
        }
    }
    const afterClamim = streamer.claim
    if (beforeClaim !== afterClamim) {
        // console.log(
        //     `✨ [${streamer.link}] (claim ${streamer.claim} times)`
        // );
    }
    
    await streamer.page.waitForTimeout(1000);
}

async function state(streamer: any) {
    // ...
    // ...
    const now = dayjs(); // 獲取當前時間
    const endTime = dayjs().format('YYYY/MM/DD HH:mm:ss');
    const durationInMinutes = now.diff(streamer.startTime, 'minute') // 計算距離開始時間的分鐘數
    const point = await getPointNumber(streamer.page, pointNumberQuery)
    console.log(
        `✨ [${streamer.link}] 🕒 End: ${endTime} Duration: ${durationInMinutes} minutes ; Point: ${streamer.startPoint} ~ ${point} (claim ${streamer.claim} times)`
    );
}

async function watchStreamers(mainPage:any, streamersBrowser:any) {
    if (kind === '1') {
      await findFollowOnlineChannel(mainPage); // 從有追蹤的頁面裡找
    } else {
      await findOnlineChannelFromList(mainPage); // 從List裡找
    }
    for (var i = 0; i < streamers.length; i++) {
        streamersBrowser[i] = {
            browser: null,
            page: null,
            link: null,
            startTime: null,
            startPoint: null,
            isRun: null,
            claim: null,
        }

        streamersBrowser[i].browser = await puppeteer.launch({executablePath: process.env.TWITCH_CHROME_EXECUTABLE, args:['--no-sandbox']});
        streamersBrowser[i].page = (await streamersBrowser[i].browser.pages())[0];

        await streamersBrowser[i].page.setViewport({width: 1280, height: 720})
        streamersBrowser[i].page.setDefaultNavigationTimeout(1200000); // 設置1200秒超時
        await initTwitch(streamersBrowser[i].page);
        await streamersBrowser[i].page.bringToFront();
        
        streamersBrowser[i].link = streamers[i]
        streamersBrowser[i].startTime = dayjs().format('YYYY/MM/DD HH:mm:ss')
        streamersBrowser[i].isRun = true;
        streamersBrowser[i].claim = 0;

        loopWatch(streamersBrowser[i]);
  }
}
  
async function killStream(streamersBrowser:any) {
    info("🔧  Now close browser....");
    for (const streamer of streamersBrowser) {
        await state(streamer);
        streamer.isRun = false;
        await streamer.browser.close();
    }
    info("=========================");
}

async function run() {
    dayjs.tz.setDefault('Asia/Taipei') // 設置dayjs時區
    process.setMaxListeners(0); // 設置MaxListeners，0代表無限
    info('Starting application');
    let streamersBrowser = new Array();
    const browser = await puppeteer.launch({
        executablePath: process.env.TWITCH_CHROME_EXECUTABLE,
        args: ['--no-sandbox'],
    });
    const mainPage = (await browser.pages())[0];
    await mainPage.setViewport({ width: 1280, height: 720 });
    await initTwitch(mainPage);
    await mainPage.bringToFront();

    let reload = dayjs().add(30, 'minute'); // 每30分鐘刷新一次

    // 每隔一段時間檢查是否需要重新執行
    setInterval(async () => {
        if (dayjs().isAfter(reload)) {
            await killStream(streamersBrowser);
            streamersBrowser = new Array();
            await watchStreamers(mainPage, streamersBrowser);
            info("=========================");
            reload = dayjs().add(30, 'minute');
        }
    }, 5 * 60 * 1000); // 每5分鐘檢查一次

    // 首次執行
    await watchStreamers(mainPage, streamersBrowser);
    info("=========================");
}

// 自己新增 End

run().then(() => {
    // Nothing
});